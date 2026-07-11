import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { buildPageMeta, decodeCursor } from "../../lib/pagination";

export const knowledgeRouter = Router({ mergeParams: true });
knowledgeRouter.use(authenticate, requireStoreAccess());

function chunkText(raw: string): string[] {
  return raw
    .split(/\n{2,}|(?<=[.!؟])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const createSourceSchema = z.object({
  type: z.enum(["pdf", "word", "excel", "faq", "webpage", "product", "shipping_policy", "return_policy", "chat_history"]),
  title: z.string().min(1),
  rawText: z.string().min(1).optional(),
  fileUrl: z.string().url().optional(),
});

// GET /v1/stores/:storeId/knowledge/sources
knowledgeRouter.get(
  "/sources",
  requirePermission(PERMISSIONS.KNOWLEDGE_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.knowledgeSource.findMany({
        where: { storeId: req.storeAccess!.storeId },
        include: { _count: { select: { chunks: true } } },
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);

// POST /v1/stores/:storeId/knowledge/sources — active immediately; this is
// the manager-authored path, distinct from AI suggestions below which
// always require approval (docs/04-user-flows.md §5).
knowledgeRouter.post(
  "/sources",
  requirePermission(PERMISSIONS.KNOWLEDGE_MANAGE),
  asyncHandler(async (req, res) => {
    const body = createSourceSchema.parse(req.body);
    const created = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const source = await tx.knowledgeSource.create({
        data: {
          storeId: req.storeAccess!.storeId,
          type: body.type,
          title: body.title,
          rawText: body.rawText,
          fileUrl: body.fileUrl,
          status: "active",
          createdBy: req.auth!.userId,
        },
      });
      if (body.rawText) {
        const chunks = chunkText(body.rawText);
        await tx.knowledgeChunk.createMany({
          data: chunks.map((content) => ({ storeId: req.storeAccess!.storeId, sourceId: source.id, content })),
        });
      }
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "knowledge.source.created",
        entityType: "knowledge_source",
        entityId: source.id,
        after: { title: source.title, type: source.type },
      });
      return source;
    });
    res.status(201).json({ data: created });
  })
);

// DELETE /v1/stores/:storeId/knowledge/sources/:id
knowledgeRouter.delete(
  "/sources/:id",
  requirePermission(PERMISSIONS.KNOWLEDGE_MANAGE),
  asyncHandler(async (req, res) => {
    await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { sourceId: req.params.id, storeId: req.storeAccess!.storeId } });
      await tx.knowledgeSource.updateMany({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
        data: { status: "archived" },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "knowledge.source.archived",
        entityType: "knowledge_source",
        entityId: req.params.id,
      });
    });
    res.status(204).send();
  })
);

// GET /v1/stores/:storeId/knowledge/suggestions?status=pending_review
knowledgeRouter.get(
  "/suggestions",
  requirePermission(PERMISSIONS.KNOWLEDGE_VIEW),
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) ?? "pending_review";
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.aiSuggestedKnowledge.findMany({
        where: { storeId: req.storeAccess!.storeId, status },
        orderBy: { createdAt: "desc" },
      })
    );
    res.json({ data: rows });
  })
);

// POST /v1/stores/:storeId/knowledge/suggestions/:id/approve — indexes
// immediately, no partial edit (docs/04-user-flows.md §5 step 4).
knowledgeRouter.post(
  "/suggestions/:id/approve",
  requirePermission(PERMISSIONS.KNOWLEDGE_APPROVE),
  asyncHandler(async (req, res) => {
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const suggestion = await tx.aiSuggestedKnowledge.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
      });
      const source = await tx.knowledgeSource.create({
        data: {
          storeId: req.storeAccess!.storeId,
          type: "chat_history",
          title: "معتمد من محادثة موظف",
          rawText: suggestion.content,
          status: "active",
          createdBy: req.auth!.userId,
        },
      });
      await tx.knowledgeChunk.create({
        data: { storeId: req.storeAccess!.storeId, sourceId: source.id, content: suggestion.content },
      });
      const result = await tx.aiSuggestedKnowledge.update({
        where: { id: suggestion.id },
        data: { status: "approved", reviewedBy: req.auth!.userId, reviewedAt: new Date() },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "knowledge.suggestion.approved",
        entityType: "ai_suggested_knowledge",
        entityId: suggestion.id,
      });
      return result;
    });
    res.json({ data: updated });
  })
);

// POST /v1/stores/:storeId/knowledge/suggestions/:id/reject
knowledgeRouter.post(
  "/suggestions/:id/reject",
  requirePermission(PERMISSIONS.KNOWLEDGE_APPROVE),
  asyncHandler(async (req, res) => {
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const result = await tx.aiSuggestedKnowledge.update({
        where: { id: req.params.id },
        data: { status: "rejected", reviewedBy: req.auth!.userId, reviewedAt: new Date() },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "knowledge.suggestion.rejected",
        entityType: "ai_suggested_knowledge",
        entityId: req.params.id,
      });
      return result;
    });
    res.json({ data: updated });
  })
);

// GET /v1/stores/:storeId/ai-agent
knowledgeRouter.get(
  "/ai-agent",
  requirePermission(PERMISSIONS.KNOWLEDGE_VIEW),
  asyncHandler(async (req, res) => {
    const agent = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.aiAgent.findUnique({ where: { storeId: req.storeAccess!.storeId } })
    );
    if (!agent) throw ApiError.notFound("وكيل الذكاء الاصطناعي");
    res.json({ data: agent });
  })
);

const updateAgentSchema = z.object({
  persona: z.record(z.unknown()).optional(),
  confidenceThresholdHigh: z.number().min(0).max(1).optional(),
  confidenceThresholdLow: z.number().min(0).max(1).optional(),
});

// PATCH /v1/stores/:storeId/ai-agent
knowledgeRouter.patch(
  "/ai-agent",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateAgentSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.aiAgent.update({
        where: { storeId: req.storeAccess!.storeId },
        data: { ...body, persona: body.persona as Prisma.InputJsonValue | undefined },
      })
    );
    res.json({ data: updated });
  })
);
