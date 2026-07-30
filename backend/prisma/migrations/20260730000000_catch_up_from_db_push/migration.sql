-- Catch-up migration: brings a database built by `prisma db push` (before
-- migrations existed) up to the schema 0_init describes.
--
-- Why this is needed at all. 0_init contains all 39 tables. The production
-- database predates this PR and has 33 — no billing, no auth_tokens, no
-- oauth_states. ensure-baseline.ts records 0_init as applied so that
-- migrate deploy will run at all, and that recording is a claim about
-- history, not a change to the schema: Prisma then SKIPS 0_init, and the six
-- missing tables would never be created. Tested against a replica of
-- production, that is exactly what happened — `plans does not exist` after a
-- clean deploy, which is the failure the whole billing layer sits on.
--
-- So this migration carries the delta between the pre-migration schema and
-- 0_init, and every statement is idempotent (IF NOT EXISTS). On a fresh
-- database 0_init creates everything and this runs as a no-op; on a
-- db-push database 0_init is skipped and this creates precisely what is
-- absent. Both paths converge on the same schema.
--
-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL, so each
-- foreign key is guarded by a DO block instead.

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ai_response_logs" ADD COLUMN IF NOT EXISTS "cost_micro_usd" INTEGER,
ADD COLUMN IF NOT EXISTS "input_tokens" INTEGER,
ADD COLUMN IF NOT EXISTS "model" TEXT,
ADD COLUMN IF NOT EXISTS "output_tokens" INTEGER;

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "token_expires_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN IF NOT EXISTS "cost_micro_usd" INTEGER,
ADD COLUMN IF NOT EXISTS "input_tokens" INTEGER,
ADD COLUMN IF NOT EXISTS "model" TEXT,
ADD COLUMN IF NOT EXISTS "output_tokens" INTEGER,
ADD COLUMN IF NOT EXISTS "round_trips" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "plans" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "price_halalas" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "interval" TEXT NOT NULL DEFAULT 'monthly',
    "max_stores" INTEGER,
    "max_users" INTEGER,
    "max_ai_replies_monthly" INTEGER,
    "features" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trialing',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "provider_ref" TEXT,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "trial_ends_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "usage_counters" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "ai_replies" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "subtotal_halalas" INTEGER NOT NULL,
    "vat_halalas" INTEGER NOT NULL DEFAULT 0,
    "total_halalas" INTEGER NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "transfer_ref" TEXT,
    "receipt_url" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "oauth_states" (
    "id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "store_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "usage_counters_period_idx" ON "usage_counters"("period");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_organization_id_period_key" ON "usage_counters"("organization_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invoices_organization_id_created_at_idx" ON "invoices"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invoices_status_created_at_idx" ON "invoices"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_organization_id_fkey') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_id_fkey') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_counters_organization_id_fkey') THEN
    ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_organization_id_fkey') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_plan_id_fkey') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_reviewed_by_fkey') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_tokens_user_id_fkey') THEN
    ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

