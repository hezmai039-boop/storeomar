-- Session revocation + per-run cost forensics.
--
-- IF NOT EXISTS on every column, which Prisma does not generate by default.
-- The reason is the state this migration lands on: databases built by
-- `db push` before migrations existed, some of which may have had a schema
-- delta applied by hand. Re-adding an existing column aborts the whole
-- migration and records it as failed, which blocks every later deploy — for
-- a purely additive change whose desired end state is simply "these columns
-- exist". An additive migration should be safe to meet halfway.

-- AlterTable
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN IF NOT EXISTS "cost_micro_usd" INTEGER;
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN IF NOT EXISTS "input_tokens" INTEGER;
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN IF NOT EXISTS "output_tokens" INTEGER;
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN IF NOT EXISTS "round_trips" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0;
