import crypto from "node:crypto";
import { env } from "../../../config/env";
import { GRAPH_API_VERSION } from "../adapters/whatsapp";

// ---------------------------------------------------------------------------
// Meta Embedded Signup — the Graph API half.
//
// Pure functions over fetch, no Express and no Prisma, so every step of the
// flow (exchange → inspect → discover → subscribe) is testable without a
// browser or a database. The route file (routes.ts) owns state, RLS and
// redirects; this file owns Meta.
//
// Version note: GRAPH_API_VERSION is imported from the send adapter so the
// signup flow and the message-send path can never drift onto different
// Graph versions.
// ---------------------------------------------------------------------------

const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const DIALOG_BASE = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

/** Webhook fields the platform subscribes every connected WABA to. */
export const WABA_SUBSCRIBED_FIELDS = [
  "messages",
  "message_template_status_update",
  "message_deliveries",
  "message_reads",
  "account_update",
  "phone_number_quality_update",
] as const;

export function isEmbeddedSignupConfigured(): boolean {
  return Boolean(env.metaAppId && env.metaAppSecret && env.whatsappEsConfigId);
}

export function embeddedSignupRedirectUri(): string {
  return `${env.oauthRedirectBase}/v1/channels/whatsapp/oauth/callback`;
}

// --- PKCE -------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. The verifier never leaves the server (oauth_states row). */
export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * The Facebook OAuth dialog URL that renders the WhatsApp Embedded Signup
 * wizard. `config_id` is what switches the dialog from plain Facebook Login
 * to the WhatsApp signup experience; `override_default_response_type` forces
 * a `code` response even when the configuration defaults to a token — the
 * token must only ever be minted server-side.
 */
export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: env.metaAppId!,
    redirect_uri: embeddedSignupRedirectUri(),
    state,
    response_type: "code",
    config_id: env.whatsappEsConfigId!,
    override_default_response_type: "true",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${DIALOG_BASE}?${params.toString()}`;
}

// --- Code exchange -----------------------------------------------------------

export interface ExchangedToken {
  accessToken: string;
  /** Seconds until expiry as Meta reports it; undefined = not reported. */
  expiresIn?: number;
  tokenType?: string;
}

async function graphGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const resp = await fetch(`${GRAPH_BASE}${path}?${qs.toString()}`);
  const text = await resp.text();
  if (!resp.ok) {
    // The body can echo the client secret back — log-only, never thrown
    // upward verbatim. Callers get a stable, greppable message.
    console.error(`[whatsapp-es] GET ${path} failed (${resp.status}): ${text.slice(0, 500)}`);
    throw new Error(`graph_get_failed:${path}:${resp.status}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Authorization code → user access token (server-side, client secret + PKCE verifier). */
export async function exchangeCode(code: string, codeVerifier: string | null): Promise<ExchangedToken> {
  const params: Record<string, string> = {
    client_id: env.metaAppId!,
    client_secret: env.metaAppSecret!,
    redirect_uri: embeddedSignupRedirectUri(),
    code,
  };
  if (codeVerifier) params.code_verifier = codeVerifier;
  const json = await graphGet("/oauth/access_token", params);
  return {
    accessToken: String(json.access_token ?? ""),
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined,
    tokenType: typeof json.token_type === "string" ? json.token_type : undefined,
  };
}

/**
 * Short-lived → long-lived (~60 days). Called only when debug_token reports
 * a real expiry: a business-integration system-user token already reports
 * expires_at = 0 and exchanging it would be a wasted round trip.
 */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<ExchangedToken> {
  const json = await graphGet("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.metaAppId!,
    client_secret: env.metaAppSecret!,
    fb_exchange_token: shortLivedToken,
  });
  return {
    accessToken: String(json.access_token ?? ""),
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined,
    tokenType: typeof json.token_type === "string" ? json.token_type : undefined,
  };
}

// --- Token inspection ---------------------------------------------------------

