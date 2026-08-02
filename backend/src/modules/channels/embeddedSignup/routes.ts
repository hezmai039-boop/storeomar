import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../../config/env";
import { prisma } from "../../../db/prisma";
import { withStoreContext } from "../../../db/withStoreContext";
import { asyncHandler } from "../../../lib/asyncHandler";
import { ApiError } from "../../../lib/errors";
import { writeAudit } from "../../../lib/audit";
import { encryptSecret } from "../../../lib/crypto";
import { webhookRateLimiter } from "../../../lib/rateLimit";
import { authenticate } from "../../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../../middleware/rbac";
import { PERMISSIONS } from "../../../lib/permissions";
import {
  buildAuthorizeUrl,
  exchangeCode,
  exchangeForLongLivedToken,
  fetchWabaInfo,
  fetchWabaPhoneNumbers,
  generatePkcePair,
  inspectToken,
  isEmbeddedSignupConfigured,
  subscribeAppToWaba,
} from "./graph";

// Same TTL discipline as the Salla/Zid flow (integrations/oauth/routes.ts):
// the state row is the only thing binding a public callback to a tenant.
const STATE_TTL_MS = 10 * 60 * 1000;

const ES_PLATFORM = "whatsapp_es";

// ---------------------------------------------------------------------------
// 1. Connect — authenticated, store-scoped. Mounted at /v1/stores/:storeId
//
//    GET /v1/stores/:storeId/channels/whatsapp/connect
//
//    Redirects the merchant's browser into Meta's Embedded Signup wizard.
//    storeId/userId are captured HERE, where the request is authenticated,
//    and carried by the state row — never by the callback's query string.
// ---------------------------------------------------------------------------

export const whatsappEsConnectRouter = Router({ mergeParams: true });
whatsappEsConnectRouter.use(authenticate, requireStoreAccess());

