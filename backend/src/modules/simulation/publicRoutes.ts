import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { simulationRateLimiter } from "../../lib/rateLimit";
import { gatherAiContext, completeAiPipeline } from "../knowledge/aiPipeline";
import { createTicketFromConversation } from "../tickets/service";
import { publish } from "../channels/realtime";
import { resolveSimulationLink, ensureSimulationChannelAccount } from "./service";

// Fully public — no authenticate/requireStoreAccess. The token in the URL
// is the only credential (see resolveSimulationLink). This mirrors
// modules/channels/webhook.ts's shape deliberately: same DB/network phase
// split, same aiPipeline.ts call, so a store owner testing here sees
// EXACTLY what a real inbound WhatsApp message would produce today — no
// separate, possibly-drifted "demo" logic path.
export const simulationPublicRouter = Router();

// GET /v1/public/simulate/:token — resolve the link before the chat UI
// renders, so it can show "أنت تتحدث مع متجر X" or a clean "link expired"
// state instead of guessing.
simulationPublicRouter.get(
  "/:token",
  simulationRateLimiter,
  asyncHandler(async (req, res) => {
    const resolved = await resolveSimulationLink(req.params.token);
    if (!resolved) return res.status(404).json({ error: { code: "NOT_FOUND", message: "رابط غير صالح أو مُعطَّل", details: {} } });
    res.json({ data: { storeName: resolved.storeName, label: resolved.label } });
  })
);

const sendMessageSchema = z.object({
  visitorId: z.string().uuid().optional(),
  visitorName: z.string().max(80).optional(),
  text: z.string().min(1).max(2000),
});

// POST /v1/public/simulate/:token/messages
simulationPublicRouter.post(
  "/:token/messages",
  simulationRateLimiter,
  asyncHandler(async (req, res) => {
    const resolved = await resolveSimulationLink(req.params.token);
    if (!resolved) return res.status(404).json({ error: { code: "NOT_FOUND", message: "رابط غير صالح أو مُعطَّل", details: {} } });

    const body = sendMessageSchema.parse(req.body);
    // First message from a new browser has no visitorId yet — mint one and
    // hand it back so the client persists it (localStorage) for every
    // later call. Each visitorId is its own customer row, so concurrent
    // testers sharing the same link never see each other's conversation.
    const visitorId = body.visitorId ?? randomUUID();

    // Phase 1 (short transaction): persist the inbound message — same
    // shape as webhook.ts Phase 1, using upsert on the same unique key
    // (storeId, channelAccountId, externalId) so a returning visitor
    // resumes their one conversation instead of forking a new one.
    const { customer, conversation, inboundMsgId } = await withStoreContext([resolved.storeId], async (tx) => {
      const account = await ensureSimulationChannelAccount(tx, resolved.storeId);

      const customer = await tx.customer.upsert({
        where: {
          storeId_channelAccountId_externalId: {
            storeId: resolved.storeId,
            channelAccountId: account.id,
            externalId: visitorId,
          },
        },
        create: {
          storeId: resolved.storeId,
          channelAccountId: account.id,
          externalId: visitorId,
          name: body.visitorName ?? "زائر محاكاة",
        },
        update: {},
      });

      let conversation = await tx.conversation.findFirst({
        where: { storeId: resolved.storeId, customerId: customer.id, status: { in: ["open", "pending"] } },
      });
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: { storeId: resolved.storeId, channelAccountId: account.id, customerId: customer.id },
        });
      }

      const inboundMsg = await tx.message.create({
        data: {
          conversationId: conversation.id,
          storeId: resolved.storeId,
          senderType: "customer",
          content: body.text,
        },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return { customer, conversation, inboundMsgId: inboundMsg.id };
    });
    publish(resolved.storeId, { type: "message.created", conversationId: conversation.id, messageId: inboundMsgId });

    // Phase 2 (short transaction, DB reads only): identical call to
    // webhook.ts's Phase 2 — the same confidence gate, same knowledge
    // base, same agent persona/thresholds a real message would use.
    const context = await withStoreContext([resolved.storeId], (tx) =>
      gatherAiContext(tx, { storeId: resolved.storeId, question: body.text })
    );

    // Phase 3 (network, no transaction open): identical call to
    // webhook.ts's Phase 3.
    const result = await completeAiPipeline(context, { storeName: resolved.storeName, question: body.text });

    // Phase 4 (short transaction): persist the outcome — identical to
    // webhook.ts's Phase 4, including real ticket escalation, so a
    // low-confidence test question shows up as a real ticket for staff to
    // review, not a simulated one.
    const persisted = await withStoreContext([resolved.storeId], async (tx) => {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { aiConfidenceLevel: result.confidenceLevel },
      });

      let aiMsgId: string | null = null;
      if (result.replyText) {
        const aiMsg = await tx.message.create({
          data: {
            conversationId: conversation.id,
            storeId: resolved.storeId,
            senderType: "ai",
            content: result.replyText,
          },
        });
        aiMsgId = aiMsg.id;
        await tx.aiResponseLog.create({
          data: {
            storeId: resolved.storeId,
            conversationId: conversation.id,
            messageId: aiMsg.id,
            confidenceLevel: result.confidenceLevel,
            actionTaken: result.confidenceLevel === "high" ? "answered" : "flagged_for_review",
          },
        });
      }

      if (result.createTicket) {
        await tx.conversation.update({ where: { id: conversation.id }, data: { status: "pending" } });
        await createTicketFromConversation(tx, {
          storeId: resolved.storeId,
          organizationId: resolved.organizationId,
          conversationId: conversation.id,
          customerId: customer.id,
          actorUserId: null,
          priority: "medium",
          escalationReason: result.escalationReason,
        });
        await tx.aiResponseLog.create({
          data: {
            storeId: resolved.storeId,
            conversationId: conversation.id,
            confidenceLevel: result.confidenceLevel,
            actionTaken: "escalated_to_human",
          },
        });
      }
      return { aiMsgId };
    });

    if (persisted.aiMsgId) {
      publish(resolved.storeId, { type: "message.created", conversationId: conversation.id, messageId: persisted.aiMsgId });
    }

    res.json({
      data: {
        visitorId,
        replyText: result.replyText,
        confidenceLevel: result.confidenceLevel,
        escalated: result.createTicket,
      },
    });
  })
);

const historyQuerySchema = z.object({ visitorId: z.string().uuid() });

// GET /v1/public/simulate/:token/messages?visitorId=... — lets the chat
// page reload/resume a visitor's own history. Scoped strictly to that one
// visitorId's conversation; there is no way to list another visitor's
// messages through this endpoint.
simulationPublicRouter.get(
  "/:token/messages",
  simulationRateLimiter,
  asyncHandler(async (req, res) => {
    const resolved = await resolveSimulationLink(req.params.token);
    if (!resolved) return res.status(404).json({ error: { code: "NOT_FOUND", message: "رابط غير صالح أو مُعطَّل", details: {} } });

    const query = historyQuerySchema.parse(req.query);

    const messages = await withStoreContext([resolved.storeId], async (tx) => {
      const account = await ensureSimulationChannelAccount(tx, resolved.storeId);
      const customer = await tx.customer.findFirst({
        where: { storeId: resolved.storeId, channelAccountId: account.id, externalId: query.visitorId },
      });
      if (!customer) return [];
      return tx.message.findMany({
        where: { storeId: resolved.storeId, conversation: { customerId: customer.id } },
        orderBy: { createdAt: "asc" },
        select: { senderType: true, content: true, createdAt: true },
      });
    });

    res.json({ data: messages });
  })
);
