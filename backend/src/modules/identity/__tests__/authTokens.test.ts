import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeTokenWhere, hashToken, TOKEN_TTL_MINUTES } from "../../../lib/authTokens";

// A password-reset token is a password. The properties below are the whole
// point of lib/authTokens.ts, and each of them is testable without a
// database — the parts that need one (the actual UPDATE) are covered by
// asserting the query shape instead, since the shape IS the security
// control: drop a condition from it and expired or already-spent links
// silently start working again.

test("what is stored is a hash, never the token itself", () => {
  const token = "cGxhaW50ZXh0LXRva2Vu";
  const stored = hashToken(token);
  assert.notEqual(stored, token);
  // sha256 hex — a stored value that still contained the token would have
  // to be longer or differently shaped than this.
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!stored.includes(token));
});

test("hashing is deterministic, so issue and consume agree", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
});

test("different tokens hash differently — one link never opens another account", () => {
  assert.notEqual(hashToken("abc"), hashToken("abd"));
});

test("consume only matches an UNUSED token — a redeemed link must stop working", () => {
  const where = consumeTokenWhere(hashToken("t"), "password_reset", new Date());
  // Not `undefined` and not omitted: `usedAt: null` is what makes redemption
  // single-use. Without it a forwarded reset mail stays a working key.
  assert.equal(where.usedAt, null);
});

test("consume is bounded by expiry, in the future direction", () => {
  const now = new Date("2026-07-29T10:00:00.000Z");
  const where = consumeTokenWhere(hashToken("t"), "email_verify", now);
  const expiresAt = where.expiresAt as { gt: Date };
  // `gt: now` (not `lt`) — the token must expire in the future to still be
  // valid. Inverting this comparison would accept ONLY dead tokens.
  assert.ok(expiresAt && expiresAt.gt instanceof Date);
  assert.equal(expiresAt.gt.getTime(), now.getTime());
});

test("consume is scoped to a purpose — a verification link cannot reset a password", () => {
  const where = consumeTokenWhere(hashToken("t"), "email_verify", new Date());
  assert.equal(where.purpose, "email_verify");
});

test("consume looks up by hash, so the plaintext never reaches the database", () => {
  const token = "plaintext-token-value";
  const where = consumeTokenWhere(hashToken(token), "password_reset", new Date());
  assert.equal(where.tokenHash, hashToken(token));
  assert.notEqual(where.tokenHash, token);
});

test("reset TTL is much shorter than verification TTL", () => {
  // A reset link is full account takeover; a verification link is not. The
  // reset window must stay the tighter of the two.
  assert.equal(TOKEN_TTL_MINUTES.password_reset, 60);
  assert.equal(TOKEN_TTL_MINUTES.email_verify, 24 * 60);
  assert.ok(TOKEN_TTL_MINUTES.password_reset < TOKEN_TTL_MINUTES.email_verify);
});
