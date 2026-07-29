import { Router } from "express";
import { z } from "zod";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { encryptSecret } from "../../lib/crypto";
import { getIntegrationAdapter } from "./adapters/registry";
import { ensureFreshToken, IntegrationReconnectRequiredError } from "./tokenRefresh";

export const integrationsRouter = Router({ mergeParams: true });
integrationsRouter.use(authenticate, requireStoreAccess());

// GET /v1/stores/:storeId/integrations
integrationsRouter.get(
  "/integrations",
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(async (req, res) => {
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.integration.findMany({ where: { storeId: req.storeAccess!.storeId } })
    );
    res.json({ data: rows.map(({ credentialsEncrypted, ...rest }) => rest) });
  })
);

const createIntegrationSchema = z.object({
  platform: z.enum(["salla", "zid", "shopify", "woocommerce", "mock"]),
  credentials: z.record(z.unknown()),
});

// POST /v1/stores/:storeId/integrations
integrationsRouter.post(
  "/integrations",
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = createIntegrationSchema.parse(req.body);
    const created = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const integration = await tx.integration.upsert({
        where: { storeId_platform: { storeId: req.storeAccess!.storeId, platform: body.platform } },
        create: {
          storeId: req.storeAccess!.storeId,
          platform: body.platform,
          credentialsEncrypted: encryptSecret(JSON.stringify(body.credentials)),
          status: "connected",
        },
        update: { credentialsEncrypted: encryptSecret(JSON.stringify(body.credentials)), status: "connected" },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "integration.connected",
        entityType: "integration",
        entityId: integration.id,
        after: { platform: body.platform },
      });
      const { credentialsEncrypted, ...safe } = integration;
      return safe;
    });
    res.status(201).json({ data: created });
  })
);

// POST /v1/stores/:storeId/integrations/:id/sync — manual pull, backstop
// for missed webhooks (docs/06-api-design.md §6).
integrationsRouter.post(
  "/integrations/:id/sync",
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(async (req, res) => {
    // Resolve the integration first, in its own short transaction: both of
    // the steps that follow (renewing an expiring token, then calling the
    // platform's API) are network round-trips, and this codebase does not
    // hold a Postgres transaction open across one — see the phase split in
    // modules/channels/webhook.ts. The findFirst still scopes by storeId, so
    // the ownership check is unchanged.
    const integration = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.integration.findFirstOrThrow({ where: { id: req.params.id, storeId: req.storeAccess!.storeId } })
    );
    const adapter = getIntegrationAdapter(integration.platform);

    // Was JSON.parse(decryptSecret(...)) inline. ensureFreshToken returns the
    // same blob, having transparently renewed it when it is about to expire —
    // so an OAuth-installed store keeps syncing without the merchant ever
    // reconnecting, and a genuinely dead connection reports itself as such
    // instead of as a mystery 401 from the platform.
    let credentials: Record<string, string>;
    try {
      credentials = await ensureFreshToken(integration.id);
    } catch (err) {
      if (err instanceof IntegrationReconnectRequiredError) {
        throw new ApiError(409, err.code, "انتهت صلاحية ربط المتجر بالمنصة، أعد ربط المنصة من صفحة الإعدادات", {
          platform: integration.platform,
        });
      }
      throw err;
    }

    const [orders, products] = await Promise.all([adapter.fetchOrders(credentials), adapter.fetchProducts(credentials)]);

    const summary = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      for (const o of orders) {
        await tx.syncedOrder.upsert({
          where: {
            storeId_integrationId_externalOrderId: {
              storeId: req.storeAccess!.storeId,
              integrationId: integration.id,
              externalOrderId: o.externalOrderId,
            },
          },
          create: { storeId: req.storeAccess!.storeId, integrationId: integration.id, ...o, rawPayload: o.rawPayload as object },
          update: { status: o.status, trackingUrl: o.trackingUrl, rawPayload: o.rawPayload as object, syncedAt: new Date() },
        });
      }
      for (const p of products) {
        await tx.syncedProduct.upsert({
          where: {
            storeId_integrationId_externalProductId: {
              storeId: req.storeAccess!.storeId,
              integrationId: integration.id,
              externalProductId: p.externalProductId,
            },
          },
          create: {
            storeId: req.storeAccess!.storeId,
            integrationId: integration.id,
            ...p,
            sizes: p.sizes ?? [],
            rawPayload: p.rawPayload as object,
          },
          update: { name: p.name, price: p.price, rawPayload: p.rawPayload as object, syncedAt: new Date() },
        });
      }
      await tx.integration.update({ where: { id: integration.id }, data: { lastSyncedAt: new Date(), status: "connected" } });
      return { orders: orders.length, products: products.length };
    });
    res.json({ data: summary });
  })
);

// GET /v1/stores/:storeId/orders/:externalOrderId — the fast local-cache
// lookup the AI pipeline is meant to use instead of calling the platform
// API live on every customer message.
integrationsRouter.get(
  "/orders/:externalOrderId",
  requirePermission(PERMISSIONS.CONVERSATIONS_VIEW),
  asyncHandler(async (req, res) => {
    const order = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.syncedOrder.findFirst({
        where: { storeId: req.storeAccess!.storeId, externalOrderId: req.params.externalOrderId },
      })
    );
    if (!order) throw ApiError.notFound("الطلب");
    res.json({ data: order });
  })
);
