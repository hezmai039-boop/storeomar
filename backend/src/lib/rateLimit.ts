import rateLimit from "express-rate-limit";

// docs/06-api-design.md §0 promised this; wasn't wired up until now.
// Three tiers: auth is the brute-force target (tight), webhooks are
// legitimately bursty from the channel/integration platforms (loose,
// keyed by the account in the URL rather than IP since Meta/Salla call
// from shared infrastructure), everything else is the general API default.

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "محاولات كثيرة جدًا لتسجيل الدخول، حاول لاحقًا", details: {} } },
});

export const apiRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "عدد كبير جدًا من الطلبات، حاول لاحقًا", details: {} } },
});

export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.channelAccountId ?? req.params.integrationId ?? req.ip}`,
  message: { error: { code: "RATE_LIMITED", message: "too many webhook deliveries", details: {} } },
});
