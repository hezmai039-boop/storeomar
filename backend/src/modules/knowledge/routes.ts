import { Router } from "express";
import multer from "multer";
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
import { extractText, validateMimeMatchesType } from "./fileExtraction";
import { readStoredFile, saveUploadedFile } from "../../lib/fileStorage";

export const knowledgeRouter = Router({ mergeParams: true });
knowledgeRouter.use(authenticate, requireStoreAccess());

// 10MB cap, memory storage — files are small policy/FAQ/catalog documents,
// not media; we extract text immediately and only then write to disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Splits on blank-line paragraph breaks, and on sentence-ending
// punctuation *within* a line — but deliberately NOT across a single line
// break. That distinction matters for the common "س: سؤال؟\nج: جواب"
// knowledge-entry shape: the "؟" ending the question sits right before a
// single newline, and the old `\s+` (which also matches newlines) split
// the question into its own chunk, orphaned from its answer — a real
// store's AI ended up literally echoing the customer's own question back
// as the "answer" it retrieved. Restricting the post-punctuation split to
// horizontal whitespace keeps a question and its answer in one chunk,
// while still splitting genuinely separate sentences typed on the same
// line, and paragraphs still split on blank lines as before.
export function chunkText(raw: string): string[] {
  return raw
    .split(/\n{2,}|(?<=[.!؟])[ \t]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SOURCE_TYPES = [
  "pdf",
  "word",
  "excel",
  "faq",
  "webpage",
  "product",
  "shipping_policy",
  "return_policy",
  "chat_history",
] as const;

const createSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  title: z.string().min(1),
  rawText: z.string().min(1).optional(),
});

// GET /v1/stores/:storeId/knowledge/sources — defaults to hiding archived
// (soft-deleted) sources so a deleted entry actually disappears from the
// list instead of lingering with a stale badge; pass ?status=all to see
// everything, or ?status=<value> for an exact match.
knowledgeRouter.get(
  "/sources",
  requirePermission(PERMISSIONS.KNOWLEDGE_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);
    const statusQuery = req.query.status as string | undefined;
    const statusFilter = statusQuery === "all" ? {} : statusQuery ? { status: statusQuery } : { status: { not: "archived" } };
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.knowledgeSource.findMany({
        where: { storeId: req.storeAccess!.storeId, ...statusFilter },
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
//
// Accepts EITHER:
//  - multipart/form-data with a `file` field (pdf/word/excel) — text is
//    extracted server-side and the original file is kept for reference, or
//  - a JSON body with `rawText` (faq/webpage/product/policy text pasted directly).
// multer only engages for multipart requests; a JSON request passes through
// untouched and req.body is whatever express.json() already parsed.
knowledgeRouter.post(
  "/sources",
  requirePermission(PERMISSIONS.KNOWLEDGE_MANAGE),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const body = createSourceSchema.parse(req.body);
    const file = req.file;

    if (!file && !body.rawText) {
      throw ApiError.badRequest("أرفق ملفًا أو أدخل نصًا — لا يمكن ترك المصدر فارغًا");
    }
    if (file) {
      validateMimeMatchesType(body.type, file.mimetype);
    }

    const created = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      let extractedText = body.rawText;
      let fileUrl: string | undefined;

      if (file) {
        extractedText = await extractText(file.buffer, body.type);
        if (!extractedText.trim()) {
          throw ApiError.badRequest("لم يُستخرَج أي نص قابل للقراءة من هذا الملف");
        }
        fileUrl = saveUploadedFile(req.storeAccess!.storeId, file.originalname, file.buffer);
      }

      const source = await tx.knowledgeSource.create({
        data: {
          storeId: req.storeAccess!.storeId,
          type: body.type,
          title: body.title,
          rawText: extractedText,
          fileUrl,
          status: "active",
          createdBy: req.auth!.userId,
        },
      });
      if (extractedText) {
        const chunks = chunkText(extractedText);
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
        after: { title: source.title, type: source.type, chunkCount: extractedText ? chunkText(extractedText).length : 0 },
      });
      return source;
    });
    res.status(201).json({ data: created });
  })
);

// GET /v1/stores/:storeId/knowledge/sources/:id/file — download the
// original uploaded document (RBAC-gated, not a public static mount).
knowledgeRouter.get(
  "/sources/:id/file",
  requirePermission(PERMISSIONS.KNOWLEDGE_VIEW),
  asyncHandler(async (req, res) => {
    const source = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.knowledgeSource.findFirst({ where: { id: req.params.id, storeId: req.storeAccess!.storeId } })
    );
    if (!source?.fileUrl) throw ApiError.notFound("الملف");
    const buffer = readStoredFile(source.fileUrl);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(source.title)}"`);
    res.send(buffer);
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
  advancedIntelligenceEnabled: z.boolean().optional(),
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
