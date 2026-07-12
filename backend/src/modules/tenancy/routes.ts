import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { accessibleStoreIdsFor, requirePermission, requireStoreAccess, requireOwner } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";

export const tenancyRouter = Router();
tenancyRouter.use(authenticate);

// GET /v1/organizations/:orgId
tenancyRouter.get(
  "/organizations/:orgId",
  asyncHandler(async (req, res) => {
    if (req.auth!.organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.params.orgId } });
    res.json({ data: org });
  })
);

// GET /v1/stores — only what this user may open (docs/06-api-design.md §2)
tenancyRouter.get(
  "/stores",
  asyncHandler(async (req, res) => {
    const storeIds = await accessibleStoreIdsFor(req.auth!.userId, req.auth!.organizationId);
    const stores = await withStoreContext(storeIds, (tx) =>
      tx.store.findMany({ where: { id: { in: storeIds } }, orderBy: { name: "asc" } })
    );
    res.json({ data: stores });
  })
);

const createStoreSchema = z.object({ name: z.string().min(1), slug: z.string().min(1), currency: z.string().default("SAR") });

// POST /v1/stores — owner only
tenancyRouter.post(
  "/stores",
  requireOwner(),
  asyncHandler(async (req, res) => {
    const body = createStoreSchema.parse(req.body);
    const store = await prisma.store.create({
      data: { organizationId: req.auth!.organizationId, name: body.name, slug: body.slug, currency: body.currency },
    });
    await withStoreContext([store.id], async (tx) => {
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.created",
        entityType: "store",
        entityId: store.id,
        after: { name: store.name, slug: store.slug },
      });
    });
    res.status(201).json({ data: store });
  })
);

// GET /v1/stores/:storeId
tenancyRouter.get(
  "/stores/:storeId",
  requireStoreAccess(),
  asyncHandler(async (req, res) => {
    const store = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.store.findUniqueOrThrow({ where: { id: req.params.storeId } })
    );
    res.json({ data: store });
  })
);

const updateStoreSchema = z.object({ name: z.string().min(1).max(200) });

// PATCH /v1/stores/:storeId — rename a store (e.g. swap a demo name for the
// client's real business name). Owner-only, like store creation, since this
// is store identity rather than day-to-day settings.
tenancyRouter.patch(
  "/stores/:storeId",
  requireStoreAccess(),
  requirePermission(PERMISSIONS.STORES_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateStoreSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const before = await tx.store.findUniqueOrThrow({ where: { id: req.params.storeId } });
      const store = await tx.store.update({
        where: { id: req.params.storeId },
        data: { name: body.name },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.renamed",
        entityType: "store",
        entityId: store.id,
        before: { name: before.name },
        after: { name: store.name },
      });
      return store;
    });
    res.json({ data: updated });
  })
);

const updateSettingsSchema = z.object({ settings: z.record(z.unknown()) });

// PATCH /v1/stores/:storeId/settings
tenancyRouter.patch(
  "/stores/:storeId/settings",
  requireStoreAccess(),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateSettingsSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const store = await tx.store.update({
        where: { id: req.params.storeId },
        data: { settings: body.settings as Prisma.InputJsonValue },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.settings.updated",
        entityType: "store",
        entityId: store.id,
        after: body.settings,
      });
      return store;
    });
    res.json({ data: updated });
  })
);
