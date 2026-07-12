import crypto from "node:crypto";

/**
 * Constant-time string comparison for webhook HMAC signatures. Plain `===`
 * leaks a timing side-channel (bails on the first differing byte);
 * `crypto.timingSafeEqual` needs equal-length buffers or it throws, so the
 * length check has to happen first and itself must not short-circuit
 * before a same-length real comparison would.
 */
export function timingSafeStringEqual(a: string, b: string, encoding: BufferEncoding = "hex"): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, encoding), Buffer.from(b, encoding));
}
