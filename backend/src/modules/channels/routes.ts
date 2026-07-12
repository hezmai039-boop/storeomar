import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { buildPageMeta, decodeCursor } from "../../lib/pagination";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { getAdapter } from "./adapters/registry";
import { getIdempotentReplay, storeIdempotentResponse } from "../../lib/idempotency";
import { publish, subscribeSse } from "./realtime";

export const channelsRouter = Router({ mergeParams: true });
channelsRouter.use(authenticate, requireStoreAccess());

// GET /v1/stores/:storeId/channel-accounts
channelsRouter.get(
  "/channel-accounts",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.channelAccount.findMany({
        where: { storeId: req.storeAccess!.storeId },
        include: { channelType: true },
      })
    );
    res.json({
      data: rows.map(({ credentialsEncrypted, ...rest }) => rest), // never return secrets
    });
  })
);

const createChannelSchema = z.object({
  channelTypeKey: z.enum(["whatsapp", "instagram", "messenger", "tiktok", "mock"]),
  externalAccountId: z.string().min(1),
  displayName: z.string().min(1),
  credentials: z.record(z.unknown()),
});

// POST /v1/stores/:storeId/channel-accounts — docs/04-user-flows.md §6
channelsRouter.post(
  "/channel-accounts",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = createChannelSchema.parse(req.body);
    const created = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const channelType = await tx.channelType.findUniqueOrThrow({ where: { key: body.channelTypeKey } });
      // Meta's webhook setup (WhatsApp/Instagram/Messenger) requires a
      // verify token the developer pastes into their app dashboard during
      // the GET handshake — generated here since the platform, not the
      // user, is the source of truth for it (see the GET handler in
      // webhook.ts). Shown once in this response; not a secret used for
      // authenticating outbound calls, only for confirming *this* endpoint
      // during setup, so returning it is safe.
      const webhookVerifyToken = crypto.randomBytes(24).toString("hex");
      const account = await tx.channelAccount.create({
        data: {
          storeId: req.storeAccess!.storeId,
          channelTypeId: channelType.id,
          externalAccountId: body.externalAccountId,
          displayName: body.displayName,
          credentialsEncrypted: encryptSecret(JSON.stringify(body.credentials)),
          webhookVerifyToken,
          status: "connected",
          connectedAt: new Date(),
        },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "channel.connected",
        entityType: "channel_account",
        entityId: account.id,
        after: { channelTypeKey: body.channelTypeKey, displayName: body.displayName },
      });
      const { credentialsEncrypted, ...safe } = account;
      return safe;
    });
    res.status(201).json({ data: created });
  })
);

const verifySchema = z.object({ testRecipientExternalId: z.string().min(1) });

// POST /v1/stores/:storeId/channel-accounts/:id/verify — sends a real test
// message through the adapter before the channel is trusted for customers.
channelsRouter.post(
  "/channel-accounts/:id/verify",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body);
    const result = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const account = await tx.channelAccount.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
        include: { channelType: true },
      });
      const adapter = getAdapter(account.channelType.adapterKey);
      const credentials = JSON.parse(decryptSecret(account.credentialsEncrypted));
      try {
        await adapter.sendMessage(credentials, {
          toExternalId: body.testRecipientExternalId,
          text: "رسالة اختبار من منصة Atlas — القناة متصلة بنجاح.",
        });
        return tx.channelAccount.update({ where: { id: account.id }, data: { status: "connected" } });
      } catch (err) {
        await tx.channelAccount.update({ where: { id: account.id }, data: { status: "error" } });
        throw ApiError.badRequest(`فشل اختبار القناة: ${(err as Error).message}`);
      }
    });
    const { credentialsEncrypted, ...safe } = result;
    res.json({ data: safe });
  })
);

// DELETE /v1/stores/:storeId/channel-accounts/:id
channelsRouter.delete(
  "/channel-accounts/:id",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      await tx.channelAccount.update({
        where: { id: req.params.id },
        data: { status: "disconnected" },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "channel.disconnected",
        entityType: "channel_account",
        entityId: req.params.id,
      });
    });
    res.status(204).send();
  })
);

