import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// env must be shaped BEFORE graph.ts (→ config/env.ts) is imported: the env
// object snapshots process.env at import time. Same values the npm test
// script sets for DATABASE_URL/JWT_SECRET/ENCRYPTION_KEY.
process.env.META_APP_ID = process.env.META_APP_ID ?? "1234567890";
process.env.WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "test-app-secret";
process.env.WHATSAPP_ES_CONFIG_ID = process.env.WHATSAPP_ES_CONFIG_ID ?? "9876543210";

// Dynamic import, NOT a static one: static imports hoist above the env
// assignments above, and config/env.ts snapshots process.env at import time —
// the exact bug these lines exist to prevent.
const graphModule = import("../embeddedSignup/graph");

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

test("generatePkcePair: challenge is the S256 of the verifier, base64url", async () => {
  const { generatePkcePair } = await graphModule;
  const { verifier, challenge } = generatePkcePair();
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  // base64url — no '+', '/' or '=' that would break a query string.
  assert.doesNotMatch(verifier, /[+/=]/);
  assert.doesNotMatch(challenge, /[+/=]/);
  // RFC 7636 requires 43–128 chars.
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
});

test("generatePkcePair: two calls never collide", async () => {
  const { generatePkcePair } = await graphModule;
  assert.notEqual(generatePkcePair().verifier, generatePkcePair().verifier);
});

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

test("buildAuthorizeUrl: carries state, config_id, PKCE and forces a code response", async () => {
  const { buildAuthorizeUrl, embeddedSignupRedirectUri } = await graphModule;
  const url = new URL(buildAuthorizeUrl("my-state", "my-challenge"));
  assert.equal(url.hostname, "www.facebook.com");
  assert.equal(url.searchParams.get("client_id"), process.env.META_APP_ID);
  assert.equal(url.searchParams.get("state"), "my-state");
  assert.equal(url.searchParams.get("config_id"), process.env.WHATSAPP_ES_CONFIG_ID);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("override_default_response_type"), "true");
  assert.equal(url.searchParams.get("code_challenge"), "my-challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), embeddedSignupRedirectUri());
});

test("isEmbeddedSignupConfigured: true when the three vars are set", async () => {
  const { isEmbeddedSignupConfigured } = await graphModule;
  assert.equal(isEmbeddedSignupConfigured(), true);
});

// ---------------------------------------------------------------------------
// debug_token parsing — fixture-shaped like Meta's real responses.
// ---------------------------------------------------------------------------

test("parseTokenInspection: permanent token (expires_at = 0) with shared WABAs", async () => {
  const { parseTokenInspection } = await graphModule;
  const parsed = parseTokenInspection({
    user_id: "10001",
    scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"],
    expires_at: 0,
    granular_scopes: [
      { scope: "whatsapp_business_management", target_ids: ["111", "222"] },
      { scope: "whatsapp_business_messaging", target_ids: ["111"] },
      { scope: "business_management", target_ids: ["999"] },
    ],
  });
  assert.equal(parsed.tokenType, "permanent");
  assert.equal(parsed.expiresAt, null);
  assert.equal(parsed.appScopedUserId, "10001");
  // Deduplicated across the two whatsapp scopes; business_management ignored.
  assert.deepEqual(parsed.sharedWabaIds.sort(), ["111", "222"]);
});

test("parseTokenInspection: expiring user token carries a real Date", async () => {
  const { parseTokenInspection } = await graphModule;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const parsed = parseTokenInspection({
    user_id: "10002",
    scopes: ["whatsapp_business_management"],
    expires_at: exp,
    granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["333"] }],
  });
  assert.equal(parsed.tokenType, "expiring");
  assert.equal(parsed.expiresAt?.getTime(), exp * 1000);
  assert.deepEqual(parsed.sharedWabaIds, ["333"]);
});

test("parseTokenInspection: empty payload degrades safely", async () => {
  const { parseTokenInspection } = await graphModule;
  const parsed = parseTokenInspection({});
  assert.equal(parsed.appScopedUserId, null);
  assert.deepEqual(parsed.scopes, []);
  assert.deepEqual(parsed.sharedWabaIds, []);
  // No expires_at at all reads as permanent-shaped null expiry but the
  // tokenType stays "expiring" ONLY when expires_at is a positive number —
  // an absent field must not accidentally schedule refreshes.
  assert.equal(parsed.expiresAt, null);
});

// ---------------------------------------------------------------------------
// Webhook subscription contract
// ---------------------------------------------------------------------------

test("WABA_SUBSCRIBED_FIELDS: the six fields the product depends on", async () => {
  const { WABA_SUBSCRIBED_FIELDS } = await graphModule;
  assert.deepEqual(
    [...WABA_SUBSCRIBED_FIELDS],
    [
      "messages",
      "message_template_status_update",
      "message_deliveries",
      "message_reads",
      "account_update",
      "phone_number_quality_update",
    ]
  );
});
