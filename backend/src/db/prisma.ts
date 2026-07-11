import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

// Single shared pool for the whole process, connected as the restricted
// (non-BYPASSRLS) app role — see env.appDatabaseUrl. Request-scoped tenant
// context is applied per-transaction in withStoreContext.ts, not here.
export const prisma = new PrismaClient({
  datasources: { db: { url: env.appDatabaseUrl } },
});
