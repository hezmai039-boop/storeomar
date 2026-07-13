import { Router } from "express";
import { z } from "zod";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { buildPageMeta, decodeCursor } from "../../lib/pagination";
import { createTicketFromConversation } from "../tickets/service";
import { ensureDefaultSpecialists } from "./specialists";
import { listToolCatalog } from "./tools/registry";
import { gatherOrchestratorContext, completeOrchestratorRun } from "./orchestrator";
import { getCustomerMemory } from "./memory";

export const aiIntelligenceRouter = Router({ mergeParams: true });
aiIntelligenceRouter.use(authenticate, requireStoreAccess());

// GET /v1/stores/:storeId/ai-intelligence/specialists
aiIntelligenceRouter.get(
  "/specialists",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_VIEW),
  asyncHandler(async (req, res) => {
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      await ensureDefaultSpecialists(tx, req.storeAccess!.storeId);
      return tx.aiSpecialist.findMany({ where: { storeId: req.storeAccess!.storeId }, orderBy: { key: "asc" } });
    });
    res.json({ data: rows });
  })
);

const updateSpecialistSchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  allowedTools: z.array(z.string()).optional(),
  isEnabled: z.boolean().optional(),
});

// PATCH /v1/stores/:storeId/ai-intelligence/specialists/:key — lets a store
// customize an agent's persona/tools without any code change, per the
// "كل Agent يمتلك Prompt/Tools/Policies" requirement.
aiIntelligenceRouter.patch(
  "/specialists/:key",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateSpecialistSchema.parse(req.body);
    const validToolKeys = new Set(listToolCatalog().map((t) => t.key));
    if (body.allowedTools) {
      const unknown = body.allowedTools.filter((k) => !validToolKeys.has(k));
      if (unknown.length > 0) throw ApiError.badRequest(`أدوات غير معروفة: ${unknown.join(", ")}`);
    }

    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      await ensureDefaultSpecialists(tx, req.storeAccess!.storeId);
      const existing = await tx.aiSpecialist.findFirst({
        where: { storeId: req.storeAccess!.storeId, key: req.params.key },
      });
      if (!existing) throw ApiError.notFound("الوكيل المتخصص");

      const result = await tx.aiSpecialist.update({
        where: { id: existing.id },
        data: body,
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "ai_intelligence.specialist.updated",
        entityType: "ai_specialist",
        entityId: existing.id,
        before: { name: existing.name, isEnabled: existing.isEnabled, allowedTools: existing.allowedTools },
        after: { name: result.name, isEnabled: result.isEnabled, allowedTools: result.allowedTools },
      });
      return result;
    });
    res.json({ data: updated });
  })
);

// GET /v1/stores/:storeId/ai-intelligence/tools — static code-defined
// catalog, same for every store (per-specialist enablement is what
// varies, via ai_specialists.allowed_tools above).
aiIntelligenceRouter.get(
  "/tools",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_VIEW),
  asyncHandler(async (_req, res) => {
    res.json({ data: listToolCatalog() });
  })
);

const askSchema = z.object({
  conversationId: z.string().uuid(),
  question: z.string().min(1),
});

// POST /v1/stores/:storeId/ai-intelligence/ask — runs the orchestrator
// against an existing conversation. This is the live agent test console
// (docs/12-ux-ui-benchmark-and-proposal.md §4.4) and the entry point a
// future opt-in wiring into the live channel webhook would reuse — the
// webhook path itself (src/modules/channels/webhook.ts) is not touched by
// this change, so nothing about the current live flow is affected.
aiIntelligenceRouter.post(
  "/ask",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_VIEW),
  asyncHandler(async (req, res) => {
    const body = askSchema.parse(req.body);
    const storeId = req.storeAccess!.storeId;

    const conversation = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.conversation.findFirst({
        where: { id: body.conversationId, storeId },
        include: { store: { select: { name: true, organizationId: true } } },
      })
    );
    if (!conversation) throw ApiError.notFound("المحادثة");

    // Phase 1 (short transaction, DB reads only) — mirrors
    // gatherAiContext/completeAiPipeline's split in aiPipeline.ts.
    const context = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      gatherOrchestratorContext(tx, {
        storeId,
        storeName: conversation.store.name,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        organizationId: conversation.store.organizationId,
        question: body.question,
      })
    );

    // Phase 2 (network, no transaction open) — the tool-calling agent loop.
    const result = await completeOrchestratorRun(context);

    // Phase 3 (short transaction) — auto-escalate to a ticket if the
    // agent didn't already do so itself via the CreateEscalationTicket
    // tool, same "escalate over guessing" outcome as the confidence gate.
    const alreadyEscalated = result.toolCalls.some((c) => c.toolKey === "CreateEscalationTicket");
    if (result.escalate && !alreadyEscalated) {
      await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
        createTicketFromConversation(tx, {
          storeId,
          organizationId: conversation.store.organizationId,
          conversationId: conversation.id,
          customerId: conversation.customerId,
          actorUserId: req.auth!.userId,
          escalationReason: "طبقة الذكاء الاصطناعي: ثقة منخفضة في الإجابة",
        })
      );
    }

    res.json({
      data: {
        replyText: result.replyText,
        confidence: result.confidence,
        escalate: result.escalate,
        specialist: context.specialist.key,
        toolCalls: result.toolCalls,
      },
    });
  })
);

// GET /v1/stores/:storeId/ai-intelligence/memory/customers/:customerId
aiIntelligenceRouter.get(
  "/memory/customers/:customerId",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_VIEW),
  asyncHandler(async (req, res) => {
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      getCustomerMemory(tx, req.storeAccess!.storeId, req.params.customerId)
    );
    res.json({ data: rows });
  })
);

// GET /v1/stores/:storeId/ai-intelligence/runs — orchestrator run log
// (observability), cursor-paginated like every other list endpoint.
aiIntelligenceRouter.get(
  "/runs",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.aiOrchestratorRun.findMany({
        where: { storeId: req.storeAccess!.storeId },
        orderBy: { id: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);

// GET /v1/stores/:storeId/ai-intelligence/tool-invocations — full audit
// trail of every tool call (the "AI Trust" logging requirement).
aiIntelligenceRouter.get(
  "/tool-invocations",
  requirePermission(PERMISSIONS.AI_INTELLIGENCE_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.aiToolInvocation.findMany({
        where: { storeId: req.storeAccess!.storeId },
        orderBy: { id: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);
