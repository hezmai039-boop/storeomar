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
  // Optional. Set it to run more than one backend instance: rate limits,
  // idempotency records and live-inbox events become shared across
  // processes instead of per-process. Unset = today's single-instance
  // in-memory behaviour, unchanged. See src/lib/redis.ts.
  redisUrl: process.env.REDIS_URL,
  // Transactional email (verification + password reset). Defaults to the
  // "console" adapter, which prints the message — link included — to
  // stdout, so signup/verify/reset run end-to-end with zero external
  // accounts, exactly like src/lib/llm.ts works without ANTHROPIC_API_KEY.
  // Set EMAIL_PROVIDER=resend + RESEND_API_KEY in a real deployment; see
  // src/lib/email/registry.ts.
  emailProvider: process.env.EMAIL_PROVIDER ?? "console",
  resendApiKey: process.env.RESEND_API_KEY,
  // Must be a domain verified with the provider, otherwise every send is
  // rejected. The default is only meaningful for the console adapter.
  emailFrom: process.env.EMAIL_FROM ?? "Atlas <onboarding@atlas.sa>",
  // Base URL of the FRONTEND, used to build the links inside those emails.
  // Separate from corsOrigin even though they usually match: CORS is a
  // browser policy that may legitimately list several origins later, while
  // this is the single canonical address a customer is sent to. Getting it
  // wrong doesn't fail loudly — it just mails out links that 404.
  appUrl: process.env.APP_URL ?? "http://localhost:5173",

  // --- Salla / Zid app-store OAuth (docs/26-salla-zid-app-store.md) ---------
  // Deliberately all optional. A platform with no client id/secret reports
  // isConfigured() === false and its connect endpoint answers 503 instead of
  // redirecting the merchant into a broken authorize page — so the app boots
  // fine with none of these set, which is what every dev machine and every
  // install still pasting tokens by hand relies on.
  sallaClientId: process.env.SALLA_CLIENT_ID,
  sallaClientSecret: process.env.SALLA_CLIENT_SECRET,
  zidClientId: process.env.ZID_CLIENT_ID,
  zidClientSecret: process.env.ZID_CLIENT_SECRET,
  // Origin of THIS BACKEND (not the SPA) — the OAuth callback is a server
  // route. The full redirect_uri is derived from it and must match what is
  // registered in the partner dashboard byte for byte: OAuth servers compare
  // redirect_uri as an exact string, so a trailing slash or an http-vs-https
  // mismatch fails the exchange with an opaque `invalid_grant` rather than a
  // useful error.
  oauthRedirectBase: process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:4000",

  // Public self-serve signup. CLOSED unless explicitly opened — note this is
  // `=== "true"`, not `!== "false"`, so the safe state is what you get by
  // forgetting to set it.
  //
  // The asymmetry is deliberate and it is about money: every organization
  // created here starts on the free plan with a monthly allowance of real
  // Anthropic calls, billed to the platform's own API key. Signup is public
  // and unauthenticated, so an open endpoint lets anyone mint accounts in a
  // loop and spend that budget. Forgetting to open signup costs a support
  // message; forgetting to close it costs an invoice.
  //
  // Flip SIGNUP_ENABLED=true when there is a reason to accept strangers —
  // it is an env var, so opening or closing it is a restart, not a deploy.
  signupEnabled: process.env.SIGNUP_ENABLED === "true",
};
