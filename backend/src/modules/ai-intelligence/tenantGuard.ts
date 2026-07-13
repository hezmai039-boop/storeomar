import { ApiError } from "../../lib/errors";

// Independent, third copy of the same UUID check used in
// src/db/withStoreContext.ts and src/middleware/rbac.ts — deliberately not
// imported from either. Every entry point into the AI Intelligence Layer
// (tools, memory, orchestrator) must reject on its own if a caller ever
// reaches it without a resolved store_id, even if some future refactor of
// the RBAC/DB layers changes how *they* validate it. Defense in depth, not
// the only line of defense (RLS in prisma/rls.sql is the other one).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws if `storeId` is missing or not a UUID. Every function in this
 * module (tools/*, memory.ts, orchestrator.ts) calls this first, before
 * touching the database — "if tenant_id is missing, reject the operation
 * entirely" is enforced here, not assumed from the caller's TypeScript type.
 */
export function requireTenant(storeId: unknown, context: string): string {
  if (typeof storeId !== "string" || !UUID_RE.test(storeId)) {
    throw new ApiError(
      400,
      "TENANT_CONTEXT_MISSING",
      `رُفضت عملية الذكاء الاصطناعي: لا يوجد tenant_id (store_id) صالح — السياق: ${context}`
    );
  }
  return storeId;
}
