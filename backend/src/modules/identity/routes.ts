import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { withStoreContext } from "../../db/withStoreContext";
import { ApiError } from "../../lib/errors";
import { asyncHandler } from "../../lib/asyncHandler";
import { authenticate } from "../../middleware/auth";
import { signToken } from "../../middleware/auth";
import { accessibleStoreIdsFor } from "../../middleware/rbac";
import { writeAudit } from "../../lib/audit";
import { ROLES } from "../../lib/permissions";

export const identityRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// POST /v1/auth/login
identityRouter.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || user.status !== "active") throw ApiError.unauthorized("بيانات الدخول غير صحيحة");

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) throw ApiError.unauthorized("بيانات الدخول غير صحيحة");

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await withStoreContext([], async (tx) => {
      await writeAudit(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: "user.login",
        entityType: "user",
        entityId: user.id,
        ip: req.ip,
      });
    });

    const token = signToken({ userId: user.id, organizationId: user.organizationId });
    res.json({ data: { token } });
  })
);

// GET /v1/me — identity + every store this user may open, so the frontend
// can build the sidebar / store switcher from one call (user-flows.md §1).
identityRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId, organizationId } = req.auth!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const orgMember = await prisma.organizationMember.findFirst({
      where: { userId },
      include: { role: true },
    });
    const isOwner = orgMember?.role.key === ROLES.OWNER;

    const storeIds = await accessibleStoreIdsFor(userId, organizationId);
    const stores = await prisma.store.findMany({
      where: { id: { in: storeIds } },
      select: { id: true, name: true, slug: true, status: true },
      orderBy: { name: "asc" },
    });

    let rolesByStore: Record<string, string[]> = {};
    if (!isOwner) {
      const rows = await prisma.userStoreRole.findMany({ where: { userId }, include: { role: true } });
      rolesByStore = rows.reduce<Record<string, string[]>>((acc, r) => {
        (acc[r.storeId] ??= []).push(r.role.key);
        return acc;
      }, {});
    }

    res.json({
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        organizationId,
        isOwner,
        stores: stores.map((s) => ({
          ...s,
          roles: isOwner ? [ROLES.OWNER] : rolesByStore[s.id] ?? [],
        })),
      },
    });
  })
);

const grantAccessSchema = z.object({ storeId: z.string().uuid(), roleKey: z.enum(["store_manager", "agent"]) });

// POST /v1/organizations/:orgId/users/:userId/store-access
identityRouter.post(
  "/organizations/:orgId/users/:userId/store-access",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId: granterId, organizationId } = req.auth!;
    if (organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const granterOrgRole = await prisma.organizationMember.findFirst({
      where: { userId: granterId },
      include: { role: true },
    });
    if (granterOrgRole?.role.key !== ROLES.OWNER) throw ApiError.permissionDenied("users.manage");

    const body = grantAccessSchema.parse(req.body);

    const targetUser = await prisma.user.findFirst({
      where: { id: req.params.userId, organizationId },
    });
    if (!targetUser) throw ApiError.storeAccessDenied();

    const targetStore = await prisma.store.findFirst({
      where: { id: body.storeId, organizationId },
    });
    if (!targetStore) throw ApiError.storeAccessDenied();

    const role = await prisma.role.findUniqueOrThrow({ where: { key: body.roleKey } });

    const grant = await prisma.userStoreRole.upsert({
      where: {
        userId_storeId_roleId: { userId: req.params.userId, storeId: body.storeId, roleId: role.id },
      },
      create: { userId: req.params.userId, storeId: body.storeId, roleId: role.id, grantedBy: granterId },
      update: {},
    });

    await withStoreContext([body.storeId], async (tx) => {
      await writeAudit(tx, {
        organizationId,
        storeId: body.storeId,
        actorUserId: granterId,
        action: "user.store_access.granted",
        entityType: "user_store_role",
        entityId: grant.id,
        after: { userId: req.params.userId, storeId: body.storeId, roleKey: body.roleKey },
      });
    });

    res.status(201).json({ data: grant });
  })
);

// DELETE /v1/organizations/:orgId/users/:userId/store-access/:storeId
identityRouter.delete(
  "/organizations/:orgId/users/:userId/store-access/:storeId",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId: granterId, organizationId } = req.auth!;
    if (organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const granterOrgRole = await prisma.organizationMember.findFirst({
      where: { userId: granterId },
      include: { role: true },
    });
    if (granterOrgRole?.role.key !== ROLES.OWNER) throw ApiError.permissionDenied("users.manage");

    const targetStore = await prisma.store.findFirst({
      where: { id: req.params.storeId, organizationId },
    });
    if (!targetStore) throw ApiError.storeAccessDenied();

    await prisma.userStoreRole.deleteMany({
      where: { userId: req.params.userId, storeId: req.params.storeId },
    });

    await withStoreContext([req.params.storeId], async (tx) => {
      await writeAudit(tx, {
        organizationId,
        storeId: req.params.storeId,
        actorUserId: granterId,
        action: "user.store_access.revoked",
        entityType: "user_store_role",
        after: { userId: req.params.userId, storeId: req.params.storeId },
      });
    });

    res.status(204).send();
  })
);
