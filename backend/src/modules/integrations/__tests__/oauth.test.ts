import { test } from "node:test";
import assert from "node:assert/strict";

// These tests must run with no platform credentials set, which is also the
// default state of a dev machine — so they double as the check that the app
// boots and behaves sanely with none of the new env vars present.
//
// Note there is deliberately NO `process.env.OAUTH_REDIRECT_BASE = ...` here.
// ES module imports are hoisted and evaluated before any statement in this
// file's body, so config/env has already snapshotted process.env by the time
// such an assignment would run — the override would silently do nothing and
// leave these assertions comparing against a value the code never produced.
// Instead the expected redirect URIs are derived from the same env the code
// reads, which is what actually needs testing: that the URI sent on the
// authorize request, repeated on the token exchange, and written in the
// partner-dashboard docs are all one string that cannot drift apart.
delete process.env.SALLA_CLIENT_ID;
delete process.env.SALLA_CLIENT_SECRET;
delete process.env.ZID_CLIENT_ID;
delete process.env.ZID_CLIENT_SECRET;

import { sallaOAuthProvider } from "../oauth/salla";
import { zidOAuthProvider } from "../oauth/zid";
import { getOAuthProvider, oauthPlatformKeys } from "../oauth/registry";
import { toCredentialBlob, expiryFrom, redirectUriFor, asSeconds } from "../oauth/types";
import { env } from "../../../config/env";

const SALLA_REDIRECT = `${env.oauthRedirectBase}/v1/integrations/oauth/salla/callback`;
const ZID_REDIRECT = `${env.oauthRedirectBase}/v1/integrations/oauth/zid/callback`;

// --- isConfigured -----------------------------------------------------------

test("both providers report not-configured when their client id/secret env vars are unset", () => {
  assert.equal(sallaOAuthProvider.isConfigured(), false);
  assert.equal(zidOAuthProvider.isConfigured(), false);
});

// --- authorizeUrl -----------------------------------------------------------

test("Salla authorizeUrl points at the documented endpoint and carries state + redirect_uri", () => {
  const url = new URL(sallaOAuthProvider.authorizeUrl("st4te-value"));
  assert.equal(url.origin + url.pathname, "https://accounts.salla.sa/oauth2/auth");
  assert.equal(url.searchParams.get("state"), "st4te-value");
  assert.equal(url.searchParams.get("redirect_uri"), SALLA_REDIRECT);
  assert.equal(url.searchParams.get("response_type"), "code");
});

// Without offline_access Salla issues no refresh_token at all, so every
// connected store would silently die at the first token expiry — a failure
// that only shows up weeks after launch.
test("Salla authorizeUrl requests offline_access so a refresh token is issued", () => {
  const url = new URL(sallaOAuthProvider.authorizeUrl("s"));
  assert.match(url.searchParams.get("scope") ?? "", /offline_access/);
});

test("Zid authorizeUrl points at the documented endpoint and carries state + redirect_uri", () => {
  const url = new URL(zidOAuthProvider.authorizeUrl("another-state"));
  assert.equal(url.origin + url.pathname, "https://oauth.zid.sa/oauth/authorize");
  assert.equal(url.searchParams.get("state"), "another-state");
  assert.equal(url.searchParams.get("redirect_uri"), ZID_REDIRECT);
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("state values survive the URL intact even when they contain base64url characters", () => {
  // crypto.randomBytes(32).toString("base64url") yields - and _; a naive
  // string concatenation would still work, but an encoding bug here breaks
  // the state comparison on the callback for ~1 request in 2.
  const state = "aB-_cD" + "x".repeat(20);
  assert.equal(new URL(sallaOAuthProvider.authorizeUrl(state)).searchParams.get("state"), state);
  assert.equal(new URL(zidOAuthProvider.authorizeUrl(state)).searchParams.get("state"), state);
});

test("redirectUriFor matches the callback route actually mounted in index.ts", () => {
  assert.equal(redirectUriFor("salla"), SALLA_REDIRECT);
  assert.equal(redirectUriFor("zid"), ZID_REDIRECT);
});

// --- registry ---------------------------------------------------------------

test("registry resolves salla and zid, and returns undefined for anything else", () => {
  assert.equal(getOAuthProvider("salla"), sallaOAuthProvider);
  assert.equal(getOAuthProvider("zid"), zidOAuthProvider);
  // Platforms with an API adapter but no app store must NOT resolve — the
  // public callback route uses this to reject unknown :platform values.
  assert.equal(getOAuthProvider("shopify"), undefined);
  assert.equal(getOAuthProvider("../../etc/passwd"), undefined);
  assert.deepEqual(oauthPlatformKeys().sort(), ["salla", "zid"]);
});

// --- credential blob shape ---------------------------------------------------
//
// The contract with the API adapters. adapters/salla.ts destructures
// `{ accessToken }`; adapters/zid.ts destructures `{ accessToken,
// managerToken }`. If these assertions fail, sync breaks for every connected
// store with a `Bearer undefined` 401 and no other symptom.

test("Salla's blob gives adapters/salla.ts exactly the accessToken it destructures", () => {
  const blob = toCredentialBlob({ accessToken: "salla-access", refreshToken: "salla-refresh", expiresInSeconds: 1209600 });
  assert.equal(blob.accessToken, "salla-access");
  assert.equal(blob.refreshToken, "salla-refresh");
});

test("Zid's blob gives adapters/zid.ts both accessToken and managerToken", () => {
  // Mirrors Zid's crossed naming: the response's `authorization` is the
  // bearer token, its `access_token` is the X-Manager-Token.
  const blob = toCredentialBlob({
    accessToken: "zid-authorization-value",
    refreshToken: "zid-refresh",
    extra: { managerToken: "zid-access-token-value" },
  });
  assert.equal(blob.accessToken, "zid-authorization-value");
  assert.equal(blob.managerToken, "zid-access-token-value");
  assert.equal(blob.refreshToken, "zid-refresh");
});

test("blob omits refreshToken rather than storing the string \"undefined\"", () => {
  const blob = toCredentialBlob({ accessToken: "a" });
  assert.deepEqual(blob, { accessToken: "a" });
  assert.equal("refreshToken" in blob, false);
});

test("the blob round-trips through JSON exactly as it is stored", () => {
  const blob = toCredentialBlob({ accessToken: "a", extra: { managerToken: "m" } });
  const { accessToken, managerToken } = JSON.parse(JSON.stringify(blob)) as Record<string, string>;
  assert.equal(accessToken, "a");
  assert.equal(managerToken, "m");
});

// --- expiry -----------------------------------------------------------------

test("expiryFrom converts expires_in into an absolute date, and null when absent", () => {
  const at = expiryFrom({ accessToken: "a", expiresInSeconds: 3600 });
  assert.ok(at instanceof Date);
  const deltaMs = at!.getTime() - Date.now();
  assert.ok(deltaMs > 3_590_000 && deltaMs <= 3_600_000, `unexpected delta ${deltaMs}`);
  // Null, never "now": a hand-pasted token has no expiry, and a 0 here would
  // make the refresh path treat it as permanently expired.
  assert.equal(expiryFrom({ accessToken: "a" }), null);
});

test("asSeconds accepts Zid's string expires_in as well as Salla's number", () => {
  assert.equal(asSeconds(3600), 3600);
  assert.equal(asSeconds("31536000"), 31536000);
  assert.equal(asSeconds(undefined), undefined);
  assert.equal(asSeconds("not-a-number"), undefined);
  assert.equal(asSeconds(0), undefined);
});
