import { Router } from "express";
import { Prisma } from "@prisma/client";
import { resolverPrisma } from "../../db/resolverClient";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { getAdapter } from "./adapters/registry";
import { ChannelAdapter, NormalizedInboundMessage } from "./adapters/types";
import { gatherAiReply, completeAiReply } from "../knowledge/aiRouter";
import { aiResponseLogUsageFields } from "../knowledge/aiPipeline";
import { createTicketFromConversation } from "../tickets/service";
import { publish } from "./realtime";
import { decryptSecret } from "../../lib/crypto";
import { webhookRateLimiter } from "../../lib/rateLimit";
import { diagnoseSendError, recordChannelOutcome } from "./channelHealth";

export const webhooksRouter = Router();

const accountWithStore = Prisma.validator<Prisma.ChannelAccountDefaultArgs>()({
  include: { channelType: true, store: true },
});
type AccountWithStore = Prisma.ChannelAccountGetPayload<typeof accountWithStore>;

// Fallback app secrets, used when a channel_account does not carry its own.
// These are correct for the "one Meta app, many connected numbers" topology
// — the merchant grants our Business access to their WABA, the subscription
// lives on OUR app, so Meta signs every delivery with OUR secret.
const APP_SECRETS: Record<string, string> = {
  whatsapp: process.env.WHATSAPP_APP_SECRET ?? "",
  instagram: process.env.META_APP_SECRET ?? "",
  messenger: process.env.META_APP_SECRET ?? "",
  tiktok: process.env.TIKTOK_APP_SECRET ?? "",
  mock: process.env.MOCK_APP_SECRET ?? "dev-only-mock-secret",
};

/**
 * The app secret to verify THIS account's deliveries with.
 *
 * There are two legitimate Meta topologies and a merchant-facing product has
 * to support both, because which one applies is the merchant's decision and
 * not ours:
 *
 *   shared app   — the merchant shares their WABA with our Business. The
 *                  webhook subscription sits on our app, so Meta signs with
 *                  the env secret. This is what the env vars above cover.
 *
 *   own app      — the merchant creates their own Meta app and points its
 *                  webhook at us. Meta then signs with THEIR app secret, and
 *                  a global env secret can never match it. Before this
 *                  function existed, every such delivery failed the HMAC and
 *                  was answered 401: the merchant could SEND fine (sending
 *                  only needs the phone number id + token) but never
 *                  RECEIVE, and nothing in the logs said why.
 *
 * The per-account secret rides inside `credentials_encrypted` alongside the
 * access token, so supporting it needs no migration and no new column — and
 * it inherits that blob's encryption rather than inventing a second place
 * for a secret to live.
 *
 * Falls back to the env secret when absent, so every already-connected
 * account keeps verifying exactly as it did before.
 */
function appSecretFor(account: { credentialsEncrypted: Buffer }, channelKey: string): string {
  const fallback = APP_SECRETS[channelKey] ?? "";
  try {
    const creds = JSON.parse(decryptSecret(account.credentialsEncrypted)) as { appSecret?: unknown };
    return typeof creds.appSecret === "string" && creds.appSecret.length > 0 ? creds.appSecret : fallback;
  } catch {
    // A credential blob we cannot decrypt is a real incident (usually a
    // rotated ENCRYPTION_KEY), but it must not become an open door: fall
    // back to the env secret, which then fails the HMAC closed.
    return fallback;
  }
}

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
        // Lets the router honour the per-channel switch. The simulation path
        // deliberately omits it — there is no real channel account behind a
        // simulation link, so there is nothing for a merchant to have
        // silenced there.
        channelAccountId: account.id,
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
            // Per-reply token cost. Spreads to nothing when the reply came
            // from the key-less fallback path, leaving the columns NULL
            // rather than a 0 that would read as "this reply was free".
            ...aiResponseLogUsageFields(result),
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
            // Usage goes on the message row only. Phase 4 writes TWO rows
            // when a reply both answers and escalates — the normal shape on
            // the advanced path, where an escalation still carries an
            // acknowledgment — and the analytics report sums answered +
            // flagged_for_review + escalated_to_human. Spreading the run's
            // usage onto both rows double-counted the cost of exactly the
            // most expensive conversations.
            ...(aiMsgId ? {} : aiResponseLogUsageFields(result)),
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
        // The channel demonstrably works right now — clear any stale error
        // so «صحة القنوات» stops accusing a channel that recovered.
        await recordChannelOutcome(account.storeId, account.id, { ok: true });
      } catch (err) {
        // A swallowed console.error was the entire failure story here: the
        // channel row kept saying "connected" while every AI reply silently
        // failed to leave the building. Record the parsed cause on the row.
        const parsed = diagnoseSendError(err);
        console.error(
          `Failed to send AI reply via ${channelTypeKey} (reason=${parsed.reason}): ${parsed.rawExcerpt}`
        );
        await recordChannelOutcome(account.storeId, account.id, { ok: false, parsed });
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
// once, and add the channel account in Maysoor with its phoneNumberId as
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

    // ORDER: parse → resolve account → verify → act.
    //
    // The signature cannot be checked first here, because WHICH secret is
    // correct depends on which merchant the delivery belongs to (see
    // appSecretFor), and that is only knowable after reading the phone
    // number id out of the body. So the body is parsed before it is trusted.
    //
    // What makes that safe is what happens in between: parsing is pure, the
    // only thing done with the untrusted value is one indexed read-only
    // lookup, the route is rate-limited, and NOTHING is written and no
    // message is processed until the HMAC passes. An unsigned request can
    // therefore cost a lookup and nothing else — it can never create a
    // conversation, spend AI quota, or send a reply.
    let payload: { entry?: WhatsAppEntry[] };
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as { entry?: WhatsAppEntry[] };
    } catch {
      // Unparseable bodies reach this route now that parsing precedes
      // verification. 400, not an uncaught throw that would surface as a 500.
      return res.sendStatus(400);
    }

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

        // Verified per change, with THIS merchant's secret. Rejecting the
        // whole delivery on the first bad change would let one merchant's
        // misconfigured app silently drop another merchant's messages in the
        // same batch.
        if (!adapter.verifyWebhookSignature(rawBody, signature, appSecretFor(account, "whatsapp"))) {
          console.error(`[webhook whatsapp] signature rejected for phone_number_id=${phoneNumberId}`);
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
    // Per-account secret first, env fallback second — this route already
    // resolved the account from the URL, so the merchant's own app secret is
    // available with no reordering needed.
    const appSecret = appSecretFor(account, channelTypeKey);

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
