import { env } from "../../../config/env";

/**
 * One per e-commerce platform whose app store we publish to. Deliberately
 * separate from IntegrationAdapter (adapters/types.ts): the adapter answers
 * "how do I call this platform's API with a credential I already have",
 * this answers "how do I obtain and keep that credential". A platform can
 * have an adapter and no provider — shopify/woocommerce/mock still use a
 * hand-entered credential — but never the other way round.
 */
export interface OAuthProvider {
  key: string;
  /** Full authorize URL to redirect the merchant's browser to, state included. */
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  /** False when the platform's client id/secret env vars are unset. */
  isConfigured(): boolean;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  /** Extra per-platform credentials the API adapter needs (e.g. Zid's managerToken). */
  extra?: Record<string, string>;
}

/**
 * The exact object that gets JSON-stringified, encrypted and stored in
 * integrations.credentials_encrypted.
 *
 * The key names here are a contract with the API adapters, which destructure
 * this blob directly: salla.ts reads `accessToken`, zid.ts reads
 * `accessToken` + `managerToken`. Renaming a key here silently breaks sync
 * for every already-connected store (the adapter just sends `Bearer
 * undefined` and gets a 401), which is why the per-platform mapping lives in
 * one place — the provider's exchangeCode/refresh — instead of being spread
 * across the callback and the refresh path.
 *
 * `refreshToken` is stored alongside them because the refresh path needs it
 * later and the encrypted blob is the only place a secret is allowed to
 * live; the adapters simply ignore the extra key.
 */
export function toCredentialBlob(tokens: OAuthTokens): Record<string, string> {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.extra ?? {}),
  };
}

/** Absolute expiry to mirror into Integration.tokenExpiresAt, or null if the platform didn't say. */
export function expiryFrom(tokens: OAuthTokens): Date | null {
  if (!tokens.expiresInSeconds || !Number.isFinite(tokens.expiresInSeconds)) return null;
  return new Date(Date.now() + tokens.expiresInSeconds * 1000);
}

/**
 * The one place the callback URL is built, so the value we send as
 * `redirect_uri` on the authorize request, the value we repeat on the token
 * exchange (both platforms require them to match), and the value written in
 * the docs for the partner dashboard can never drift apart.
 */
export function redirectUriFor(platformKey: string): string {
  return `${env.oauthRedirectBase}/v1/integrations/oauth/${platformKey}/callback`;
}

/**
 * Both platforms' token endpoints are form-encoded and answer with JSON.
 * Errors are surfaced with the platform's own error body attached because
 * OAuth failures are otherwise indistinguishable from each other — but the
 * caller must never forward this message to the browser (see routes.ts).
 */
export async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OAuth token request to ${url} failed: ${resp.status} ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`OAuth token request to ${url} returned non-JSON: ${text.slice(0, 300)}`);
  }
}

/** Platforms send expires_in as a number (Salla) or a string (Zid). */
export function asSeconds(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
