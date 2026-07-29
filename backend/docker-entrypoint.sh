#!/bin/sh
set -e

# migrate deploy, NOT db push. db push reconciles the database to the schema
# by any means available, including dropping — a column rename is a drop plus
# a create, so it can silently erase production data with no record of what
# was applied. prisma/migrations/ exists precisely to stop that, and it was
# dead code until this line changed: the container ran db push regardless, so
# _prisma_migrations never advanced. See docs/30-migrations.md.
#
# An existing database built by db push needs `npm run prisma:baseline` once,
# by hand, before the first deploy that runs this.
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

echo "Starting Atlas backend..."
exec npx tsx src/index.ts
