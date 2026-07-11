// In-memory idempotency store for MVP — docs/06-api-design.md §0 requires
// an Idempotency-Key on any endpoint that sends an outbound message or
// creates a record from a webhook, since channels like WhatsApp legitimately
// redeliver the same webhook after a slow response.
//
// Production note: this must move to a shared store (Redis or a DB table)
// once there is more than one backend instance, since a Map is per-process.
const seen = new Map<string, { status: number; body: unknown; expiresAt: number }>();
const TTL_MS = 24 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [key, entry] of seen) {
    if (entry.expiresAt < now) seen.delete(key);
  }
}

export function getIdempotentReplay(key: string | undefined) {
  if (!key) return undefined;
  sweep();
  return seen.get(key);
}

export function storeIdempotentResponse(key: string | undefined, status: number, body: unknown) {
  if (!key) return;
  seen.set(key, { status, body, expiresAt: Date.now() + TTL_MS });
}
