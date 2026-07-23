import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { accessibleStoreIdsFor, requirePermission, requireStoreAccess, requireOwner } from "../../middleware/rbac";
import { PERMISSIONS, ROLES } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import bcrypt from "bcryptjs";

export const tenancyRouter = Router();
tenancyRouter.use(authenticate);

// GET /v1/organizations/:orgId
tenancyRouter.get(
  "/organizations/:orgId",
  asyncHandler(async (req, res) => {
    if (req.auth!.organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.params.orgId } });
    res.json({ data: org });
  })
);

// GET /v1/stores — only what this user may open (docs/06-api-design.md §2)
tenancyRouter.get(
  "/stores",
  asyncHandler(async (req, res) => {
    const storeIds = await accessibleStoreIdsFor(req.auth!.userId, req.auth!.organizationId);
    const stores = await withStoreContext(storeIds, (tx) =>
      tx.store.findMany({ where: { id: { in: storeIds } }, orderBy: { name: "asc" } })
    );
    res.json({ data: stores });
  })
);

const createStoreSchema = z.object({ name: z.string().min(1), slug: z.string().min(1), currency: z.string().default("SAR") });

// POST /v1/stores — owner only
tenancyRouter.post(
  "/stores",
  requireOwner(),
  asyncHandler(async (req, res) => {
    const body = createStoreSchema.parse(req.body);
    const store = await prisma.store.create({
      data: { organizationId: req.auth!.organizationId, name: body.name, slug: body.slug, currency: body.currency },
    });
    await withStoreContext([store.id], async (tx) => {
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.created",
        entityType: "store",
        entityId: store.id,
        after: { name: store.name, slug: store.slug },
      });
    });
    res.status(201).json({ data: store });
  })
);

const onboardStoreSchema = z.object({
  storeName: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "المعرّف يقبل حروفًا إنجليزية صغيرة وأرقامًا وشرطات فقط (مثل: ghidhaak)"),
  currency: z.string().default("SAR"),
  ownerName: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8, "كلمة المرور 8 أحرف على الأقل"),
});

// POST /v1/organizations/:orgId/onboard-store — owner-only, one-shot client
// provisioning. Adding a new client used to require three separate manual
// steps (create store, create its AI agent row, create + wire up the
// owner's login) — the middle one had no endpoint at all, so it was only
// doable by editing the database directly. This does all of it atomically:
//   1. the Store,
//   2. its AiAgent (active, sane defaults — without this row the store has
//      no per-store AI config and the ai-agent settings screen 500s),
//   3. the owner's User login (bcrypt-hashed password), reusing an existing
//      user if the email already belongs to this organization,
//   4. a store_manager grant tying that user to the new store.
// Everything runs in ONE transaction, so a partial failure leaves nothing
// behind. The password is never echoed back or logged — the owner set it,
// so they already have it.
tenancyRouter.post(
  "/organizations/:orgId/onboard-store",
  requireOwner(),
  asyncHandler(async (req, res) => {
    if (req.auth!.organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const body = onboardStoreSchema.parse(req.body);
    const organizationId = req.params.orgId;

    // Preflight, with clear Arabic errors before we touch anything.
    const slugTaken = await prisma.store.findFirst({ where: { organizationId, slug: body.slug } });
    if (slugTaken) throw ApiError.badRequest("هذا المعرّف (slug) مستخدم بالفعل — اختر معرّفًا مختلفًا");

    const existingUser = await prisma.user.findUnique({ where: { email: body.ownerEmail } });
    if (existingUser && existingUser.organizationId !== organizationId) {
      throw ApiError.badRequest("هذا البريد مسجّل بالفعل لمؤسسة أخرى");
    }

    const storeManagerRole = await prisma.role.findUniqueOrThrow({ where: { key: ROLES.STORE_MANAGER } });

    const result = await prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: { organizationId, name: body.storeName, slug: body.slug, currency: body.currency, status: "active" },
      });
      await tx.aiAgent.create({
        data: {
          storeId: store.id,
          name: `وكيل ${body.storeName}`,
          modelProvider: "anthropic",
          modelName: "claude-sonnet-5",
        },
      });

      let ownerUser = existingUser;
      const ownerAccountCreated = !ownerUser;
      if (!ownerUser) {
        const passwordHash = await bcrypt.hash(body.ownerPassword, 10);
        ownerUser = await tx.user.create({
          data: { organizationId, name: body.ownerName, email: body.ownerEmail, passwordHash, status: "active" },
        });
      }

      await tx.userStoreRole.upsert({
        where: { userId_storeId_roleId: { userId: ownerUser.id, storeId: store.id, roleId: storeManagerRole.id } },
        create: { userId: ownerUser.id, storeId: store.id, roleId: storeManagerRole.id, grantedBy: req.auth!.userId },
        update: {},
      });

      return { store, ownerEmail: ownerUser.email, ownerAccountCreated };
    });

    await withStoreContext([result.store.id], async (tx) => {
      await writeAudit(tx, {
        organizationId,
        storeId: result.store.id,
        actorUserId: req.auth!.userId,
        action: "store.onboarded",
        entityType: "store",
        entityId: result.store.id,
        after: { name: body.storeName, slug: body.slug, ownerEmail: result.ownerEmail, ownerAccountCreated: result.ownerAccountCreated },
      });
    });

    res.status(201).json({
      data: { store: result.store, ownerEmail: result.ownerEmail, ownerAccountCreated: result.ownerAccountCreated },
    });
  })
);

