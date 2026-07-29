// S3-compatible object storage over plain `fetch`, with request signing done
// here in ~60 lines of node:crypto.
//
// No SDK on purpose, for the same reason src/lib/llm.ts talks to Anthropic
// directly and src/lib/email/resend.ts talks to Resend directly: the whole
// integration is three HTTP verbs against one host. `@aws-sdk/client-s3`
// would add ~15MB and a few dozen transitive packages to the deploy image,
// plus a version to keep current, to save one function — and it would pull
// AWS-shaped configuration conventions into a codebase that must also point
// at Cloudflare R2.
//
// Endpoint-configurable + path-style addressing (`/<bucket>/<key>`) is what
// makes one adapter serve both:
//   AWS S3       STORAGE_ENDPOINT=https://s3.eu-central-1.amazonaws.com
//                STORAGE_REGION=eu-central-1
//   Cloudflare R2 STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
//                STORAGE_REGION=auto
// R2 is the recommended target for this platform: S3-compatible, no egress
// fees, and the documents here are small and read rarely.

import crypto from "node:crypto";
import { StorageProvider } from "./types";

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

function config(): S3Config {
  // Read at call time, not module load: the registry imports this module on
  // every boot regardless of STORAGE_PROVIDER, and throwing at import time
  // would take the whole process down just because credentials for an unused
  // provider are absent.
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;
  const accessKey = process.env.STORAGE_ACCESS_KEY;
  const secretKey = process.env.STORAGE_SECRET_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error(
      "STORAGE_PROVIDER=s3 requires STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY"
    );
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKey,
    secretKey,
    // "auto" is R2's required value and is also accepted by the signature
    // check there; AWS S3 must be given its real region or every request
    // fails with SignatureDoesNotMatch.
    region: process.env.STORAGE_REGION || "auto",
  };
}

/**
 * RFC 3986 encoding, which is what SigV4's canonical URI requires and what
 * encodeURIComponent does NOT do: it leaves `!'()*` unescaped. A filename
 * containing one of those would be signed differently than S3 canonicalizes
 * it, and the upload would fail with SignatureDoesNotMatch — a bug that only
 * ever shows up on the one customer file with a bracket in its name.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Builds the signed request for one object operation.
 *
 * SigV4 in one place: the client and the server independently build the same
 * "canonical request" string, hash it, and compare HMACs derived from the
 * secret. Anything that differs by a byte — an unencoded character, an
 * unsorted header, a header sent but not signed — fails identically with
 * SignatureDoesNotMatch, so all of that construction lives here rather than
 * being spread across the three verbs.
 */
function signedRequest(
  cfg: S3Config,
  method: "PUT" | "GET" | "DELETE",
  key: string,
  body: Buffer | undefined,
  contentType?: string
): { url: string; headers: Record<string, string> } {
  const host = new URL(cfg.endpoint).host;
  // Path-style: the bucket is a path segment, not a subdomain, so a custom
  // endpoint (R2, MinIO) needs no DNS games. Each key segment is encoded
  // separately so the "/" hierarchy survives.
  const canonicalUri = `/${encodeRfc3986(cfg.bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? "");

  // Sorted by header name, because the canonical request demands it.
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, dateStamp), cfg.region), SERVICE), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    url: `${cfg.endpoint}${canonicalUri}`,
    headers: {
      ...headers,
      authorization: `${ALGORITHM} Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export const s3StorageProvider: StorageProvider = {
  key: "s3",

  async put({ key, body, contentType }): Promise<{ url: string }> {
    const cfg = config();
    const req = signedRequest(cfg, "PUT", key, body, contentType);
    const resp = await fetch(req.url, { method: "PUT", headers: req.headers, body: new Uint8Array(body) });
    if (!resp.ok) {
      // The body is included because S3/R2 failures are almost always
      // configuration (wrong region in the signature, bucket in another
      // account, key lacking PutObject) and the status alone sends an
      // operator hunting. The signature and secret never appear here.
      throw new Error(`Storage PUT failed: ${resp.status} ${await resp.text()}`);
    }
    return { url: req.url };
  },

  async get(key): Promise<Buffer | null> {
    const cfg = config();
    const req = signedRequest(cfg, "GET", key, undefined);
    const resp = await fetch(req.url, { method: "GET", headers: req.headers });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Storage GET failed: ${resp.status} ${await resp.text()}`);
    return Buffer.from(await resp.arrayBuffer());
  },

  async delete(key): Promise<void> {
    const cfg = config();
    const req = signedRequest(cfg, "DELETE", key, undefined);
    const resp = await fetch(req.url, { method: "DELETE", headers: req.headers });
    // S3 answers 204 for both "deleted" and "was never there"; 404 is
    // included anyway because some S3-compatible servers return it, and the
    // interface promises an idempotent delete either way.
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Storage DELETE failed: ${resp.status} ${await resp.text()}`);
    }
  },
};
