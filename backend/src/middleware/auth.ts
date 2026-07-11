import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";

export interface AuthPayload {
  userId: string;
  organizationId: string;
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

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return next(ApiError.unauthorized());
  }
  try {
    const token = header.slice("Bearer ".length);
    const decoded = jwt.verify(token, env.jwtSecret) as AuthPayload;
    req.auth = { userId: decoded.userId, organizationId: decoded.organizationId };
    next();
  } catch {
    next(ApiError.unauthorized("جلسة غير صالحة أو منتهية"));
  }
}