whatsappEsConnectRouter.get(
  "/channels/whatsapp/connect",
  requirePermission(PERMISSIONS.CHANNELS_MANAGE),
  asyncHandler(async (req, res) => {
    if (!isEmbeddedSignupConfigured()) {
      // 503, not 500 — nothing is broken, this deployment simply has no
      // Meta App registered yet. The SPA keeps the manual path available.
      throw new ApiError(503, "OAUTH_NOT_CONFIGURED", "ربط واتساب التلقائي غير مفعّل في هذا التثبيت، تواصل مع الدعم", {
        platform: ES_PLATFORM,
      });
    }

    const state = crypto.randomBytes(32).toString("base64url");
    const pkce = generatePkcePair();

    await prisma.oAuthState.create({
      data: {
        state,
        storeId: req.storeAccess!.storeId,
        platform: ES_PLATFORM,
        userId: req.auth!.userId,
        codeVerifier: pkce.verifier,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    // JSON, not a 302: this endpoint is called by the SPA over fetch (the
    // Authorization header cannot ride a full-page navigation), and the SPA
    // then assigns window.location itself. The URL contains no secret — the
    // PKCE verifier stays in the state row, server-side only.
    res.json({ data: { url: buildAuthorizeUrl(state, pkce.challenge) } });
  })
);

// ---------------------------------------------------------------------------
// 2. Callback — PUBLIC. Mounted at /v1/channels/whatsapp/oauth
//
//    GET /v1/channels/whatsapp/oauth/callback
//
//    Meta redirects the merchant's browser here with ?code=&state=. The
//    single-use state row IS the authentication (claimed atomically, same
//    discipline as integrations/oauth/routes.ts). Everything the merchant
//    sees is a redirect back into the SPA — no token, no Meta error body
//    and no store id ever reaches the URL bar.
// ---------------------------------------------------------------------------

export const whatsappEsCallbackRouter = Router();

whatsappEsCallbackRouter.get(
  "/callback",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    const back = (query: string) => res.redirect(`${env.appUrl}/settings?${query}`);
    const fail = (code: string) => back(`error=${encodeURIComponent(code)}`);

    if (!isEmbeddedSignupConfigured()) return fail("whatsapp_not_configured");

    // Merchant pressed cancel on the wizard, or Meta rejected the request.
    if (typeof req.query.error === "string") return fail("access_denied");

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) return fail("missing_code");

    // Claim the state in ONE statement — missing, expired and already-used
    // all collapse into count === 0, and the browser must not learn which.
    const claimed = await prisma.oAuthState.updateMany({
      where: { state, platform: ES_PLATFORM, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return fail("invalid_state");

    const stateRow = await prisma.oAuthState.findUnique({ where: { state } });
    if (!stateRow) return fail("invalid_state");

    // ---- Network phase (no transaction open) --------------------------------
    // Exchange → (maybe) long-lived exchange → inspect → discover → subscribe.
    // The state is already burnt: a failure anywhere below means the merchant
    // starts over, which is the correct trade (a reusable state is replayable).
    let accessToken: string;
    let inspection: Awaited<ReturnType<typeof inspectToken>>;
    try {
      const exchanged = await exchangeCode(code, stateRow.codeVerifier);
      accessToken = exchanged.accessToken;
      if (!accessToken) throw new Error("empty access_token");

      inspection = await inspectToken(accessToken);

      // A token with a real expiry is a user token — trade it for the
      // ~60-day long-lived one so the channel does not die in an hour.
      // A permanent (business integration system user) token skips this.
      if (inspection.tokenType === "expiring") {
        const longLived = await exchangeForLongLivedToken(accessToken);
        if (longLived.accessToken) {
          accessToken = longLived.accessToken;
          inspection = await inspectToken(accessToken);
        }
      }
    } catch (err) {
      console.error(`[whatsapp-es] code exchange failed for store ${stateRow.storeId}:`, err);
      return fail("exchange_failed");
    }

    if (inspection.sharedWabaIds.length === 0) {
      // The wizard completed but shared no WABA — usually the merchant
      // deselected everything on the asset-sharing screen.
      return fail("no_waba_shared");
    }

    // Discover every shared WABA's numbers and business, and subscribe the
    // app to each WABA so webhooks start flowing without any manual step.
    interface DiscoveredAccount {
      wabaId: string;
      businessId: string | null;
      phoneNumberId: string;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
    }
    const discovered: DiscoveredAccount[] = [];
    try {
      for (const wabaId of inspection.sharedWabaIds) {
        const [info, numbers] = await Promise.all([
          fetchWabaInfo(wabaId, accessToken),
          fetchWabaPhoneNumbers(wabaId, accessToken),
        ]);
        await subscribeAppToWaba(wabaId, accessToken);
        for (const n of numbers) {
          if (!n.phoneNumberId) continue;
          discovered.push({
            wabaId,
            businessId: info.businessId,
            phoneNumberId: n.phoneNumberId,
            displayPhoneNumber: n.displayPhoneNumber,
            verifiedName: n.verifiedName,
          });
        }
      }
    } catch (err) {
      console.error(`[whatsapp-es] asset discovery failed for store ${stateRow.storeId}:`, err);
      return fail("discovery_failed");
    }

    if (discovered.length === 0) return fail("no_phone_number");

    // ---- Persistence phase (short transaction, RLS via withStoreContext) ----
    try {
      await withStoreContext([stateRow.storeId], async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: stateRow.storeId } });
        const channelType = await tx.channelType.findUniqueOrThrow({ where: { key: "whatsapp" } });

        for (const acc of discovered) {
          // The credentials blob keeps the exact shape the send adapter
          // (adapters/whatsapp.ts WhatsAppCredentials) already reads —
          // phoneNumberId + accessToken — plus the ES identity for
          // debugging. Nothing downstream changes.
          const blob = JSON.stringify({
            phoneNumberId: acc.phoneNumberId,
            accessToken,
            wabaId: acc.wabaId,
            businessId: acc.businessId,
            appScopedUserId: inspection.appScopedUserId,
          });
          const displayName =
            acc.verifiedName ??
            (acc.displayPhoneNumber ? `واتساب — ${acc.displayPhoneNumber}` : `واتساب — ${store.name}`);

          const account = await tx.channelAccount.upsert({
            where: {
              storeId_channelTypeId_externalAccountId: {
                storeId: stateRow.storeId,
                channelTypeId: channelType.id,
                externalAccountId: acc.phoneNumberId,
              },
            },
            create: {
              storeId: stateRow.storeId,
              channelTypeId: channelType.id,
              externalAccountId: acc.phoneNumberId,
              displayName,
              credentialsEncrypted: encryptSecret(blob),
              status: "connected",
              connectedAt: new Date(),
              wabaId: acc.wabaId,
              businessId: acc.businessId,
              phoneNumberId: acc.phoneNumberId,
              appScopedUserId: inspection.appScopedUserId,
              tokenType: inspection.tokenType,
              tokenScopes: inspection.scopes,
              tokenExpiresAt: inspection.expiresAt,
            },
            // Reconnecting replaces credentials and clears a previous error —
            // same channelAccountId, so webhook routing and history survive.
            update: {
              credentialsEncrypted: encryptSecret(blob),
              status: "connected",
              connectedAt: new Date(),
              lastError: null,
              lastErrorAt: null,
              wabaId: acc.wabaId,
              businessId: acc.businessId,
              phoneNumberId: acc.phoneNumberId,
              appScopedUserId: inspection.appScopedUserId,
              tokenType: inspection.tokenType,
              tokenScopes: inspection.scopes,
              tokenExpiresAt: inspection.expiresAt,
            },
          });

          await writeAudit(tx, {
            organizationId: store.organizationId,
            storeId: stateRow.storeId,
            actorUserId: stateRow.userId,
            action: "channel.connected",
            entityType: "channel_account",
            entityId: account.id,
            after: {
              channelTypeKey: "whatsapp",
              method: "embedded_signup",
              wabaId: acc.wabaId,
              phoneNumberId: acc.phoneNumberId,
            },
          });
        }
      });
    } catch (err) {
      console.error(`[whatsapp-es] failed to persist channel for store ${stateRow.storeId}:`, err);
      return fail("persist_failed");
    }

    return back(`connected=${encodeURIComponent("whatsapp")}`);
  })
);
