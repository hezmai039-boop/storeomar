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
import { prisma } from "../../db/prisma";
import { diagnoseSendError, recordChannelFailure, recordChannelSuccess, recordChannelOutcome } from "./channelHealth";
import { diagnoseWhatsAppChannel } from "./diagnostics";
import type { ParsedMetaError } from "./adapters/metaErrors";

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
//
// Needs a recipient, which is exactly its limitation: on a Meta test number
// the recipient must itself be allow-listed, so a failure here is ambiguous
// between "the token died" and "this recipient is not allowed" — two
// opposite problems. /diagnose below answers that without a recipient.
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
          text: "رسالة اختبار من منصة ميسور — القناة متصلة بنجاح.",
        });
        await recordChannelSuccess(tx, account.id);
        return tx.channelAccount.findFirstOrThrow({ where: { id: account.id } });
      } catch (err) {
        // `err.message` used to be interpolated straight into this response,
        // which shipped Meta's raw English body — phone number ids, WABA
        // ids, fbtrace — to whoever pressed the button. The parsed Arabic
        // cause goes in the response; the raw body stays in the log.
        const parsed = diagnoseSendError(err);
        await recordChannelFailure(tx, account.id, parsed);
        throw ApiError.badRequest(`فشل اختبار القناة: ${parsed.titleAr} — ${parsed.detailAr}`, {
          reason: parsed.reason,
          fix: parsed.fixAr,
        });
      }
    });
    const { credentialsEncrypted, ...safe } = result;
    res.json({ data: safe });
  })
);

// POST /v1/stores/:storeId/channel-accounts/:id/diagnose — «فحص القناة».
//
// The real diagnostic: no recipient, no message sent, read-only Graph calls
// that name ONE cause out of the five that make a WhatsApp channel go
// quiet (docs/22 §"تشخيص الأعطال"). It also writes what it learns back to
// the channel row, so the owner's «صحة القنوات» table stops lying the
// moment someone presses the button.
channelsRouter.post(
  "/channel-accounts/:id/diagnose",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    // Meta's raw error text is shown to platform staff only — it carries
    // internal identifiers, and the merchant has no use for it anyway.
    const staff = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { isPlatformAdmin: true },
    });

    const account = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.channelAccount.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
        include: { channelType: true },
      })
    );
    if (account.channelType.key !== "whatsapp") {
      throw ApiError.badRequest("الفحص التشخيصي متاح حاليًا لقناة واتساب فقط.");
    }

    const credentials = JSON.parse(decryptSecret(account.credentialsEncrypted)) as {
      phoneNumberId?: string;
      accessToken?: string;
    };
    if (!credentials.phoneNumberId || !credentials.accessToken) {
      throw ApiError.badRequest(
        "بيانات اعتماد القناة ناقصة: يلزم Phone Number ID وAccess Token. حدّثهما من «تحديث بيانات الاعتماد»."
      );
    }

    // "Did anything ever arrive?" — the one check that separates a dead
    // token from a webhook that never reaches us (cause #4).
    const lastInbound = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.message.findFirst({
        where: {
          storeId: req.storeAccess!.storeId,
          senderType: "customer",
          conversation: { channelAccountId: account.id },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      })
    );

    // Network calls with no transaction open (same discipline as the AI
    // pipeline in webhook.ts): Graph latency must not hold a DB connection.
    const diagnosis = await diagnoseWhatsAppChannel({
      credentials: { phoneNumberId: credentials.phoneNumberId, accessToken: credentials.accessToken },
      storedLastError: account.lastError,
      storedLastErrorAt: account.lastErrorAt,
      lastInboundAt: lastInbound?.createdAt ?? null,
      includeStaffDetail: Boolean(staff?.isPlatformAdmin),
    });

    // Persist what the check learned: a diagnosis that does not change the
    // status column leaves the owner's overview exactly as wrong as before.
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const tokenBroken = diagnosis.checks.some((c) => c.key === "token" && c.status === "fail");
      if (tokenBroken && diagnosis.reason) {
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            status: "error",
            lastError: `[${diagnosis.reason}] ${diagnosis.checks.find((c) => c.key === "token")!.detail}`,
            lastErrorAt: new Date(),
            ...(diagnosis.tokenExpiresAt ? { tokenExpiresAt: new Date(diagnosis.tokenExpiresAt) } : {}),
          },
        });
      } else if (diagnosis.healthy) {
        await recordChannelSuccess(tx, account.id);
        if (diagnosis.tokenExpiresAt) {
          await tx.channelAccount.update({
            where: { id: account.id },
            data: { tokenExpiresAt: new Date(diagnosis.tokenExpiresAt) },
          });
        }
      }
      return tx.channelAccount.findFirstOrThrow({ where: { id: account.id }, include: { channelType: true } });
    });

    const { credentialsEncrypted, ...safeAccount } = updated;
    res.json({ data: { diagnosis, channel: safeAccount } });
  })
);

