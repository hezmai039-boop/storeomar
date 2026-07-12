import { Router } from "express";
import { Prisma } from "@prisma/client";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { authenticate } from "../../middleware/auth";
import { requireOwner, requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { accessibleStoreIdsFor } from "../../middleware/rbac";
import { prisma } from "../../db/prisma";

export const analyticsRouter = Router({ mergeParams: true });

function rangeStart(range: string): Date {
  const days = range.endsWith("d") ? Number(range.slice(0, -1)) : 7;
  const d = new Date();
  d.setDate(d.getDate() - (Number.isFinite(days) ? days : 7));
  return d;
}

// Takes the transaction client from withStoreContext explicitly — using the
// plain `prisma` singleton here would silently return all-zero counts,
// since conversations/tickets/ai_response_logs are RLS-protected and the
// session-level `app.accessible_store_ids` is only set inside that
// transaction (this was a real bug caught by actually running the app,
// not just typechecking it).
async function storeSummary(tx: Prisma.TransactionClient, storeId: string, since: Date) {
  const [totalConversations, answered, escalated, openTickets] = await Promise.all([
    tx.conversation.count({ where: { storeId, createdAt: { gte: since } } }),
    tx.aiResponseLog.count({ where: { storeId, actionTaken: "answered", createdAt: { gte: since } } }),
    tx.aiResponseLog.count({ where: { storeId, actionTaken: "escalated_to_human", createdAt: { gte: since } } }),
    tx.ticket.count({ where: { storeId, status: { in: ["open", "in_progress"] } } }),
  ]);
  const totalHandled = answered + escalated;
  return {
    storeId,
    totalConversations,
    aiResolvedRate: totalHandled > 0 ? Math.round((answered / totalHandled) * 100) : 0,
    escalationRate: totalHandled > 0 ? Math.round((escalated / totalHandled) * 100) : 0,
    openTickets,
  };
}

// GET /v1/organizations/:orgId/reports/overview?range=7d — owner's
// cross-store dashboard (docs/04-user-flows.md §7).
analyticsRouter.get(
  "/organizations/:orgId/reports/overview",
  authenticate,
  requireOwner(),
  asyncHandler(async (req, res) => {
    const since = rangeStart(String(req.query.range ?? "7d"));
    const storeIds = await accessibleStoreIdsFor(req.auth!.userId, req.auth!.organizationId);
    const stores = await prisma.store.findMany({ where: { id: { in: storeIds } } });
    const perStore = await withStoreContext(
      storeIds,
      (tx) => Promise.all(stores.map((s) => storeSummary(tx, s.id, since))),
      { timeoutMs: 20000 }
    );
    res.json({
      data: {
        range: req.query.range ?? "7d",
        stores: stores.map((s, i) => ({ id: s.id, name: s.name, ...perStore[i] })),
      },
    });
  })
);

// GET /v1/stores/:storeId/reports/daily?from=&to=
analyticsRouter.get(
  "/stores/:storeId/reports/daily",
  authenticate,
  requireStoreAccess(),
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  asyncHandler(async (req, res) => {
    const since = req.query.from ? new Date(String(req.query.from)) : rangeStart("7d");
    const summary = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      storeSummary(tx, req.storeAccess!.storeId, since)
    );
    res.json({ data: summary });
  })
);
