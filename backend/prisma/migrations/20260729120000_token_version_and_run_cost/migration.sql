-- AlterTable
ALTER TABLE "ai_orchestrator_runs" ADD COLUMN     "cost_micro_usd" INTEGER,
ADD COLUMN     "input_tokens" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "output_tokens" INTEGER,
ADD COLUMN     "round_trips" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;

