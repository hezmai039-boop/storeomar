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
//
// Scales to any number of stores: instead of N×4 count queries in a loop
// (which timed out the transaction — and left the UI stuck on "جار
// التحميل" — once an org had many stores), this issues exactly THREE grouped
// aggregates over the whole store-id set, then assembles per-store rows in
// memory. Cost is constant in the number of stores; the GROUP BYs ride the
// storeId/composite indexes added to these tables.
analyticsRouter.get(
  "/organizations/:orgId/reports/overview",
  authenticate,
  requireOwner(),
  asyncHandler(async (req, res) => {
    const since = rangeStart(String(req.query.range ?? "7d"));
    const storeIds = await accessibleStoreIdsFor(req.auth!.userId, req.auth!.organizationId);
    const stores = await prisma.store.findMany({ where: { id: { in: storeIds } }, orderBy: { name: "asc" } });

    const agg = await withStoreContext(
      storeIds,
      async (tx) => {
        const [convGroups, logGroups, ticketGroups] = await Promise.all([
          tx.conversation.groupBy({
            by: ["storeId"],
            where: { storeId: { in: storeIds }, createdAt: { gte: since } },
            _count: true,
          }),
          tx.aiResponseLog.groupBy({
            by: ["storeId", "actionTaken"],
            where: {
              storeId: { in: storeIds },
              actionTaken: { in: ["answered", "escalated_to_human"] },
              createdAt: { gte: since },
            },
            _count: true,
          }),
          tx.ticket.groupBy({
            by: ["storeId"],
            where: { storeId: { in: storeIds }, status: { in: ["open", "in_progress"] } },
            _count: true,
          }),
        ]);

        const conversations = new Map<string, number>(convGroups.map((g) => [g.storeId, g._count]));
        const answered = new Map<string, number>();
        const escalated = new Map<string, number>();
        for (const g of logGroups) {
          (g.actionTaken === "answered" ? answered : escalated).set(g.storeId, g._count);
        }
        const openTickets = new Map<string, number>(ticketGroups.map((g) => [g.storeId, g._count]));
        return { conversations, answered, escalated, openTickets };
      },
      { timeoutMs: 20000 }
    );

    res.json({
      data: {
        range: req.query.range ?? "7d",
        stores: stores.map((s) => {
          const a = agg.answered.get(s.id) ?? 0;
          const e = agg.escalated.get(s.id) ?? 0;
          const handled = a + e;
          return {
            id: s.id,
            name: s.name,
            storeId: s.id,
            totalConversations: agg.conversations.get(s.id) ?? 0,
            aiResolvedRate: handled > 0 ? Math.round((a / handled) * 100) : 0,
            escalationRate: handled > 0 ? Math.round((e / handled) * 100) : 0,
            openTickets: agg.openTickets.get(s.id) ?? 0,
          };
        }),
      },
    });
  })
);

// GET /v1/organizations/:orgId/reports/channel-health — owner's at-a-glance
// operational view of every store's connected channels. The point is to
// surface an expired/errored WhatsApp token on ANY store immediately (it
// shows as status "error"/"disconnected"), so the owner knows to rotate
// credentials (Settings → تحديث بيانات الاعتماد) before customers are hit
// by silent delivery failures. Credentials are never included — only the
// account's public status/identity fields.
analyticsRouter.get(
  "/organizations/:orgId/reports/channel-health",
  authenticate,
  requireOwner(),
  asyncHandler(async (req, res) => {
    const storeIds = await accessibleStoreIdsFor(req.auth!.userId, req.auth!.organizationId);
    const stores = await prisma.store.findMany({ where: { id: { in: storeIds } }, orderBy: { name: "asc" } });
    const rows = await withStoreContext(
      storeIds,
      (tx) =>
        tx.channelAccount.findMany({
          where: { storeId: { in: storeIds } },
          select: {
            id: true,
            storeId: true,
            displayName: true,
            status: true,
            externalAccountId: true,
            connectedAt: true,
            channelType: { select: { key: true } },
          },
        }),
      { timeoutMs: 20000 }
    );
    const byStore = new Map(stores.map((s) => [s.id, { id: s.id, name: s.name, channels: [] as unknown[] }]));
    for (const r of rows) {
      byStore.get(r.storeId)?.channels.push({
        id: r.id,
        displayName: r.displayName,
        channelType: r.channelType.key,
        status: r.status,
        externalAccountId: r.externalAccountId,
        connectedAt: r.connectedAt,
      });
    }
    res.json({ data: { stores: Array.from(byStore.values()) } });
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
