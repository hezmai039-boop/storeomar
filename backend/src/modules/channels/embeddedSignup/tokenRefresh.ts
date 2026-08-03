import { prisma } from "../../../db/prisma";
import { decryptSecret, encryptSecret } from "../../../lib/crypto";
import { exchangeForLongLivedToken, inspectToken, isEmbeddedSignupConfigured } from "./graph";

// ---------------------------------------------------------------------------
// Automatic token refresh for Embedded-Signup WhatsApp channels.
//
// Only rows with tokenType = "expiring" are candidates: a permanent
// (business-integration system user) token reports expires_at = 0 and never
// needs this. The long-lived exchange (fb_exchange_token) works on a still-
// valid long-lived token and returns a fresh ~60-day one, so refreshing a
// week before expiry keeps the channel alive indefinitely without the
// merchant ever seeing a dead token.
//
// Best-effort by design, like recordAiUsage in billing/service.ts: one
// failed refresh is logged and retried on the next sweep — it must never
// take the process down or mark a still-working channel as broken.
// ---------------------------------------------------------------------------

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // refresh within 7 days of expiry
const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day

export async function refreshExpiringWhatsAppTokens(): Promise<void> {
  if (!isEmbeddedSignupConfigured()) return;

  try {
    const cutoff = new Date(Date.now() + REFRESH_WINDOW_MS);
    const candidates = await prisma.channelAccount.findMany({
      where: {
        tokenType: "expiring",
        tokenExpiresAt: { not: null, lt: cutoff },
        status: { not: "disconnected" },
        channelType: { key: "whatsapp" },
      },
      select: { id: true, storeId: true, credentialsEncrypted: true },
    });

    for (const account of candidates) {
      try {
        const creds = JSON.parse(decryptSecret(account.credentialsEncrypted)) as Record<string, unknown>;
        const currentToken = typeof creds.accessToken === "string" ? creds.accessToken : null;
        if (!currentToken) continue;

        const refreshed = await exchangeForLongLivedToken(currentToken);
        if (!refreshed.accessToken) continue;
        const inspection = await inspectToken(refreshed.accessToken);

        await prisma.channelAccount.update({
          where: { id: account.id },
          data: {
            credentialsEncrypted: encryptSecret(JSON.stringify({ ...creds, accessToken: refreshed.accessToken })),
            tokenType: inspection.tokenType,
            tokenExpiresAt: inspection.expiresAt,
            tokenScopes: inspection.scopes,
          },
        });
        console.log(`[whatsapp-es] refreshed token for channel_account ${account.id}`);
      } catch (err) {
        // Logged and left for the next sweep — the current token may still be
        // valid for days, so failing loudly here would be premature.
        console.error(`[whatsapp-es] token refresh failed for channel_account ${account.id}:`, err);
      }
    }
  } catch (err) {
    // Database connection error or other system-level failure — log and
    // return without crashing the server. The next sweep will retry.
    console.error(`[whatsapp-es] token refresh sweep failed:`, err);
  }
}

/** Started once from src/index.ts. No-op on deployments without a Meta App. */
export function startWhatsAppTokenRefreshLoop(): void {
  if (!isEmbeddedSignupConfigured()) return;
  // First sweep shortly after boot (catch anything that expired while the
  // process was down), then on the regular interval.
  setTimeout(() => void refreshExpiringWhatsAppTokens(), 30_000);
  setInterval(() => void refreshExpiringWhatsAppTokens(), SWEEP_INTERVAL_MS);
}