const assignManagerSchema = z.object({
  ownerName: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8, "كلمة المرور 8 أحرف على الأقل"),
});

// POST /v1/organizations/:orgId/stores/:storeId/assign-manager — owner-only.
// onboard-store creates a brand-new store; this attaches a real client login
// to an EXISTING one — exactly what the seeded demo stores need to stop being
// "demo" and become client-editable (they were created with no login, so only
// the platform owner could touch them). Creates (or reuses) the user and
// grants store_manager on this store. Idempotent per (user, store).
tenancyRouter.post(
  "/organizations/:orgId/stores/:storeId/assign-manager",
  requireStoreAccess(),
  requireOwner(),
  asyncHandler(async (req, res) => {
    if (req.auth!.organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const body = assignManagerSchema.parse(req.body);
    const organizationId = req.params.orgId;

    const store = await prisma.store.findFirst({ where: { id: req.params.storeId, organizationId } });
    if (!store) throw ApiError.notFound("المتجر");

    const existingUser = await prisma.user.findUnique({ where: { email: body.ownerEmail } });
    if (existingUser && existingUser.organizationId !== organizationId) {
      throw ApiError.badRequest("هذا البريد مسجّل بالفعل لمؤسسة أخرى");
    }
    const storeManagerRole = await prisma.role.findUniqueOrThrow({ where: { key: ROLES.STORE_MANAGER } });

    const result = await prisma.$transaction(async (tx) => {
      let user = existingUser;
      const created = !user;
      if (!user) {
        const passwordHash = await bcrypt.hash(body.ownerPassword, 10);
        user = await tx.user.create({
          data: { organizationId, name: body.ownerName, email: body.ownerEmail, passwordHash, status: "active" },
        });
      }
      await tx.userStoreRole.upsert({
        where: { userId_storeId_roleId: { userId: user.id, storeId: store.id, roleId: storeManagerRole.id } },
        create: { userId: user.id, storeId: store.id, roleId: storeManagerRole.id, grantedBy: req.auth!.userId },
        update: {},
      });
      return { ownerEmail: user.email, ownerAccountCreated: created };
    });

    await withStoreContext([store.id], async (tx) => {
      await writeAudit(tx, {
        organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.manager_assigned",
        entityType: "store",
        entityId: store.id,
        after: { ownerEmail: result.ownerEmail, ownerAccountCreated: result.ownerAccountCreated },
      });
    });

    res.status(201).json({ data: result });
  })
);

// GET /v1/stores/:storeId
tenancyRouter.get(
  "/stores/:storeId",
  requireStoreAccess(),
  asyncHandler(async (req, res) => {
    const store = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.store.findUniqueOrThrow({ where: { id: req.params.storeId } })
    );
    res.json({ data: store });
  })
);

const setStatusSchema = z.object({ status: z.enum(["active", "disabled"]) });

// PATCH /v1/stores/:storeId/status — owner-only enable/disable of a whole
// store. "disabled" is a soft, fully-reversible off switch for the entire
// client (e.g. a subscription lapse) — distinct from pausing just the AI
// (Settings → إيقاف الرد الآلي) or disconnecting a single channel. Flipping
// it back to "active" restores the store instantly, no data touched.
tenancyRouter.patch(
  "/stores/:storeId/status",
  requireStoreAccess(),
  requireOwner(),
  asyncHandler(async (req, res) => {
    const body = setStatusSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const before = await tx.store.findUniqueOrThrow({ where: { id: req.params.storeId } });
      const store = await tx.store.update({ where: { id: req.params.storeId }, data: { status: body.status } });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: body.status === "disabled" ? "store.disabled" : "store.enabled",
        entityType: "store",
        entityId: store.id,
        before: { status: before.status },
        after: { status: store.status },
      });
      return store;
    });
    res.json({ data: updated });
  })
);

const updateStoreSchema = z.object({ name: z.string().min(1).max(200) });

// PATCH /v1/stores/:storeId — rename a store (e.g. swap a demo name for the
// client's real business name). Owner-only, like store creation, since this
// is store identity rather than day-to-day settings.
tenancyRouter.patch(
  "/stores/:storeId",
  requireStoreAccess(),
  requirePermission(PERMISSIONS.STORES_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateStoreSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const before = await tx.store.findUniqueOrThrow({ where: { id: req.params.storeId } });
      const store = await tx.store.update({
        where: { id: req.params.storeId },
        data: { name: body.name },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.renamed",
        entityType: "store",
        entityId: store.id,
        before: { name: before.name },
        after: { name: store.name },
      });
      return store;
    });
    res.json({ data: updated });
  })
);

const updateSettingsSchema = z.object({ settings: z.record(z.unknown()) });

// PATCH /v1/stores/:storeId/settings
tenancyRouter.patch(
  "/stores/:storeId/settings",
  requireStoreAccess(),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateSettingsSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const store = await tx.store.update({
        where: { id: req.params.storeId },
        data: { settings: body.settings as Prisma.InputJsonValue },
      });
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: store.id,
        actorUserId: req.auth!.userId,
        action: "store.settings.updated",
        entityType: "store",
        entityId: store.id,
        after: body.settings,
      });
      return store;
    });
    res.json({ data: updated });
  })
);
