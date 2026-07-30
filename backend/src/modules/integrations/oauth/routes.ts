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
import { getOAuthProvider } from "./registry";
import { expiryFrom, toCredentialBlob } from "./types";

// How long a merchant has between clicking "connect" and finishing the
// platform's consent screen. Short on purpose: the state row is the only
// thing binding an incoming callback to a store, so every extra minute is a
// minute in which a leaked authorize URL is still replayable.
const STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. Connect — authenticated, store-scoped.
//    Mounted at /v1/stores/:storeId
// ---------------------------------------------------------------------------

export const oauthConnectRouter = Router({ mergeParams: true });
oauthConnectRouter.use(authenticate, requireStoreAccess());

// GET /v1/stores/:storeId/integrations/:platform/connect
oauthConnectRouter.get(
  "/integrations/:platform/connect",
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(async (req, res) => {
    const provider = getOAuthProvider(req.params.platform);
    if (!provider) throw ApiError.notFound("منصة الربط");
    if (!provider.isConfigured()) {
      // Not a 500: nothing is broken, this deployment simply has no app
      // registered with that platform yet. The SPA shows "الربط غير متاح
      // حاليًا" and keeps the manual-token form available.
      throw new ApiError(503, "OAUTH_NOT_CONFIGURED", "ربط هذه المنصة غير مفعّل في هذا التثبيت، تواصل مع الدعم", {
        platform: req.params.platform,
      });
    }

    // 32 random bytes: this value is the ENTIRE defence against an attacker
    // handing a merchant a crafted callback URL that binds the attacker's
    // store to the merchant's account (see the comment on model OAuthState).
    // base64url so it survives a query string untouched.
    const state = crypto.randomBytes(32).toString("base64url");

    // oauth_states carries no RLS policy (prisma/rls.sql) — by design: the
    // callback that reads this row back is public and pre-tenant, so there
    // is no app.accessible_store_ids to check it against. The row itself is
    // what carries the tenant, which is why storeId and userId are captured
    // HERE, where the request is still fully authenticated, and never taken
    // from the callback's query string.
    await prisma.oAuthState.create({
      data: {
        state,
        storeId: req.storeAccess!.storeId,
        platform: provider.key,
        userId: req.auth!.userId,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    res.redirect(provider.authorizeUrl(state));
  })
);

// ---------------------------------------------------------------------------
// 2. Callback — PUBLIC. Mounted at /v1/integrations/oauth
//
//    Salla/Zid redirect the merchant's own browser here, so there is no
//    Authorization header and no store context — structurally the same
//    problem as the inbound webhooks in channels/webhook.ts, and handled
//    with the same discipline: one narrow pre-tenant lookup resolves the
//    tenant, and everything after it runs through withStoreContext so RLS
//    applies exactly as it would for an authenticated request.
//
//    The one difference from a webhook: there is no signature to verify, so
//    the single-use `state` row IS the authentication. It must therefore be
//    claimed atomically — a callback that arrives twice (browser refresh,
//    or an attacker replaying a captured URL) has to fail the second time.
// ---------------------------------------------------------------------------

export const oauthCallbackRouter = Router();

// GET /v1/integrations/oauth/:platform/callback
oauthCallbackRouter.get(
  "/:platform/callback",
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    // Everything the merchant sees is a redirect back into the SPA. No token,
    // no platform error body, no store id ever reaches the URL bar — a
    // browser history entry, a referer header or a screenshot must not be
    // enough to steal or even identify a connection.
    const back = (query: string) => res.redirect(`${env.appUrl}/settings?${query}`);
    const fail = (code: string) => back(`error=${encodeURIComponent(code)}`);

    const provider = getOAuthProvider(req.params.platform);
    if (!provider) return fail("unknown_platform");

    // The merchant pressed "cancel" on the consent screen, or the platform
    // rejected the request outright.
    if (typeof req.query.error === "string") return fail("access_denied");

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) return fail("missing_code");

    // Claim the state in ONE statement. A findFirst-then-update would leave
    // a window where two concurrent callbacks both read usedAt: null and
    // both proceed; `updateMany` with the conditions in the WHERE clause
    // makes the database decide, and count === 1 means "this request is the
    // one that won". Missing, expired and already-used all collapse into
    // count === 0 deliberately — the browser must not learn which.
    const claimed = await prisma.oAuthState.updateMany({
      where: { state, platform: provider.key, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return fail("invalid_state");

    const stateRow = await prisma.oAuthState.findUnique({ where: { state } });
    if (!stateRow) return fail("invalid_state");

    // From here on, storeId/userId come only from stateRow. req.query is not
    // consulted again for anything but the code.
    let tokens;
    try {
      // Network call, no transaction open — same rule as the phase split in
      // channels/webhook.ts. Note the state is already burnt at this point:
      // if the exchange fails the merchant has to start over, which is the
      // correct trade (a reusable state is a replayable state).
      tokens = await provider.exchangeCode(code);
    } catch (err) {
      // The platform's error body can contain the client secret we echoed
      // back to it, so it is logged server-side and never shown.
      console.error(`[oauth ${provider.key}] code exchange failed for store ${stateRow.storeId}:`, err);
      return fail("exchange_failed");
    }

    try {
      await withStoreContext([stateRow.storeId], async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: stateRow.storeId } });
        const blob = JSON.stringify(toCredentialBlob(tokens));
        const integration = await tx.integration.upsert({
          where: { storeId_platform: { storeId: stateRow.storeId, platform: provider.key } },
          create: {
            storeId: stateRow.storeId,
            platform: provider.key,
            credentialsEncrypted: encryptSecret(blob),
            status: "connected",
            tokenExpiresAt: expiryFrom(tokens),
          },
          // Reconnecting an existing integration replaces the credentials
          // and clears a previous needs_reconnect — the synced orders and
          // products keep their integration id, so history survives.
          update: {
            credentialsEncrypted: encryptSecret(blob),
            status: "connected",
            tokenExpiresAt: expiryFrom(tokens),
          },
        });
        await writeAudit(tx, {
          organizationId: store.organizationId,
          storeId: stateRow.storeId,
          // Attributed to whoever started the flow, taken from the state
          // row: this request has no session of its own to read it from.
          actorUserId: stateRow.userId,
          action: "integration.connected",
          entityType: "integration",
          entityId: integration.id,
          after: { platform: provider.key, method: "oauth" },
        });
      });
    } catch (err) {
      console.error(`[oauth ${provider.key}] failed to persist integration for store ${stateRow.storeId}:`, err);
      return fail("persist_failed");
    }

    return back(`connected=${encodeURIComponent(provider.key)}`);
  })
);
