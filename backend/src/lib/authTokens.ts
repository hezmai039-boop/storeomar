import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";

/**
 * Single-use, expiring links for email verification and password reset.
 *
 * A password-reset token IS a password: anyone holding it can take over the
 * account. So this module treats it like one —
 *
 *   - the database stores only sha256(token), never the token itself, so a
 *     leaked dump (or a careless `SELECT * FROM auth_tokens`) yields nothing
 *     redeemable;
 *   - redemption is a single conditional UPDATE, not a read-then-write;
 *   - issuing a new token of a purpose kills the user's older unused ones.
 *
 * The plaintext exists in exactly two places: the return value of
 * issueToken(), and the email body built from it. It is never logged and
 * never put in a response body.
 */

export type TokenPurpose = "email_verify" | "password_reset";

/**
 * Verification is long because the mail may sit unread overnight and
 * re-signing-up is not an option (the account already exists). Reset is
 * short because it is the higher-value credential of the two: a forwarded
 * or shoulder-surfed reset link is full account takeover, and 60 minutes is
 * still comfortably longer than anyone actually takes to click it.
 */
export const TOKEN_TTL_MINUTES: Record<TokenPurpose, number> = {
  email_verify: 24 * 60,
  password_reset: 60,
};

/**
 * 32 bytes of CSPRNG output — 256 bits, so guessing is not a threat model
 * even with the endpoint unrate-limited. base64url because the value is
 * carried in a query string: base64 would need escaping and hex would make
 * the link half again as long for no extra entropy.
 */
function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Exported for tests, and used by both issue and consume so the two can
 * never drift apart. A plain unsalted sha256 is correct HERE (unlike for
 * passwords): the input is already 256 bits of uniform randomness, so there
 * is no dictionary to build and nothing for a work factor to slow down.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The WHERE clause that makes redemption safe, extracted so it is testable
 * without a database and impossible to reconstruct slightly differently at
 * a second call site.
 *
 * Every condition here is load-bearing:
 *   - `usedAt: null`     — a redeemed link must stop working immediately.
 *   - `expiresAt > now`  — an old link in an inbox must stop working too.
 * Dropping either turns an expired/spent reset mail back into a permanent
 * key to the account.
 */
export function consumeTokenWhere(tokenHash: string, purpose: string, now: Date): Prisma.AuthTokenWhereInput {
  return { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } };
}

/**
 * Mints a token and returns it in PLAINTEXT — the only time it is ever
 * available. Caller must put it straight into an email and drop it.
 */
export async function issueToken(userId: string, purpose: TokenPurpose, ttlMinutes: number): Promise<string> {
  const token = generateToken();
  const now = new Date();

  // Invalidate the user's earlier unused tokens of this purpose first.
  // Without this, clicking "resend verification" three times leaves three
  // simultaneously-valid links, and "forgot password" twice means the mail
  // the user ignored (possibly the attacker-triggered one) still works.
  // Only the newest link should ever open the door.
  await prisma.authToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: now },
  });

  await prisma.authToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    },
  });

  return token;
}

/**
 * Redeems a token, returning the user it belongs to — or null for anything
 * unusable (wrong token, wrong purpose, already used, expired). Callers get
 * one undifferentiated null on purpose: telling a caller *why* a token
 * failed tells an attacker probing tokens the same thing.
 *
 * The check and the mark are ONE conditional updateMany, and success is
 * `count === 1`. A `findFirst` followed by an `update` would let two
 * concurrent redemptions of the same link both pass the read before either
 * writes — for password reset that is two parties setting the password of
 * one account from one leaked link. Postgres serializes the matching row's
 * update, so exactly one of the racers can ever see count === 1.
 */
export async function consumeToken(token: string, purpose: string): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const claimed = await prisma.authToken.updateMany({
    where: consumeTokenWhere(tokenHash, purpose, now),
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return null;

  // Safe to read after the claim: we hold the row, and tokenHash is unique.
  const row = await prisma.authToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  return row ? { userId: row.userId } : null;
}
