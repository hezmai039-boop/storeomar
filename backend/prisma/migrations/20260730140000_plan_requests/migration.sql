-- Landing-page plan requests (leads). Purely additive: one new table, three
-- optional foreign keys out of it, nothing touched on any existing table.
--
-- IF NOT EXISTS / conditional constraints for the same reason as
-- 20260729120000: this lands on databases that were built by `db push` before
-- migrations existed, where an object may already be present. An additive
-- migration should be safe to meet halfway rather than aborting and blocking
-- every later deploy — see docs/30-migrations.md.

-- CreateTable
CREATE TABLE IF NOT EXISTS "plan_requests" (
    "id" UUID NOT NULL,
    "plan_id" UUID,
    "plan_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "store_name" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "source" TEXT NOT NULL DEFAULT 'landing',
    "ip" TEXT,
    "organization_id" UUID,
    "handled_by" UUID,
    "handled_at" TIMESTAMPTZ(6),
    "handle_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plan_requests_status_created_at_idx" ON "plan_requests"("status", "created_at");
CREATE INDEX IF NOT EXISTS "plan_requests_email_idx" ON "plan_requests"("email");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_requests_plan_id_fkey') THEN
    ALTER TABLE "plan_requests" ADD CONSTRAINT "plan_requests_plan_id_fkey"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_requests_organization_id_fkey') THEN
    ALTER TABLE "plan_requests" ADD CONSTRAINT "plan_requests_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_requests_handled_by_fkey') THEN
    ALTER TABLE "plan_requests" ADD CONSTRAINT "plan_requests_handled_by_fkey"
      FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
