import { getRedis, getRedisSubscriber } from "./redis";

// Small in-process cache for values that are read on the hot path, change
// rarely, and are cheap to re-fetch when missing.
//
// It exists because of one specific regression: session revocation added a
// `SELECT token_version, status FROM users WHERE id = $1` to authenticate(),
// i.e. to EVERY authenticated request. The query itself is a primary-key
// index scan costing ~0.04ms — the cost is not the query, it is one more
// round trip to a database that on Render is a separate service across the
// network, plus one more connection borrowed from the pool. For an endpoint
// that previously issued a single query, that is double the database traffic
// for a value that changes when someone changes their password.
//
// Correctness is preserved by invalidating explicitly at the moment the
// value changes, not by hoping the TTL is short enough:
//
//   - Same process: invalidate() drops the entry immediately.
//   - Other processes: the drop is broadcast over Redis, using the same
//     optional pub/sub the live inbox already relies on.
//   - No Redis, several instances: the TTL is the ceiling. At 30s that is a
//     worst case of half a minute for a sibling instance to notice a
//     password change — against the 8 hours a stateless JWT was valid for
//     before any of this existed.

const CHANNEL = "atlas:cache:invalidate";
const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

let subscribed = false;
const registry = new Map<string, TtlCache<unknown>>();

/** Subscribes once, lazily. Failures are logged, never thrown — losing the
 *  cross-instance drop degrades to TTL-only, which is still bounded. */
function ensureSubscribed() {
  if (subscribed) return;
  const sub = getRedisSubscriber();
  if (!sub) return;
  subscribed = true;
  sub.subscribe(CHANNEL).catch((err) => console.error(`[cache] subscribe failed: ${err.message}`));
  sub.on("message", (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const msg = JSON.parse(raw) as { origin: string; namespace: string; key: string };
      if (msg.origin === ORIGIN) return; // we already dropped it locally
      registry.get(msg.namespace)?.dropLocal(msg.key);
    } catch (err) {
      console.error(`[cache] bad invalidation payload: ${(err as Error).message}`);
    }
  });
}

export class TtlCache<V> {
  private store = new Map<string, Entry<V>>();

  constructor(
    private readonly namespace: string,
    private readonly ttlMs: number,
    /** Bound so a pathological key space (one entry per user id on a large
     *  tenant) cannot grow the heap without limit. Oldest inserted wins
     *  eviction — these entries are all equally cheap to rebuild. */
    private readonly maxEntries = 10_000
  ) {
    registry.set(namespace, this as TtlCache<unknown>);
    ensureSubscribed();
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await load();
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  /** Drops locally AND tells every other instance to drop it. Call this in
   *  the same code path that changes the underlying value. */
  invalidate(key: string): void {
    this.dropLocal(key);

    const redis = getRedis();
    if (!redis) return;
    redis
      .publish(CHANNEL, JSON.stringify({ origin: ORIGIN, namespace: this.namespace, key }))
      .catch((err) => console.error(`[cache] invalidation publish failed: ${err.message}`));
  }

  dropLocal(key: string): void {
    this.store.delete(key);
  }

  /** Test/diagnostic hook — not used by request paths. */
  size(): number {
    return this.store.size;
  }
}
