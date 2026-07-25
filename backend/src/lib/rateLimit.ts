import rateLimit, { Store } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { getRedis } from "./redis";

// docs/06-api-design.md §0 promised this; wasn't wired up until now.
// Three tiers: auth is the brute-force target (tight), webhooks are
// legitimately bursty from the channel/integration platforms (loose,
// keyed by the account in the URL rather than IP since Meta/Salla call
// from shared infrastructure), everything else is the general API default.

// With REDIS_URL set, every instance shares one counter per key — otherwise
// each process would enforce its own limit, so N instances would multiply the
// real limit by N (a brute-force hole on the auth tier specifically). Without
// REDIS_URL this returns undefined and express-rate-limit keeps using its
// in-process MemoryStore, exactly as before.
function sharedStore(prefix: string): Store | undefined {
  const redis = getRedis();
  if (!redis) return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // ioredis exposes `call`; rate-limit-redis wants a generic sendCommand.
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as Promise<never>,
  });
}

export const authRateLimiter = rateLimit({
  store: sharedStore("auth"),
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "محاولات كثيرة جدًا لتسجيل الدخول، حاول لاحقًا", details: {} } },
});

export const apiRateLimiter = rateLimit({
  store: sharedStore("api"),
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "عدد كبير جدًا من الطلبات، حاول لاحقًا", details: {} } },
});

export const webhookRateLimiter = rateLimit({
  store: sharedStore("webhook"),
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.channelAccountId ?? req.params.integrationId ?? req.ip}`,
  message: { error: { code: "RATE_LIMITED", message: "too many webhook deliveries", details: {} } },
});

// Public, unauthenticated simulation endpoints (modules/simulation) — the
// token in the URL is the only credential, and every message triggers a
// real LLM call, so this is keyed per-token *and* per-visitor: a store
// owner is expected to hand the same link to several real people to test
// at once (docs/19-simulation-links.md), and keying by token alone made
// them all share one 60-req/5min budget — one person's testing session
// could exhaust it and lock everyone else out of a perfectly valid link.
// Keying by token+visitor still bounds the cost of any single simulated
// conversation, while different visitors of the same link no longer
// collide. Falls back to token+IP before a visitorId exists (first GET
// that resolves the link, or a brand-new visitor's first message) — on
// top of the general apiRateLimiter that already applies to all of /v1 by IP.
export const simulationRateLimiter = rateLimit({
  store: sharedStore("sim"),
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.params.token ?? "unknown";
    const visitorId = (req.body as { visitorId?: string } | undefined)?.visitorId ?? (req.query.visitorId as string | undefined);
    return `${token}:${visitorId ?? req.ip}`;
  },
  message: { error: { code: "RATE_LIMITED", message: "عدد كبير جدًا من الرسائل التجريبية، حاول لاحقًا", details: {} } },
});
