import { Router } from "express";
import { Prisma } from "@prisma/client";
import { resolverPrisma } from "../../db/resolverClient";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { getAdapter } from "./adapters/registry";
import { ChannelAdapter, NormalizedInboundMessage } from "./adapters/types";
import { gatherAiReply, completeAiReply } from "../knowledge/aiRouter";
import { createTicketFromConversation } from "../tickets/service";
import { publish } from "./realtime";
import { decryptSecret } from "../../lib/crypto";
import { webhookRateLimiter } from "../../lib/rateLimit";

export const webhooksRouter = Router();

const accountWithStore = Prisma.validator<Prisma.ChannelAccountDefaultArgs>()({
  include: { channelType: true, store: true },
});
type AccountWithStore = Prisma.ChannelAccountGetPayload<typeof accountWithStore>;

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

// Shared by both the legacy per-account routes and the app-level WhatsApp
// routes below — everything from "we know which channel_account this
// inbound batch belongs to" onward is identical regardless of how that
// account was resolved.
async function processInboundMessages(
  account: AccountWithStore,
  adapter: ChannelAdapter,
  channelTypeKey: string,
  inboundMessages: NormalizedInboundMessage[]
) {
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
}

// ---------------------------------------------------------------------------
// App-level WhatsApp routes (recommended — use these for every store).
//
// Meta only allows ONE webhook callback URL + ONE verify token per Facebook
// App, shared across every WABA/phone number subscribed to that app. The
// legacy per-channel-account routes below (one URL per store) only work as
// long as a single store is connected; the moment a second store's number
// is subscribed to the same app, Meta keeps delivering to whichever URL is
// configured in the app dashboard — silently misrouting every other store's
// messages into that one account. These routes fix that by identifying the
// store from the phone_number_id embedded in the payload itself, so the
// same single callback URL works for an unlimited number of stores.
//
// One-time setup per Meta App (not per store): set the app's webhook
// Callback URL to POST {BASE_URL}/v1/webhooks/whatsapp and the Verify Token
// to WHATSAPP_WEBHOOK_VERIFY_TOKEN (see docs/21-meta-tech-provider-guide.md).
// Onboarding each additional store after that needs zero Meta App changes —
// just: share the store's WABA as an asset, call POST /{WABA-ID}/subscribed_apps
// once, and add the channel account in Atlas with its phoneNumberId as
// externalAccountId.
// ---------------------------------------------------------------------------

webhooksRouter.get(
  "/whatsapp",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const verifyToken = req.query["hub.verify_token"];
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "";
    if (expected && verifyToken === expected) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  })
);

interface WhatsAppEntry {
  changes?: Array<{
    value?: { metadata?: { phone_number_id?: string } };
  }>;
}

webhooksRouter.post(
  "/whatsapp",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const rawBody = req.body as Buffer;
    const adapter = getAdapter("whatsapp-cloud-api");
    const signature = req.header("x-hub-signature-256") as string | undefined;
    const appSecret = APP_SECRETS.whatsapp;

    if (!adapter.verifyWebhookSignature(rawBody, signature, appSecret)) {
      return res.sendStatus(401);
    }

    const payload = JSON.parse(rawBody.toString("utf8")) as { entry?: WhatsAppEntry[] };

    // A single delivery can (rarely) batch changes for more than one phone
    // number, so route per-change rather than assuming the whole payload
    // belongs to one store.
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const account = await resolverPrisma.channelAccount.findFirst({
          where: { externalAccountId: phoneNumberId, channelType: { key: "whatsapp" } },
          include: { channelType: true, store: true },
        });
        if (!account) {
          console.error(`[webhook whatsapp] no channel_account for phone_number_id=${phoneNumberId}`);
          continue;
        }

        const inboundMessages = adapter.parseWebhook({ entry: [{ changes: [change] }] });
        await processInboundMessages(account, adapter, "whatsapp", inboundMessages);
      }
    }

    res.sendStatus(200);
  })
);

// ---------------------------------------------------------------------------
// Legacy per-channel-account routes — kept for channel types not yet
// migrated to an app-level route (instagram, messenger, tiktok) and for the
// mock/simulation adapter. Safe to keep using ONLY while a given app has a
// single connected account; see the warning above before connecting a
// second WhatsApp/Instagram/Messenger account under the same Meta App.
// ---------------------------------------------------------------------------

// GET — Meta's webhook subscription handshake (hub.challenge).
webhooksRouter.get(
  "/channels/:channelTypeKey/:channelAccountId",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const account = await resolverPrisma.channelAccount.findUnique({ where: { id: req.params.channelAccountId } });
    const verifyToken = req.query["hub.verify_token"];
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

    const account = await resolverPrisma.channelAccount.findUnique({
      where: { id: channelAccountId },
      include: { channelType: true, store: true },
    });
    if (!account || account.channelType.key !== channelTypeKey) {
      return res.sendStatus(404);
    }

    const adapter = getAdapter(account.channelType.adapterKey);
    const signature =
      (req.header("x-hub-signature-256") as string | undefined) ?? (req.header("x-tiktok-signature") as string | undefined);
    const appSecret = APP_SECRETS[channelTypeKey] ?? "";

    const signatureOk = adapter.verifyWebhookSignature(rawBody, signature, appSecret);
    if (!signatureOk) {
      // Invalid signature = reject before touching the database (docs/06-api-design.md §3).
      return res.sendStatus(401);
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const inboundMessages = adapter.parseWebhook(payload);
    await processInboundMessages(account, adapter, channelTypeKey, inboundMessages);

    res.sendStatus(200);
  })
);
