import crypto from "node:crypto";

// Meta (WhatsApp Cloud API / Instagram Messaging / Messenger) all sign
// webhooks the same way: header `X-Hub-Signature-256: sha256=<hmac>` over
// the raw request body, keyed by the app secret. Shared by three adapters.
export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}
