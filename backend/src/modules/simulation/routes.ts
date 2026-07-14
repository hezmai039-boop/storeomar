import { Router } from "express";
import { z } from "zod";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { generateSimulationToken } from "./service";

export const simulationRouter = Router({ mergeParams: true });
simulationRouter.use(authenticate, requireStoreAccess());

// GET /v1/stores/:storeId/simulation-links
simulationRouter.get(
  "/",
  requirePermission(PERMISSIONS.SIMULATION_MANAGE),
  asyncHandler(async (req, res) => {
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.simulationLink.findMany({ where: { storeId: req.storeAccess!.storeId }, orderBy: { createdAt: "desc" } })
    );
    res.json({ data: rows });
  })
);

const createLinkSchema = z.object({ label: z.string().min(1).max(80) });

// POST /v1/stores/:storeId/simulation-links
simulationRouter.post(
  "/",
  requirePermission(PERMISSIONS.SIMULATION_MANAGE),
  asyncHandler(async (req, res) => {
    const body = createLinkSchema.parse(req.body);
    const created = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const link = await tx.simulationLink.create({
        data: {
          storeId: req.storeAccess!.storeId,
          token: generateSimulationToken(),
          label: body.label,
          createdBy: req.auth!.userId,
        },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "simulation_link.created",
        entityType: "simulation_link",
        entityId: link.id,
        after: { label: link.label },
      });
      return link;
    });
    res.status(201).json({ data: created });
  })
);

const updateLinkSchema = z.object({ isActive: z.boolean() });

// PATCH /v1/stores/:storeId/simulation-links/:id — toggle a link on/off.
// No hard delete: a revoked link's token must stop working immediately
// (checked live in publicRoutes.ts) but its history (was it ever used,
// by whom, when) stays auditable, same convention as knowledge sources
// getting archived rather than deleted.
simulationRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.SIMULATION_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateLinkSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const existing = await tx.simulationLink.findFirst({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
      });
      if (!existing) throw ApiError.notFound("رابط المحاكاة");
      const result = await tx.simulationLink.update({ where: { id: existing.id }, data: { isActive: body.isActive } });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: body.isActive ? "simulation_link.activated" : "simulation_link.deactivated",
        entityType: "simulation_link",
        entityId: existing.id,
      });
      return result;
    });
    res.json({ data: updated });
  })
);
