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
          // Cost rides along on the aggregate that already scans exactly
          // these rows — a _sum on the same GROUP BY is free next to the
          // _count. Adding a fourth query (or, worse, re-introducing a
          // per-store loop) is what made this endpoint time out before; the
          // constant-query-count property is the whole point of this shape.
          tx.aiResponseLog.groupBy({
            by: ["storeId", "actionTaken"],
            where: {
              storeId: { in: storeIds },
              // "flagged_for_review" is included for COST only, not for the
              // rates: a medium-confidence reply is logged under that action
              // and still burned real provider tokens, so leaving it out
              // would under-report spend on exactly the stores whose
              // knowledge base is weakest. The rate maps below are populated
              // per explicit actionTaken, so the reported percentages are
              // byte-for-byte what they were before cost was added.
              actionTaken: { in: ["answered", "escalated_to_human", "flagged_for_review"] },
              createdAt: { gte: since },
            },
            _count: true,
            _sum: { costMicroUsd: true },
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
        const cost = new Map<string, number>();
        for (const g of logGroups) {
          if (g.actionTaken === "answered") answered.set(g.storeId, g._count);
          else if (g.actionTaken === "escalated_to_human") escalated.set(g.storeId, g._count);
          // Every action contributes to spend, so accumulate across all of
          // this store's groups rather than overwriting per action.
          cost.set(g.storeId, (cost.get(g.storeId) ?? 0) + Number(g._sum.costMicroUsd ?? 0));
        }
        const openTickets = new Map<string, number>(ticketGroups.map((g) => [g.storeId, g._count]));
        return { conversations, answered, escalated, openTickets, cost };
      },
      { timeoutMs: 20000 }
    );

    const storeRows = stores.map((s) => {
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
        // Micro-USD, matching how it is stored (see lib/llmPricing.ts for
        // why it is not dollars or cents). Deliberately NOT converted to a
        // display unit here — the client formats it, so the API stays the
        // exact integer that reconciles against the provider invoice.
        // Number() guards the response: JSON.stringify throws outright on a
        // BigInt, which would turn a reporting page into a 500.
        costMicroUsd: Number(agg.cost.get(s.id) ?? 0),
      };
    });

    res.json({
      data: {
        range: req.query.range ?? "7d",
        stores: storeRows,
        // Org-wide roll-up so the owner sees total AI spend for the range
        // without the dashboard having to re-add the rows itself.
        totals: { costMicroUsd: storeRows.reduce((sum, r) => sum + r.costMicroUsd, 0) },
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
            // The reason, not just the colour: a red row that cannot say
            // WHY sends the owner back to guessing. Written by
            // channelHealth.ts as `[reason] عربي` — never Meta's raw body.
            lastError: true,
            lastErrorAt: true,
            tokenExpiresAt: true,
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
        lastError: r.lastError,
        lastErrorAt: r.lastErrorAt,
        tokenExpiresAt: r.tokenExpiresAt,
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
