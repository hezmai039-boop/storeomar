import { ChannelAdapter, NormalizedInboundMessage } from "./types";
import { verifyMetaSignature } from "./metaSignature";
import { MetaApiError, localFailure, parseMetaError, ParsedMetaError } from "./metaErrors";

export const GRAPH_API_VERSION = "v20.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface WhatsAppCredentials {
  phoneNumberId: string;
  accessToken: string;
}

// WhatsApp Business Platform (Cloud API) — https://developers.facebook.com/docs/whatsapp/cloud-api
interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id: string; from: string; text?: { body: string } }>;
        contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
      };
    }>;
  }>;
}

export const whatsappAdapter: ChannelAdapter = {
  key: "whatsapp-cloud-api",

  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  },

  parseWebhook(payload) {
    const body = payload as WhatsAppWebhookPayload;
    const out: NormalizedInboundMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const contactsByWaId = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const msg of change.value?.messages ?? []) {
          out.push({
            externalCustomerId: msg.from,
            customerName: contactsByWaId.get(msg.from),
            customerPhone: msg.from,
            text: msg.text?.body ?? "",
            externalMessageId: msg.id,
          });
        }
      }
    }
    return out;
  },

  async sendMessage(credentials, message) {
    const { phoneNumberId, accessToken } = credentials as unknown as WhatsAppCredentials;
    const resp = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: message.toExternalId,
        type: "text",
        text: { body: message.text },
      }),
    });
    if (!resp.ok) {
      // Meta's raw body is parsed into a cause the product can act on
      // (metaErrors.ts) instead of being stringified into an Error message.
      // The raw text stays here, in the server log, and is never carried
      // into a response — MetaApiError.message is the Arabic title.
      const parsed = parseMetaError(resp.status, await resp.text());
      logMetaFailure("sendMessage", parsed);
      throw new MetaApiError(parsed);
    }
    const json = (await resp.json()) as { messages?: Array<{ id: string }> };
    return { externalMessageId: json.messages?.[0]?.id ?? "" };
  },
};

// ---------------------------------------------------------------------------
// Diagnostics — used by POST /channel-accounts/:id/diagnose («فحص القناة»).
//
// Deliberately read-only Graph calls that need NO recipient: the whole point
// is to answer "is this channel actually alive?" without messaging a
// customer, which is exactly what the existing «رسالة اختبار» cannot do
// (it needs a recipient, and on a test number that recipient must itself be
// allow-listed — so it fails for two different reasons at once).
// ---------------------------------------------------------------------------

/** The subset of GET /{phone-number-id} we surface. Everything here is the merchant's own data. */
export interface WhatsAppNumberProfile {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Meta's own name-review state: APPROVED / PENDING_REVIEW / DECLINED / … */
  nameStatus: string | null;
  /** VERIFIED / NOT_VERIFIED — the number's own verification, separate from the name. */
  codeVerificationStatus: string | null;
  /** GREEN / YELLOW / RED / UNKNOWN */
  qualityRating: string | null;
  /** CLOUD_API / ON_PREMISE / NOT_APPLICABLE */
  platformType: string | null;
}

export type WhatsAppProbeResult =
  | { ok: true; profile: WhatsAppNumberProfile }
  | { ok: false; error: ParsedMetaError };

/**
 * GET /{phone-number-id} with the stored token. One call answers three of
 * the five failure causes at once: a 190 means the token is dead, a 100/33
 * means the phone number id is wrong, and a success proves both are fine
 * (so a send failure must be a per-recipient or per-window problem).
 */
export async function probeWhatsAppNumber(credentials: WhatsAppCredentials): Promise<WhatsAppProbeResult> {
  const fields = "display_phone_number,verified_name,name_status,code_verification_status,quality_rating,platform_type";
  let resp: Response;
  try {
    resp = await fetch(`${GRAPH_BASE}/${encodeURIComponent(credentials.phoneNumberId)}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
  } catch (err) {
    // Never reached Meta at all (DNS/TLS/socket). Not a credentials problem,
    // and must not be reported as one.
    return { ok: false, error: localFailure("meta_unavailable", `fetch failed: ${(err as Error).message}`) };
  }
  if (!resp.ok) {
    const parsed = parseMetaError(resp.status, await resp.text());
    logMetaFailure("probeNumber", parsed);
    return { ok: false, error: parsed };
  }
  const json = (await resp.json()) as Record<string, unknown>;
  const str = (k: string) => (typeof json[k] === "string" ? (json[k] as string) : null);
  return {
    ok: true,
    profile: {
      displayPhoneNumber: str("display_phone_number"),
      verifiedName: str("verified_name"),
      nameStatus: str("name_status"),
      codeVerificationStatus: str("code_verification_status"),
      qualityRating: str("quality_rating"),
      platformType: str("platform_type"),
    },
  };
}

export interface WhatsAppTokenInfo {
  /** true when Meta reports expires_at = 0 — i.e. a System User token, the only kind fit for production. */
  neverExpires: boolean;
  expiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  isValid: boolean | null;
}

/**
 * Best-effort GET /debug_token. This is what turns "your token might be
 * temporary" into a fact with a date on it — the difference between the
 * 24-hour test token and a permanent System User token is the single most
 * common reason a WhatsApp channel "worked, then stopped".
 *
 * Best-effort by design: Meta only answers this for tokens whose app the
 * caller can inspect, so a legitimate, perfectly healthy token can still be
 * refused here. A refusal therefore returns null and changes NOTHING about
 * the diagnosis — it never downgrades a channel.
 */
export async function inspectWhatsAppToken(accessToken: string): Promise<WhatsAppTokenInfo | null> {
  try {
    const url = `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(accessToken)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      data?: { expires_at?: number; data_access_expires_at?: number; is_valid?: boolean };
    };
    const data = json.data;
    if (!data) return null;
    const toDate = (v: number | undefined) => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);
    return {
      // Meta encodes "permanent" as the literal 0, not as a missing field.
      neverExpires: data.expires_at === 0,
      expiresAt: toDate(data.expires_at),
      dataAccessExpiresAt: toDate(data.data_access_expires_at),
      isValid: typeof data.is_valid === "boolean" ? data.is_valid : null,
    };
  } catch {
    return null;
  }
}

function logMetaFailure(op: string, parsed: ParsedMetaError) {
  // The one place Meta's own words are allowed to appear. Structured so it
  // is greppable by reason, which is what makes the log worth reading.
  console.error(
    `[whatsapp ${op}] reason=${parsed.reason} http=${parsed.httpStatus} code=${parsed.code} subcode=${parsed.subcode} :: ${parsed.rawExcerpt}`
  );
}
