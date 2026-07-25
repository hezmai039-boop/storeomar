import Redis from "ioredis";
import { env } from "../config/env";

// Optional shared state backend. Set REDIS_URL to run more than one backend
// instance; leave it unset and everything keeps using the existing
// single-process in-memory paths (rate limits, idempotency, SSE fan-out), so
// nothing about a single-instance deployment changes.
//
// Why this matters: express-rate-limit's MemoryStore, the idempotency Map,
// and the SSE EventEmitter are all per-process. With two instances behind a
// load balancer, each would enforce its own rate limit, miss the other's
// idempotency records (so a redelivered WhatsApp webhook could double-send a
// reply), and only push live inbox updates to the browsers connected to that
// same process. Redis makes all three shared.
//
// Failure policy: connection problems are logged, never thrown. A Redis
// outage must not take the API down — the rate limiter falls back to
// allowing traffic (see rateLimit.ts) and idempotency/realtime degrade to
// per-process behaviour, which is exactly today's working behaviour.

let client: Redis | null = null;
let subscriber: Redis | null = null;

function create(role: string): Redis {
  const c = new Redis(env.redisUrl!, {
    maxRetriesPerRequest: 3,
    // Don't queue commands forever while disconnected — fail fast so callers
    // fall back instead of hanging a customer-facing request.
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  c.on("error", (err) => console.error(`[redis:${role}] ${err.message}`));
  c.on("connect", () => console.log(`[redis:${role}] connected`));
  return c;
}

/** Shared command client, or null when REDIS_URL isn't configured. */
export function getRedis(): Redis | null {
  if (!env.redisUrl) return null;
  if (!client) client = create("main");
  return client;
}

/**
 * A SECOND connection dedicated to pub/sub. Required: once a Redis
 * connection enters subscriber mode it can't run normal commands, so
 * publishing and subscribing must not share one client.
 */
export function getRedisSubscriber(): Redis | null {
  if (!env.redisUrl) return null;
  if (!subscriber) subscriber = create("sub");
  return subscriber;
}

export const redisEnabled = () => !!env.redisUrl;
