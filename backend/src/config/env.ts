import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  // DATABASE_URL (used by the Prisma CLI for migrate/push/seed) connects as
  // a role with BYPASSRLS — schema setup and seeding are administrative
  // operations that must write across every store. The running app instead
  // uses APP_DATABASE_URL, a role WITHOUT bypass, so RLS in prisma/rls.sql
  // is actually enforced for every request (see src/db/prisma.ts). Falls
  // back to DATABASE_URL only so a single-role dev setup still boots — do
  // not do that in production.
  appDatabaseUrl: process.env.APP_DATABASE_URL ?? required("DATABASE_URL"),
  // A THIRD, even more restricted role: BYPASSRLS but granted SELECT on
  // only 4 tables (channel_accounts, channel_types, integrations, stores).
  // Public inbound webhooks must look up "which store does this
  // channel/integration id belong to" before any store context exists to
  // set app.accessible_store_ids — that one lookup is structurally
  // pre-tenant, like a load balancer resolving a tenant from a hostname.
  // Everything after that lookup goes through the normal RLS-restricted
  // connection via withStoreContext. See src/db/resolverClient.ts.
  resolverDatabaseUrl: process.env.RESOLVER_DATABASE_URL ?? required("DATABASE_URL"),
  databaseUrl: required("DATABASE_URL"),
  // No fallback for these two: a fallback would mean a deployment that
  // forgets to set them boots silently with a value visible in this
  // repo's source — anyone could forge a valid JWT or decrypt every stored
  // channel/integration credential. Fail loud instead.
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "8h",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  encryptionKey: required("ENCRYPTION_KEY"),
};
