#!/bin/sh
set -e

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate

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
