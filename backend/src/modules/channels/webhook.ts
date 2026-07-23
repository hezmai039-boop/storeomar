import { Router } from "express";
import { resolverPrisma } from "../../db/resolverClient";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { getAdapter } from "./adapters/registry";
import { gatherAiReply, completeAiReply } from "../knowledge/aiRouter";
import { createTicketFromConversation } from "../tickets/service";
import { publish } from "./realtime";
import { decryptSecret } from "../../lib/crypto";
import { webhookRateLimiter } from "../../lib/rateLimit";

export const webhooksRouter = Router();

// Meta-style app secrets are per app (shared across every connected page/
// WABA of that type), not per channel_account — unlike the account's own
// OAuth token, which IS per-account and lives encrypted in the DB.
const APP_SECRETS: Record<string, string> = {
  whatsapp: process.env.WHATSAPP_APP_SECRET ?? "",
  instagram: process.env.META_APP_SECRET ?? "",
  messenger: process.env.META_APP_SECRET ?? "",
  tiktok: process.env.TIKTOK_APP_SECRET ?? "",
  mock: process.env.MOCK_APP_SECRET ?? "dev-only-mock-secret",
};

// GET — Meta's webhook subscription handshake (hub.challenge).
webhooksRouter.get(
  "/channels/:channelTypeKey/:channelAccountId",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const account = await resolverPrisma.channelAccount.findUnique({ where: { id: req.params.channelAccountId } });
    const verifyToken = req.query["hub.verify_token"];
    // TEMPORARY debug logging — remove once WhatsApp inbound delivery is confirmed working.
    console.log(`[webhook GET] channelAccountId=${req.params.channelAccountId} accountFound=${!!account} tokenMatch=${!!account && verifyToken === account.webhookVerifyToken}`);
    if (account && verifyToken && verifyToken === account.webhookVerifyToken) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  })
);

// POST — the one unified inbound route for every channel (docs/06-api-design.md §3).
// Mounted with express.raw() upstream (src/index.ts) so req.body is the
// untouched Buffer the signature check needs.
webhooksRouter.post(
  "/channels/:channelTypeKey/:channelAccountId",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const { channelTypeKey, channelAccountId } = req.params;
    const rawBody = req.body as Buffer;

    // TEMPORARY debug logging — remove once WhatsApp inbound delivery is confirmed working.
    console.log(`[webhook POST] channelTypeKey=${channelTypeKey} channelAccountId=${channelAccountId} bodyBytes=${rawBody?.length ?? 0}`);

    const account = await resolverPrisma.channelAccount.findUnique({
      where: { id: channelAccountId },
      include: { channelType: true, store: true },
    });
    if (!account || account.channelType.key !== channelTypeKey) {
      console.log(`[webhook POST] 404 — accountFound=${!!account} typeMatch=${account?.channelType.key === channelTypeKey}`);
      return res.sendStatus(404);
    }

    const adapter = getAdapter(account.channelType.adapterKey);
    const signature =
      (req.header("x-hub-signature-256") as string | undefined) ?? (req.header("x-tiktok-signature") as string | undefined);
    const appSecret = APP_SECRETS[channelTypeKey] ?? "";

    const signatureOk = adapter.verifyWebhookSignature(rawBody, signature, appSecret);
    console.log(`[webhook POST] signatureHeaderPresent=${!!signature} appSecretConfigured=${!!appSecret} signatureOk=${signatureOk}`);
    if (!signatureOk) {
      // Invalid signature = reject before touching the database (docs/06-api-design.md §3).
      return res.sendStatus(401);
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const inboundMessages = adapter.parseWebhook(payload);
    console.log(`[webhook POST] parsedInboundMessages=${inboundMessages.length}`);

    for (const inbound of inboundMessages) {
      // Phase 1 (short transaction): persist the inbound message. Committed
      // and closed before anything that makes a network call runs — see the
      // comment on gatherAiContext in aiPipeline.ts for why.
      const { customer, conversation, inboundMsgId } = await withStoreContext([account.storeId], async (tx) => {
        const customer = await tx.customer.upsert({
          where: {
            storeId_channelAccountId_externalId: {
              storeId: account.storeId,
              channelAccountId: account.id,
              externalId: inbound.externalCustomerId,
            },
          },
          create: {
            storeId: account.storeId,
            channelAccountId: account.id,
            externalId: inbound.externalCustomerId,
            name: inbound.customerName,
            phone: inbound.customerPhone,
          },
          update: {},
        });

        let conversation = await tx.conversation.findFirst({
          where: { storeId: account.storeId, customerId: customer.id, status: { in: ["open", "pending"] } },
        });
        if (!conversation) {
          conversation = await tx.conversation.create({
            data: { storeId: account.storeId, channelAccountId: account.id, customerId: customer.id },
          });
        }

        const inboundMsg = await tx.message.create({
          data: {
            conversationId: conversation.id,
            storeId: account.storeId,
            senderType: "customer",
            content: inbound.text,
            externalMessageId: inbound.externalMessageId,
          },
        });
        await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return { customer, conversation, inboundMsgId: inboundMsg.id };
      });
      publish(account.storeId, { type: "message.created", conversationId: conversation.id, messageId: inboundMsgId });

      // Phase 2 (short transaction, DB reads only): gather retrieval + agent
      // config for the confidence gate — or the AI Intelligence Layer's
      // specialists/tools instead, if this store opted into that (see
      // aiRouter.ts).
      const context = await withStoreContext([account.storeId], (tx) =>
        gatherAiReply(tx, {
          storeId: account.storeId,
          storeName: account.store.name,
          question: inbound.text,
          conversationId: conversation.id,
          customerId: customer.id,
          organizationId: account.store.organizationId,
        })
      );

      // Phase 3 (network, no transaction open): the LLM call(s), if
      // retrieval/classification was confident enough to attempt one.
      const result = await completeAiReply(context, { storeName: account.store.name, question: inbound.text });

      // Phase 4 (short transaction): persist the AI pipeline's outcome.
      const persisted = await withStoreContext([account.storeId], async (tx) => {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { aiConfidenceLevel: result.confidenceLevel },
        });

        let aiMsgId: string | null = null;
        if (result.replyText) {
          const aiMsg = await tx.message.create({
            data: {
              conversationId: conversation.id,
              storeId: account.storeId,
              senderType: "ai",
              content: result.replyText,
            },
          });
          aiMsgId = aiMsg.id;
          await tx.aiResponseLog.create({
            data: {
              storeId: account.storeId,
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
            storeId: account.storeId,
            organizationId: account.store.organizationId,
            conversationId: conversation.id,
            customerId: customer.id,
            actorUserId: null,
            priority: "medium",
            escalationReason: result.escalationReason,
          });
          await tx.aiResponseLog.create({
            data: {
              storeId: account.storeId,
              conversationId: conversation.id,
              confidenceLevel: result.confidenceLevel,
              actionTaken: "escalated_to_human",
            },
          });
        }
        return { aiMsgId };
      });

      // Phase 5 (network, no transaction open): tell the channel platform.
      if (result.replyText && persisted.aiMsgId) {
        try {
          const credentials = JSON.parse(decryptSecret(account.credentialsEncrypted));
          await adapter.sendMessage(credentials, { toExternalId: customer.externalId, text: result.replyText });
        } catch (err) {
          console.error(`Failed to send AI reply via ${channelTypeKey}:`, err);
        }
        publish(account.storeId, { type: "message.created", conversationId: conversation.id, messageId: persisted.aiMsgId });
      }
    }

    res.sendStatus(200);
  })
);
