import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a Postgres transaction with `app.accessible_store_ids`
 * set via SET LOCAL, so the RLS policies in prisma/rls.sql — the
 * database's own, independent copy of the isolation check — enforce the
 * same store boundary the RBAC middleware already computed.
 *
 * There is no "see everything" bypass value: even the owner role passes a
 * concrete list here (every store in their organization, resolved in
 * src/middleware/auth.ts), because RLS should never trust a sentinel it
 * can't verify against real data.
 */
export async function withStoreContext<T>(
  storeIds: string[],
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (const id of storeIds) {
    if (!UUID_RE.test(id)) {
      throw new Error(`Refusing to set RLS context: "${id}" is not a UUID`);
    }
  }
  // An empty, unmatchable placeholder if the user has no store access at
  // all — every RLS policy's `= any(...)` then matches zero rows.
  const joined = storeIds.length > 0 ? storeIds.join(",") : "00000000-0000-0000-0000-000000000000";

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.accessible_store_ids = '${joined}'`);
    return fn(tx);
  });
}
