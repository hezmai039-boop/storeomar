import express from "express";
import cors from "cors";
import { env } from "./config/env";
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

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/v1", identityRouter);
app.use("/v1", tenancyRouter);
app.use("/v1/stores/:storeId", channelsRouter);
app.use("/v1/stores/:storeId/knowledge", knowledgeRouter);
app.use("/v1/stores/:storeId", ticketsRouter);
app.use("/v1/stores/:storeId", integrationsRouter);
app.use("/v1", analyticsRouter);
app.use("/v1", auditRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Atlas backend listening on :${env.port}`);
});
