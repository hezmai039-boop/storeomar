import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyMetaSignature } from "../adapters/metaSignature";

// Why this file exists: a merchant can connect WhatsApp in two ways, and the
// difference is invisible from the sending side but decisive on the
// receiving side.
//
//   shared app — the merchant shares their WABA with our Business. The
//                webhook subscription lives on OUR app, so Meta signs with
//                OUR app secret (the env var).
//
//   own app    — the merchant builds their own Meta app and points its
//                webhook at us. Meta signs with THEIR app secret.
//
// Sending works identically in both: it needs only a phone number id and a
// token. That is exactly what makes the second case dangerous to reason
// about — the merchant pastes credentials, sends a test message, sees it
// arrive, and concludes the integration is done. Then every inbound message
// is silently rejected, because the HMAC was computed with a key we do not
// have.
//
// The tests below pin that asymmetry down so nobody "simplifies" the
// per-account secret away later.

const BODY = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" } } }] }] }));

function sign(body: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

const OUR_APP_SECRET = "our-platform-app-secret";
const MERCHANT_APP_SECRET = "a-merchant-owned-app-secret";

test("a merchant's own app secret produces a signature our env secret can never verify", () => {
  // This is the entire bug in one assertion. Before the per-account secret
  // existed, this returned false for every merchant running their own Meta
  // app — meaning they could send but never receive, with a 401 and no
  // explanation of why.
  const signature = sign(BODY, MERCHANT_APP_SECRET);
  assert.equal(verifyMetaSignature(BODY, signature, OUR_APP_SECRET), false);
  assert.equal(verifyMetaSignature(BODY, signature, MERCHANT_APP_SECRET), true);
});

test("the shared-app topology still verifies against the env secret", () => {
  // The fallback path. Every account connected before per-account secrets
  // existed carries no `appSecret` in its blob and must keep working
  // unchanged — a migration that silently stops delivering messages is worse
  // than the bug it fixes.
  const signature = sign(BODY, OUR_APP_SECRET);
  assert.equal(verifyMetaSignature(BODY, signature, OUR_APP_SECRET), true);
});

test("an empty app secret fails closed rather than waving the request through", () => {
  // The unconfigured case. `WHATSAPP_APP_SECRET` defaults to "" when unset,
  // and an implementation that read "no secret configured" as "skip
  // verification" would turn a missing env var into an open webhook that
  // anyone could post fabricated customer messages to.
  const signature = sign(BODY, MERCHANT_APP_SECRET);
  assert.equal(verifyMetaSignature(BODY, signature, ""), false);
  // ...including when the attacker also knows the secret is empty.
  assert.equal(verifyMetaSignature(BODY, sign(BODY, ""), OUR_APP_SECRET), false);
});

test("a tampered body fails even with the right secret", () => {
  // The signature covers the RAW body, which is why the route is mounted
  // with express.raw(). If anything re-serialized the JSON before this
  // check, a byte-level difference would break every delivery.
  const signature = sign(BODY, MERCHANT_APP_SECRET);
  const tampered = Buffer.from(BODY.toString("utf8").replace("123", "999"));
  assert.equal(verifyMetaSignature(tampered, signature, MERCHANT_APP_SECRET), false);
});

test("a missing or malformed signature header is rejected, not skipped", () => {
  assert.equal(verifyMetaSignature(BODY, undefined, MERCHANT_APP_SECRET), false);
  assert.equal(verifyMetaSignature(BODY, "", MERCHANT_APP_SECRET), false);
  // No `sha256=` prefix — Meta always sends one.
  assert.equal(verifyMetaSignature(BODY, "deadbeef", MERCHANT_APP_SECRET), false);
  // Right prefix, wrong length: must not reach timingSafeEqual, which throws
  // on mismatched buffer lengths and would turn a bad request into a 500.
  assert.doesNotThrow(() => verifyMetaSignature(BODY, "sha256=abc", MERCHANT_APP_SECRET));
  assert.equal(verifyMetaSignature(BODY, "sha256=abc", MERCHANT_APP_SECRET), false);
});
