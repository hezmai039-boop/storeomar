import { Router } from "express";
import { prisma } from "../../db/prisma";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { accessibleStoreIdsFor } from "../../middleware/rbac";
import { buildPageMeta, decodeCursor } from "../../lib/pagination";

export const auditRouter = Router();
auditRouter.use(authenticate);

// GET /v1/organizations/:orgId/audit-logs?store_id=&actor=&action=&cursor=
// Read-only, no mutation route ever (docs/06-api-design.md §8) — owner
// sees every store's log, everyone else only the stores they can access.
auditRouter.get(
  "/organizations/:orgId/audit-logs",
  asyncHandler(async (req, res) => {
    if (req.auth!.organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const storeIds = await accessibleStoreIdsFor(req.auth!.userId, req.auth!.organizationId);

    const requestedStoreId = req.query.store_id as string | undefined;
    if (requestedStoreId && !storeIds.includes(requestedStoreId)) throw ApiError.storeAccessDenied();

    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);

    const rows = await withStoreContext(storeIds, (tx) =>
      tx.auditLog.findMany({
        where: {
          organizationId: req.params.orgId,
          ...(requestedStoreId ? { storeId: requestedStoreId } : { OR: [{ storeId: { in: storeIds } }, { storeId: null }] }),
          ...(req.query.actor ? { actorUserId: String(req.query.actor) } : {}),
          ...(req.query.action ? { action: String(req.query.action) } : {}),
        },
        orderBy: { id: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);