const updateCredentialsSchema = z.object({ credentials: z.record(z.unknown()) });

// PATCH /v1/stores/:storeId/channel-accounts/:id/credentials — rotate a
// channel's access token (e.g. after a temporary WhatsApp token expires)
// without deleting/recreating the account. Recreating would mint a new
// channelAccountId, which breaks the webhook Callback URL already
// configured on Meta's side — this lets the store keep the same account
// (and the same webhook URL) and just refresh what's expired.
channelsRouter.patch(
  "/channel-accounts/:id/credentials",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateCredentialsSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const account = await tx.channelAccount.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
      });
      const result = await tx.channelAccount.update({
        where: { id: account.id },
        data: { credentialsEncrypted: encryptSecret(JSON.stringify(body.credentials)), status: "connected" },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "channel.credentials_updated",
        entityType: "channel_account",
        entityId: account.id,
      });
      return result;
    });
    const { credentialsEncrypted, ...safe } = updated;
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
    const replay = await getIdempotentReplay(idemKey);
    if (replay) return res.status(replay.status).json(replay.body);

    const body = replySchema.parse(req.body);
    // Held outside the transaction on purpose: a failed send aborts the
    // transaction, so the channel's health has to be written afterwards, on
    // its own connection, or it would roll back with everything else.
    const failureBox: { value: { channelAccountId: string; parsed: ParsedMetaError } | null } = { value: null };
    const result = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const conversation = await tx.conversation.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
        include: { channelAccount: { include: { channelType: true } }, customer: true },
      });

      const adapter = getAdapter(conversation.channelAccount.channelType.adapterKey);
      const credentials = JSON.parse(decryptSecret(conversation.channelAccount.credentialsEncrypted));
      let sent: { externalMessageId: string };
      try {
        sent = await adapter.sendMessage(credentials, {
          toExternalId: conversation.customer.externalId,
          text: body.text,
        });
      } catch (err) {
        const parsed = diagnoseSendError(err);
        failureBox.value = { channelAccountId: conversation.channelAccount.id, parsed };
        // Arabic and parsed — never Meta's raw body, which used to travel
        // out of the adapter inside err.message.
        throw ApiError.badRequest(`تعذّر إرسال الرد عبر القناة: ${parsed.titleAr} — ${parsed.detailAr}`, {
          reason: parsed.reason,
          fix: parsed.fixAr,
        });
      }
      await recordChannelSuccess(tx, conversation.channelAccount.id);

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
    }).catch(async (err) => {
      // The send failed and took the transaction with it — so the channel's
      // health is recorded here, outside it, before the error surfaces.
      if (failureBox.value) {
        await recordChannelOutcome(req.storeAccess!.storeId, failureBox.value.channelAccountId, {
          ok: false,
          parsed: failureBox.value.parsed,
        });
      }
      throw err;
    });

    publish(req.storeAccess!.storeId, { type: "message.created", conversationId: req.params.id, messageId: result.id });
    const responseBody = { data: result };
    await storeIdempotentResponse(idemKey, 201, responseBody);
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
      // `.text`, not the object: generateGroundedAnswer now returns
      // { text, usage, model } so callers can meter token cost. tsc can't
      // catch this one — the object is still assignable to res.json, so
      // getting it wrong would silently ship a JSON blob to the UI where a
      // summary string belongs, but only on deployments that actually set
      // ANTHROPIC_API_KEY.
      return llmSummary?.text ?? `آخر ${messages.length} رسائل: ${messages[messages.length - 1].content}`;
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
