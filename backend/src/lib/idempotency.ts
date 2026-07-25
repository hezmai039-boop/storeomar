// Idempotency store — docs/06-api-design.md §0 requires an Idempotency-Key on
// any endpoint that sends an outbound message or creates a record from a
// webhook, since channels like WhatsApp legitimately redeliver the same
// webhook after a slow response.
//
// Two backends:
//   - REDIS_URL set  → shared across instances. This is a correctness
//     requirement once there's more than one process: otherwise instance B
//     has no record of the reply instance A already sent, so a redelivered
//     webhook double-messages the customer.
//   - REDIS_URL unset → the original in-process Map, unchanged behaviour.
//
// Redis failures are swallowed and treated as "no record found": an outage
// must never break sending a reply — the worst case degrades to the
// per-process guarantee we already had.
import { getRedis } from "./redis";

interface Entry {
  status: number;
  body: unknown;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const TTL_SECONDS = TTL_MS / 1000;
const KEY_PREFIX = "idem:";

const seen = new Map<string, Entry & { expiresAt: number }>();
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Sweeping used to run on every single read — an O(n) scan of the whole map
// per request. Throttled to once a minute: entries carry their own expiry and
// are checked individually on read, so a late sweep only costs a little
// memory, never correctness.
function sweepIfDue() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of seen) {
    if (entry.expiresAt < now) seen.delete(key);
  }
}

export async function getIdempotentReplay(key: string | undefined): Promise<Entry | undefined> {
  if (!key) return undefined;

  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(KEY_PREFIX + key);
      return raw ? (JSON.parse(raw) as Entry) : undefined;
    } catch (err) {
      console.error(`[idempotency] redis read failed, falling back: ${(err as Error).message}`);
      // fall through to the in-memory copy
    }
  }

  sweepIfDue();
  const entry = seen.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    seen.delete(key);
    return undefined;
  }
  return { status: entry.status, body: entry.body };
}

export async function storeIdempotentResponse(key: string | undefined, status: number, body: unknown): Promise<void> {
  if (!key) return;

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(KEY_PREFIX + key, JSON.stringify({ status, body }), "EX", TTL_SECONDS);
      return;
    } catch (err) {
      console.error(`[idempotency] redis write failed, falling back: ${(err as Error).message}`);
      // fall through and at least record it in-process
    }
  }

  seen.set(key, { status, body, expiresAt: Date.now() + TTL_MS });
}
