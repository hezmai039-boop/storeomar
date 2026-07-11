#!/bin/sh
set -e

echo "Waiting for Postgres..."
until node -e "require('net').connect(5432,'postgres').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; do
  sleep 1
done

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate

echo "Applying row-level security policies..."
npx tsx prisma/apply-rls.ts

echo "Seeding demo data..."
npx tsx prisma/seed.ts

echo "Starting Atlas backend..."
exec npx tsx src/index.ts
