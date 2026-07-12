#!/bin/sh
set -e

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate

echo "Applying row-level security policies..."
npx tsx prisma/apply-rls.ts

echo "Seeding demo data..."
npx tsx prisma/seed.ts

echo "Starting Atlas backend..."
exec npx tsx src/index.ts
