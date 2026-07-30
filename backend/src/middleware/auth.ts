import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../db/prisma";

export interface AuthPayload {
  userId: string;
  organizationId: string;
  /**
   * Snapshot of users.token_version at signing time, compared on every
   * request so a password change evicts open sessions immediately.
   *
   * Optional because tokens signed before this shipped do not carry it;
   * those read as version 0, which matches the column default, so the
   * deploy itself logs nobody out.
   */
  tokenVersion?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}

/**
 * Verifies the signature, then checks the token against the user's current
 * token_version.
 *
 * The version check costs one indexed lookup per request. Without it a JWT
 * is valid for its full 8h purely because it is signed — so an attacker
 * holding a stolen token keeps access for hours after the victim changes
 * their password, which is the one action taken specifically to stop them.
 * Stateless tokens cannot be revoked; a version column is the cheapest way
 * to make them revocable without introducing a session store.
 */
export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return next(ApiError.unauthorized());
  }

  let decoded: AuthPayload;
  try {
    decoded = jwt.verify(header.slice("Bearer ".length), env.jwtSecret) as AuthPayload;
  } catch {
    return next(ApiError.unauthorized("جلسة غير صالحة أو منتهية"));
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { tokenVersion: true, status: true },
  });
  // A deleted or suspended account's tokens stop working here too, instead
  // of staying valid until they happen to expire.
  if (!user || user.status !== "active") {
    return next(ApiError.unauthorized("جلسة غير صالحة أو منتهية"));
  }
  if ((decoded.tokenVersion ?? 0) !== user.tokenVersion) {
    return next(ApiError.unauthorized("انتهت الجلسة بعد تغيير كلمة المرور — سجّل الدخول مجددًا"));
  }

  req.auth = { userId: decoded.userId, organizationId: decoded.organizationId };
  next();
});
