import crypto from "node:crypto";
import { env } from "../config/env";

// AES-256-GCM for channel_accounts.credentials_encrypted and
// integrations.credentials_encrypted (docs/01-database-design.md §3, §7).
// The key comes from ENCRYPTION_KEY (32 bytes) — never stored alongside the
// ciphertext, never logged, never returned by any API response.

const ALGO = "aes-256-gcm";

function keyBuffer(): Buffer {
  const key = Buffer.from(env.encryptionKey, "utf8");
  if (key.length !== 32) {
    // Deterministic stretch so a non-32-byte dev secret still boots locally;
    // production must set a real 32-byte ENCRYPTION_KEY.
    return crypto.createHash("sha256").update(key).digest();
  }
  return key;
}

export function encryptSecret(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuffer(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptSecret(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, keyBuffer(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
