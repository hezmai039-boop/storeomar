import { Prisma } from "@prisma/client";
import { withStoreContext } from "../../db/withStoreContext";
import {
  MetaApiError,
  ParsedMetaError,
  formatChannelLastError,
  localFailure,
} from "./adapters/metaErrors";

// Turning a send failure into a fact ON THE CHANNEL ROW.
//
// Before this, a failed send was a console.error and nothing else: the row
// still said status='connected', so the owner's «صحة القنوات» table on
// /overview reported a healthy channel for something that had not delivered
// a message in a week. The whole value of that table depends on the row
// being written the moment a send fails.

/**
 * Any thrown value → a diagnosis. Adapters other than WhatsApp still throw
 * plain Errors; their `message` is NOT trusted onto an owner-facing surface
 * (it can carry a URL with a bot token in it, for example), so it is kept
 * as the log-only excerpt and the owner-facing text stays generic.
 */
export function diagnoseSendError(err: unknown): ParsedMetaError {
  if (err instanceof MetaApiError) return err.parsed;
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return localFailure("unknown", raw);
}

/**
 * Record a failed send on the channel.
 *
 * `status` flips to 'error' only for a credentials problem — that is the
 * class of failure where EVERY future message fails until a human rotates
 * the token, which is what "this channel is down" should mean. A recipient
 * who is not allow-listed, or a closed 24-hour window, is a per-message
 * outcome: it is recorded in `last_error` (so the owner can see it) but it
 * must not paint an otherwise healthy channel red.
 */
export async function recordChannelFailure(
  tx: Prisma.TransactionClient,
  channelAccountId: string,
  parsed: ParsedMetaError
): Promise<void> {
  await tx.channelAccount.update({
    where: { id: channelAccountId },
    data: {
      lastError: formatChannelLastError(parsed),
      lastErrorAt: new Date(),
      ...(parsed.isTokenProblem
        ? {
            status: "error",
            // We now know, as of this instant, that the token no longer
            // works — regardless of what Meta claimed its expiry was.
            ...(parsed.reason === "token_expired" ? { tokenExpiresAt: new Date() } : {}),
          }
        : {}),
    },
  });
}

/**
 * Record a successful send: the channel demonstrably works right now, so a
 * stale error must not keep the row red. Only touches rows that actually
 * carry a stale signal, so the happy path is a cheap no-op update.
 */
export async function recordChannelSuccess(
  tx: Prisma.TransactionClient,
  channelAccountId: string
): Promise<void> {
  await tx.channelAccount.updateMany({
    where: { id: channelAccountId, OR: [{ status: { not: "connected" } }, { lastError: { not: null } }] },
    data: { status: "connected", lastError: null, lastErrorAt: null },
  });
}

/**
 * Same as the two above, but opening its own store-scoped transaction —
 * for callers (the inbound webhook) that are deliberately NOT holding a
 * transaction open across the network call.
 */
export async function recordChannelOutcome(
  storeId: string,
  channelAccountId: string,
  outcome: { ok: true } | { ok: false; parsed: ParsedMetaError }
): Promise<void> {
  try {
    await withStoreContext([storeId], (tx) =>
      outcome.ok
        ? recordChannelSuccess(tx, channelAccountId)
        : recordChannelFailure(tx, channelAccountId, outcome.parsed)
    );
  } catch (err) {
    // Health bookkeeping must never be the reason a webhook 500s: Meta
    // retries a non-200 delivery, which would duplicate the inbound
    // message the caller has already persisted.
    console.error(`[channelHealth] failed to record outcome for channel_account=${channelAccountId}:`, err);
  }
}
