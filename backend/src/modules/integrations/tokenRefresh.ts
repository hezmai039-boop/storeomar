import { resolverPrisma } from "../../db/resolverClient";
import { withStoreContext } from "../../db/withStoreContext";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { getOAuthProvider } from "./oauth/registry";
import { expiryFrom, toCredentialBlob } from "./oauth/types";

/**
 * Thrown when a store's platform credentials can no longer be renewed and
 * the merchant has to re-install the app. Typed on purpose: the sync path
 * needs to tell "your Salla connection expired, reconnect it" apart from
 * "Salla is down", and a raw 401 bubbling out of the adapter looks identical
 * to both the API and the support team.
 */
export class IntegrationReconnectRequiredError extends Error {
  readonly code = "INTEGRATION_RECONNECT_REQUIRED";
  constructor(readonly integrationId: string, readonly platform: string, readonly cause?: unknown) {
    super(`Integration ${integrationId} (${platform}) needs to be reconnected`);
    this.name = "IntegrationReconnectRequiredError";
  }
}

// Refresh this far ahead of the real expiry. A sync can take tens of
// seconds across several paginated calls, so a token that is merely "still
// valid right now" can expire mid-run; five minutes covers that plus clock
// skew between us and the platform.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Returns the decrypted credential blob for an integration, renewing it
 * first if it is at or near expiry. The caller gets the same
 * `Record<string, string>` shape the API adapters already destructure, so
 * swapping `JSON.parse(decryptSecret(...))` for this call is all that a call
 * site needs to change.
 *
 * Call it OUTSIDE an open transaction: refreshing makes a network round-trip
 * to the platform's token endpoint, and this codebase deliberately never
 * holds a Postgres transaction open across one (see the phase comments in
 * modules/channels/webhook.ts).
 */
export async function ensureFreshToken(integrationId: string): Promise<Record<string, string>> {
  // Pre-tenant lookup, exactly like the public webhooks: the caller has
  // already authorised this integration id, but we still don't know which
  // store owns it, and `integrations` is RLS-protected — so we cannot read
  // it through the app role until we do. This is one of the four tables the
  // resolver role is granted SELECT on for precisely this reason
  // (src/db/resolverClient.ts). Every write below goes back through
  // withStoreContext.
  const row = await resolverPrisma.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new Error(`No integration ${integrationId}`);

  const credentials = JSON.parse(decryptSecret(row.credentialsEncrypted)) as Record<string, string>;

  // Null expiry = a platform whose tokens don't expire, or a hand-pasted
  // token from before the OAuth flow existed. Nothing to renew, and nothing
  // is broken — hand it back untouched.
  if (!row.tokenExpiresAt) return credentials;
  if (row.tokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) return credentials;

  const provider = getOAuthProvider(row.platform);
  // An expiring token we have no way to renew (no refresh token stored, the
  // platform has no OAuth provider, or this deployment's client credentials
  // were removed) is a dead connection — fail it loudly now rather than
  // letting the adapter hit a 401 and report it as a platform outage.
  if (!provider || !provider.isConfigured() || !credentials.refreshToken) {
    await markNeedsReconnect(row.storeId, row.id);
    throw new IntegrationReconnectRequiredError(row.id, row.platform);
  }

  let tokens;
  try {
    tokens = await provider.refresh(credentials.refreshToken);
  } catch (err) {
    console.error(`[oauth ${row.platform}] refresh failed for integration ${row.id}:`, err);
    await markNeedsReconnect(row.storeId, row.id);
    throw new IntegrationReconnectRequiredError(row.id, row.platform, err);
  }

  // Merged over the old blob rather than replacing it: a refresh response is
  // allowed to omit values it hasn't changed (Salla often returns no new
  // refresh_token, Zid may not re-issue the manager token), and dropping a
  // key here would break the very next sync.
  const merged = { ...credentials, ...toCredentialBlob(tokens) };

  await withStoreContext([row.storeId], (tx) =>
    tx.integration.update({
      where: { id: row.id },
      data: {
        credentialsEncrypted: encryptSecret(JSON.stringify(merged)),
        // Kept in step with the blob it mirrors — a stale tokenExpiresAt
        // would make this function refresh on every single call.
        tokenExpiresAt: expiryFrom(tokens),
        status: "connected",
      },
    })
  );

  return merged;
}

/**
 * Surfaced to the merchant as "reconnect your store" in the integrations
 * screen. Written through withStoreContext like every other tenant write,
 * even though the caller is about to throw.
 */
async function markNeedsReconnect(storeId: string, integrationId: string): Promise<void> {
  try {
    await withStoreContext([storeId], (tx) =>
      tx.integration.update({ where: { id: integrationId }, data: { status: "needs_reconnect" } })
    );
  } catch (err) {
    // Never let bookkeeping mask the real failure the caller is reporting.
    console.error(`[oauth] could not flag integration ${integrationId} as needs_reconnect:`, err);
  }
}
