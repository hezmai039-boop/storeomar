import { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma";
import { ApiError } from "../lib/errors";
import { asyncHandler } from "../lib/asyncHandler";
import { PermissionKey, ROLES, RoleKey, roleHasPermission } from "../lib/permissions";

export interface StoreAccess {
  storeId: string;
  roles: RoleKey[];
  /** Every store this user may act on — passed straight into withStoreContext for RLS. */
  accessibleStoreIds: string[];
  isOwner: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      storeAccess?: StoreAccess;
    }
  }
}

async function resolveAccess(userId: string) {
  const orgMember = await prisma.organizationMember.findFirst({
    where: { userId },
    include: { role: true },
  });
  const isOwner = orgMember?.role.key === ROLES.OWNER;

  const storeRoleRows = await prisma.userStoreRole.findMany({
    where: { userId },
    include: { role: true },
  });
  const storeRoles = new Map<string, RoleKey[]>();
  for (const row of storeRoleRows) {
    const list = storeRoles.get(row.storeId) ?? [];
    list.push(row.role.key as RoleKey);
    storeRoles.set(row.storeId, list);
  }
  return { isOwner, storeRoles };
}

/** Every store id the current user may touch — owner gets the whole org. */
export async function accessibleStoreIdsFor(userId: string, organizationId: string): Promise<string[]> {
  const access = await resolveAccess(userId);
  if (access.isOwner) {
    const stores = await prisma.store.findMany({ where: { organizationId }, select: { id: true } });
    return stores.map((s) => s.id);
  }
  return Array.from(access.storeRoles.keys());
}

/**
 * Gate 1 of docs/06-api-design.md §9: is `req.params.storeId` one of the
 * stores this user may access at all? Populates req.storeAccess for the
 * permission check (gate 2) and for withStoreContext (gate 3, in the DB).
 */
export function requireStoreAccess() {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const { userId, organizationId } = req.auth!;
    const storeId = req.params.storeId;
    const access = await resolveAccess(userId);

    if (access.isOwner) {
      const store = await prisma.store.findFirst({ where: { id: storeId, organizationId } });
      if (!store) throw ApiError.storeAccessDenied();
      const allStores = await prisma.store.findMany({ where: { organizationId }, select: { id: true } });
      req.storeAccess = {
        storeId,
        roles: [ROLES.OWNER],
        accessibleStoreIds: allStores.map((s) => s.id),
        isOwner: true,
      };
      return next();
    }

    const roles = access.storeRoles.get(storeId);
    if (!roles || roles.length === 0) throw ApiError.storeAccessDenied();
    req.storeAccess = {
      storeId,
      roles,
      accessibleStoreIds: Array.from(access.storeRoles.keys()),
      isOwner: false,
    };
    next();
  });
}

/** Gate 2: does any role the user holds on this store grant `permission`? */
export function requirePermission(permission: PermissionKey) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const access = req.storeAccess;
    if (!access) return next(new Error("requireStoreAccess must run before requirePermission"));
    const granted = access.roles.some((role) => roleHasPermission(role, permission));
    if (!granted) return next(ApiError.permissionDenied(permission));
    next();
  };
}

/** For organization-level routes (e.g. cross-store owner reports) — no storeId in the path. */
export function requireOwner() {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const { userId } = req.auth!;
    const access = await resolveAccess(userId);
    if (!access.isOwner) throw ApiError.permissionDenied("organization.owner");
    next();
  });
}
