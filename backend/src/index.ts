import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { prisma } from "./db/prisma";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiRateLimiter, authRateLimiter } from "./lib/rateLimit";

import { identityRouter } from "./modules/identity/routes";
import { tenancyRouter } from "./modules/tenancy/routes";
import { channelsRouter } from "./modules/channels/routes";
import { webhooksRouter } from "./modules/channels/webhook";
import { knowledgeRouter } from "./modules/knowledge/routes";
import { ticketsRouter } from "./modules/tickets/routes";
import { integrationsRouter } from "./modules/integrations/routes";
import { integrationWebhooksRouter } from "./modules/integrations/webhook";
import { analyticsRouter } from "./modules/analytics/routes";
import { auditRouter } from "./modules/audit/routes";
import { aiIntelligenceRouter } from "./modules/ai-intelligence/routes";
import { simulationRouter } from "./modules/simulation/routes";
import { simulationPublicRouter } from "./modules/simulation/publicRoutes";
import { billingRouter } from "./modules/billing/routes";
import { oauthConnectRouter, oauthCallbackRouter } from "./modules/integrations/oauth/routes";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: env.corsOrigin }));

// Webhook routes need the raw body for HMAC signature verification, so they
// must be mounted with express.raw() *before* the global express.json()
// below — see docs/06-api-design.md §3 and src/modules/channels/webhook.ts.
app.use("/v1/webhooks", express.raw({ type: "*/*", limit: "5mb" }));
app.use("/v1/webhooks", webhooksRouter);
app.use("/v1/webhooks", integrationWebhooksRouter);

app.use(express.json({ limit: "5mb" }));
app.use("/v1", apiRateLimiter);
app.use("/v1/auth/login", authRateLimiter);
// The rest of the public auth surface gets the same tight bucket as login,
// for the same reason: each of these is a scripted attack in its own right —
// signup mints tenants (and mail) for free, forgot-password sprays an
// address list through our sending domain, reset-password/verify-email are
// where someone grinds tokens. They deliberately share one per-IP counter
// with login rather than getting their own, so an attacker can't just move
// to the next endpoint after exhausting one.
app.use("/v1/auth/signup", authRateLimiter);
app.use("/v1/auth/verify-email", authRateLimiter);
app.use("/v1/auth/resend-verification", authRateLimiter);
app.use("/v1/auth/forgot-password", authRateLimiter);
app.use("/v1/auth/reset-password", authRateLimiter);

// Liveness — "is the process up?". Cheap, no dependencies, never touches
// the DB, so a DB hiccup can't cause the orchestrator to kill a healthy
// process. This is what Render's health check should point at.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Readiness — "can it actually serve traffic?". Pings the DB with a trivial
// query. Use this for uptime monitoring / pre-traffic gating, NOT for
// liveness (a transient DB blip returning 503 here must not restart the app).
app.get("/health/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready", db: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unavailable", db: "error", message: (err as Error).message });
  }
});

// Mounted before identityRouter/tenancyRouter/auditRouter on purpose:
// those three call `.use(authenticate)` unconditionally inside themselves,
// and since they're mounted at the bare "/v1" prefix, that blanket
// authenticate would otherwise run for ANY "/v1/*" request — including
// this genuinely public, tokenless route — before Express ever gets to
// check whether one of their own routes actually matches. A request here
// now gets fully handled by simulationPublicRouter first, so it never
// reaches that unrelated auth check. (Real-world symptom this fixed: the
// simulation link worked only in the browser tab that still had a valid
// admin login token, and 401'd for every other visitor — including the
// store owner's own session once that token expired.)
app.use("/v1/public/simulate", simulationPublicRouter);

// The Salla/Zid OAuth callback, mounted here for exactly the same reason as
// the simulation route above: it is a genuinely public, tokenless route
// (the platform redirects the merchant's BROWSER to it, with no
// Authorization header), and the routers mounted at the bare "/v1" prefix
// below each call `.use(authenticate)` unconditionally — which would 401
// every install before Express reached this handler. Its own authentication
// is the single-use `state` row; see modules/integrations/oauth/routes.ts.
app.use("/v1/integrations/oauth", oauthCallbackRouter);

app.use("/v1", identityRouter);
app.use("/v1", tenancyRouter);
app.use("/v1/stores/:storeId", channelsRouter);
app.use("/v1/stores/:storeId/knowledge", knowledgeRouter);
app.use("/v1/stores/:storeId", ticketsRouter);
app.use("/v1/stores/:storeId", integrationsRouter);
// Authenticated half of the OAuth flow ("install the app" button).
app.use("/v1/stores/:storeId", oauthConnectRouter);
app.use("/v1/stores/:storeId/ai-intelligence", aiIntelligenceRouter);
app.use("/v1/stores/:storeId/simulation-links", simulationRouter);
// Organization-scoped, so it gets its own prefix rather than a
// /v1/stores/:storeId mount — there is no store in a billing path.
app.use("/v1/billing", billingRouter);
app.use("/v1", analyticsRouter);
app.use("/v1", auditRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Atlas backend listening on :${env.port}`);
});
