-- Channel diagnostics: record WHY a channel stopped working, not just that
-- its status is 'error'.
--
-- `channel_accounts.status` alone could not distinguish an expired access
-- token from a recipient that is not on a Meta test number's allow-list
-- from a closed 24-hour customer-service window — so the owner's «صحة
-- القنوات» table kept showing «متصلة» for a channel that had been dead for
-- days. These three columns carry the parsed cause forward.
--
-- Purely additive: three nullable columns on one existing table. No data is
-- rewritten, no column is dropped or renamed, nothing is backfilled, and
-- there is no NOT NULL to violate — so this is safe to run on a live
-- database with `prisma migrate deploy` while the app is serving traffic.
--
-- IF NOT EXISTS for the same reason as 20260729120000 and 20260730140000:
-- this lands on databases that predate migrations (built by `db push`),
-- where a column may already exist. An additive migration should meet the
-- database halfway rather than abort and block every later deploy — see
-- docs/30-migrations.md.

-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "last_error" TEXT;
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "last_error_at" TIMESTAMPTZ(6);
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "token_expires_at" TIMESTAMPTZ(6);