// GET /v1/stores/:storeId/conversations?status=&channel=&cursor=
channelsRouter.get(
  "/conversations",
  requirePermission(PERMISSIONS.CONVERSATIONS_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.conversation.findMany({
        where: {
          storeId: req.storeAccess!.storeId,
          ...(req.query.status ? { status: String(req.query.status) } : {}),
          ...(req.query.channel ? { channelAccount: { channelType: { key: String(req.query.channel) } } } : {}),
        },
        include: {
          customer: true,
          // select (not include) — a nested include here would leak
          // channel_accounts.credentials_encrypted straight into the API
          // response, which must never happen (docs/01-database-design.md §3).
          channelAccount: { select: { id: true, displayName: true, channelType: true } },
        },
        orderBy: { lastMessageAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);

// GET /v1/stores/:storeId/conversations/:id/messages?cursor=
channelsRouter.get(
  "/conversations/:id/messages",
  requirePermission(PERMISSIONS.CONVERSATIONS_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 50);
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.message.findMany({
        where: { conversationId: req.params.id, storeId: req.storeAccess!.storeId },
        orderBy: { createdAt: "asc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);

const replySchema = z.object({ text: z.string().min(1) });

// POST /v1/stores/:storeId/conversations/:id/messages — the agent's reply,
// idempotent per docs/06-api-design.md §0.
channelsRouter.post(
  "/conversations/:id/messages",
  requirePermission(PERMISSIONS.CONVERSATIONS_REPLY),
  asyncHandler(async (req, res) => {
    const idemKey = req.header("Idempotency-Key");
    const replay = getIdempotentReplay(idemKey);
    if (replay) return res.status(replay.status).json(replay.body);

    const body = replySchema.parse(req.body);
    const result = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const conversation = await tx.conversation.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
        include: { channelAccount: { include: { channelType: true } }, customer: true },
      });

      const adapter = getAdapter(conversation.channelAccount.channelType.adapterKey);
      const credentials = JSON.parse(decryptSecret(conversation.channelAccount.credentialsEncrypted));
      const sent = await adapter.sendMessage(credentials, {
        toExternalId: conversation.customer.externalId,
        text: body.text,
      });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          storeId: req.storeAccess!.storeId,
          senderType: "agent",
          senderUserId: req.auth!.userId,
          content: body.text,
          externalMessageId: sent.externalMessageId,
        },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });

      // Learning loop (docs/04-user-flows.md §3 step 5): a human stepping in
      // to answer something the AI didn't handle with high confidence is
      // exactly the signal worth turning into a reviewable suggestion —
      // never auto-applied, always pending_review (docs/02-architecture.md §4).
      if (conversation.aiConfidenceLevel !== "high") {
        const lastCustomerMessage = await tx.message.findFirst({
          where: { conversationId: conversation.id, senderType: "customer" },
          orderBy: { createdAt: "desc" },
        });
        if (lastCustomerMessage) {
          await tx.aiSuggestedKnowledge.create({
            data: {
              storeId: req.storeAccess!.storeId,
              conversationId: conversation.id,
              content: `س: ${lastCustomerMessage.content}\nج: ${body.text}`,
              status: "pending_review",
            },
          });
        }
      }

      return message;
    });

    publish(req.storeAccess!.storeId, { type: "message.created", conversationId: req.params.id, messageId: result.id });
    const responseBody = { data: result };
    storeIdempotentResponse(idemKey, 201, responseBody);
    res.status(201).json(responseBody);
  })
);

// POST /v1/stores/:storeId/conversations/:id/summarize
channelsRouter.post(
  "/conversations/:id/summarize",
  requirePermission(PERMISSIONS.CONVERSATIONS_VIEW),
  asyncHandler(async (req, res) => {
    const summary = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const messages = await tx.message.findMany({
        where: { conversationId: req.params.id, storeId: req.storeAccess!.storeId },
        orderBy: { createdAt: "asc" },
      });
      if (messages.length === 0) throw ApiError.notFound("المحادثة");
      // Simple extractive fallback; upgrades automatically once ANTHROPIC_API_KEY
      // is set, same pluggable seam as aiPipeline.ts.
      const { generateGroundedAnswer } = await import("../../lib/llm");
      const transcript = messages.map((m) => `${m.senderType}: ${m.content}`).join("\n");
      const llmSummary = await generateGroundedAnswer({
        storeName: "",
        persona: {},
        knowledgeContext: "",
        question: `لخّص هذه المحادثة في جملتين للموظف:\n${transcript}`,
      });
      return llmSummary ?? `آخر ${messages.length} رسائل: ${messages[messages.length - 1].content}`;
    });
    res.json({ data: { summary } });
  })
);

// GET /v1/stores/:storeId/realtime — SSE (docs/06-api-design.md §3)
channelsRouter.get(
  "/realtime",
  requirePermission(PERMISSIONS.CONVERSATIONS_VIEW),
  (req, res) => {
    subscribeSse(req.storeAccess!.storeId, res);
  }
);
