#!/bin/sh
set -e

# prisma/schema.prisma declares directUrl = env("DIRECT_DATABASE_URL") so the
# CLI can reach the database WITHOUT the connection pooler. Migrations cannot
# run through PgBouncer in transaction-pooling mode: they take session
# advisory locks and issue DDL that must land on a single backend.
#
# A deployment with no pooler (plain Postgres, local dev) has nothing separate
# to point at, and Prisma refuses to load the schema at all when the variable
# is simply missing — every prisma command fails, including the ones below.
# So default it to DATABASE_URL, and let a pooled deployment override it with
# the unpooled host.
if [ -z "$DIRECT_DATABASE_URL" ]; then
  echo "DIRECT_DATABASE_URL not set — falling back to DATABASE_URL for CLI operations."
  DIRECT_DATABASE_URL="$DATABASE_URL"
  export DIRECT_DATABASE_URL
fi

# migrate deploy, NOT db push. db push reconciles the database to the schema
# by any means available, including dropping — a column rename is a drop plus
# a create, so it can silently erase production data with no record of what
# was applied. prisma/migrations/ exists precisely to stop that, and it was
# dead code until this line changed: the container ran db push regardless, so
# _prisma_migrations never advanced. See docs/30-migrations.md.
#
# An existing database built by db push needs `npm run prisma:baseline` once,
# by hand, before the first deploy that runs this.
# Baselines a db-push-built database on its first migrated deploy, so that
# migrate deploy below does not refuse a non-empty schema it has no history
# for. No-op on a fresh database and on one that already has history — see
# prisma/ensure-baseline.ts for why this is not a manual step.
echo "Checking migration baseline..."
npx tsx prisma/ensure-baseline.ts

echo "Applying database migrations..."
npx prisma migrate deploy

# Reference data — roles, permissions, channel types, BILLING PLANS — is not
# demo data and production cannot run without it. It used to live inside the
# demo seed below, which the real service deliberately skips, so a production
# deploy had an empty `plans` table: getEffectivePlan() throws, checkQuota()
# runs on every inbound message with no try/catch, and every channel webhook
# returns 500. Runs unconditionally, and every write in it is an upsert.
echo "Seeding reference data (roles, permissions, channel types, plans)..."
npx tsx prisma/seed-reference.ts

echo "Applying row-level security policies..."
npx tsx prisma/apply-rls.ts

# Seeding used to run unconditionally on every boot — harmless the first
# time, but on a live service it means every redeploy re-runs the same
# script against a database that now holds real customer conversations,
# knowledge, and tickets. Even after fixing seed.ts's own idempotency bug
# (createMany with no real unique key kept duplicating the demo
# conversation's messages/knowledge on every run), a production service
# serving real stores has no business re-running demo-data seeding at
# every startup at all — only the first boot of a brand-new environment
# needs it. Opt-in via SEED_DEMO_DATA=true (set it for a fresh local/demo
# database only); leave unset on the real Render service.
if [ "$SEED_DEMO_DATA" = "true" ]; then
  echo "Seeding demo data (SEED_DEMO_DATA=true)..."
  npx tsx prisma/seed.ts
else
  echo "Skipping demo data seed (set SEED_DEMO_DATA=true to enable)."
fi

# Compiled JS, not `tsx src/index.ts`. See the Dockerfile's `npm run build`.
# `exec` so node becomes PID 1 and receives SIGTERM directly — without it the
# shell holds PID 1, swallows the signal, and the platform escalates to
# SIGKILL after its grace period, cutting in-flight requests instead of
# letting them drain.
echo "Starting Maysoor backend..."
exec node dist/index.js
