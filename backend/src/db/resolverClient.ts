import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

/**
 * Used ONLY to resolve a public webhook's channelAccountId/integrationId
 * into its owning store — nowhere else. See the comment on
 * env.resolverDatabaseUrl for why this one lookup needs to see across
 * every store before RLS context can even be established.
 */
export const resolverPrisma = new PrismaClient({
  datasources: { db: { url: env.resolverDatabaseUrl } },
});
