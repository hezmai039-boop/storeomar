import { Router } from "express";
import { resolverPrisma } from "../../db/resolverClient";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { getIntegrationAdapter } from "./adapters/registry";
import { decryptSecret } from "../../lib/crypto";
import { webhookRateLimiter } from "../../lib/rateLimit";

export const integrationWebhooksRouter = Router();

const WEBHOOK_SECRETS: Record<string, string> = {
  salla: process.env.SALLA_WEBHOOK_SECRET ?? "",
  zid: process.env.ZID_WEBHOOK_SECRET ?? "",
  shopify: process.env.SHOPIFY_WEBHOOK_SECRET ?? "",
  woocommerce: process.env.WOOCOMMERCE_WEBHOOK_SECRET ?? "",
  mock: process.env.MOCK_APP_SECRET ?? "dev-only-mock-secret",
};

// Extracts {externalOrderId, status, trackingUrl} from each platform's own
// order-updated webhook shape — a lighter per-platform switch than a full
// adapter method, since sync() above is the source of truth and this is
// just the fast path for near-real-time status.
function extractOrderUpdate(platform: string, payload: any): { externalOrderId: string; status: string; trackingUrl?: string } | null {
  switch (platform) {
    case "salla":
      return payload?.data?.id ? { externalOrderId: String(payload.data.id), status: payload.data.status?.name, trackingUrl: payload.data.shipments?.[0]?.tracking_link } : null;
    case "zid":
      return payload?.order?.id ? { externalOrderId: String(payload.order.id), status: payload.order.status?.code } : null;
    case "shopify":
      return payload?.id ? { externalOrderId: String(payload.id), status: payload.fulfillment_status ?? "unfulfilled", trackingUrl: payload.fulfillments?.[0]?.tracking_url } : null;
    case "woocommerce":
      return payload?.id ? { externalOrderId: String(payload.id), status: payload.status } : null;
    case "mock":
      return payload?.externalOrderId ? { externalOrderId: payload.externalOrderId, status: payload.status } : null;
    default:
      return null;
  }
}

// POST /v1/webhooks/integrations/:platformKey/:integrationId
integrationWebhooksRouter.post(
  "/integrations/:platformKey/:integrationId",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const { platformKey, integrationId } = req.params;
    const rawBody = req.body as Buffer;

    const integration = await resolverPrisma.integration.findUnique({ where: { id: integrationId } });
    if (!integration || integration.platform !== platformKey) return res.sendStatus(404);

    const adapter = getIntegrationAdapter(platformKey);
    const signature =
      (req.header("x-webhook-signature") as string | undefined) ??
      (req.header("x-shopify-hmac-sha256") as string | undefined) ??
      (req.header("x-wc-webhook-signature") as string | undefined);

    if (!adapter.verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRETS[platformKey] ?? "")) {
      return res.sendStatus(401);
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const update = extractOrderUpdate(platformKey, payload);
    if (update) {
      await withStoreContext([integration.storeId], (tx) =>
        tx.syncedOrder.upsert({
          where: {
            storeId_integrationId_externalOrderId: {
              storeId: integration.storeId,
              integrationId: integration.id,
              externalOrderId: update.externalOrderId,
            },
          },
          create: {
            storeId: integration.storeId,
            integrationId: integration.id,
            externalOrderId: update.externalOrderId,
            status: update.status,
            trackingUrl: update.trackingUrl,
            rawPayload: payload,
          },
          update: { status: update.status, trackingUrl: update.trackingUrl, rawPayload: payload, syncedAt: new Date() },
        })
      );
    }
    res.sendStatus(200);
  })
);