export interface TokenInspection {
  appScopedUserId: string | null;
  scopes: string[];
  /** WABA ids the merchant shared during the wizard (granular_scopes). */
  sharedWabaIds: string[];
  /** null = never expires (business integration system user token). */
  expiresAt: Date | null;
  tokenType: "permanent" | "expiring";
}

interface DebugTokenData {
  user_id?: string;
  scopes?: string[];
  expires_at?: number;
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
}

/**
 * GET /debug_token with the APP access token (`appId|appSecret`) — the input
 * token itself must not be its own inspector, or a forged token could
 * self-report whatever it likes.
 */
export async function inspectToken(inputToken: string): Promise<TokenInspection> {
  const json = await graphGet("/debug_token", {
    input_token: inputToken,
    access_token: `${env.metaAppId}|${env.metaAppSecret}`,
  });
  const data = (json.data ?? {}) as DebugTokenData;
  return parseTokenInspection(data);
}

/** Split out of inspectToken so tests can feed it fixture payloads directly. */
export function parseTokenInspection(data: DebugTokenData): TokenInspection {
  const sharedWabaIds =
    (data.granular_scopes ?? [])
      .filter((g) => g.scope === "whatsapp_business_management" || g.scope === "whatsapp_business_messaging")
      .flatMap((g) => g.target_ids ?? []);
  // Meta encodes "never expires" as the literal 0.
  const neverExpires = data.expires_at === 0;
  return {
    appScopedUserId: data.user_id ?? null,
    scopes: data.scopes ?? [],
    sharedWabaIds: [...new Set(sharedWabaIds)],
    expiresAt: neverExpires || !data.expires_at ? null : new Date(data.expires_at * 1000),
    tokenType: neverExpires ? "permanent" : "expiring",
  };
}

// --- Asset discovery -----------------------------------------------------------

export interface DiscoveredPhoneNumber {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

export async function fetchWabaPhoneNumbers(wabaId: string, accessToken: string): Promise<DiscoveredPhoneNumber[]> {
  const json = await graphGet(`/${encodeURIComponent(wabaId)}/phone_numbers`, {
    fields: "id,display_phone_number,verified_name",
    access_token: accessToken,
  });
  const rows = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
  return rows.map((r) => ({
    phoneNumberId: String(r.id ?? ""),
    displayPhoneNumber: typeof r.display_phone_number === "string" ? r.display_phone_number : null,
    verifiedName: typeof r.verified_name === "string" ? r.verified_name : null,
  }));
}

export interface WabaInfo {
  wabaId: string;
  name: string | null;
  businessId: string | null;
}

export async function fetchWabaInfo(wabaId: string, accessToken: string): Promise<WabaInfo> {
  const json = await graphGet(`/${encodeURIComponent(wabaId)}`, {
    fields: "id,name,owner_business_info",
    access_token: accessToken,
  });
  const owner = (json.owner_business_info ?? null) as { id?: string } | null;
  return {
    wabaId: String(json.id ?? wabaId),
    name: typeof json.name === "string" ? json.name : null,
    businessId: owner?.id ? String(owner.id) : null,
  };
}

/**
 * POST /{waba-id}/subscribed_apps — makes Meta deliver this WABA's webhooks
 * to the app-level callback URL (/v1/webhooks/whatsapp). This is the call
 * the manual onboarding doc told the operator to run by hand; the ES flow
 * runs it automatically. `subscribed_fields` narrows delivery to what the
 * product consumes (WABA_SUBSCRIBED_FIELDS).
 */
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  const body = new URLSearchParams({ subscribed_fields: WABA_SUBSCRIBED_FIELDS.join(",") });
  const resp = await fetch(`${GRAPH_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[whatsapp-es] subscribed_apps failed for WABA ${wabaId} (${resp.status}): ${text.slice(0, 500)}`);
    throw new Error(`waba_subscribe_failed:${resp.status}`);
  }
}
