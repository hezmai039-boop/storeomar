-- Three levels of "should the AI answer this?": store → channel → conversation.
--
-- The store level already existed (ai_agents.status = 'paused'). This adds the
-- two narrower ones.
--
-- Purely additive, and every default preserves today's behaviour exactly:
--   channel_accounts.ai_enabled  DEFAULT true   — a channel connected before
--     this column existed was connected in order to be answered.
--   conversations.ai_paused      DEFAULT false  — no conversation was ever
--     paused before, because there was no way to pause one.
--
-- So this migration is safe to apply while the service is running and while
-- the previous release is still serving traffic: the old code never reads
-- these columns, and the new code reads values that mean "carry on as before".
-- See docs/29-safe-evolution.md §"أثناء النشر: النسختان تعملان معًا".
--
-- IF NOT EXISTS for the same reason as every other additive migration here —
-- this may land on a database where a column was added by hand. Re-adding an
-- existing column aborts the whole migration and records it as failed, which
-- blocks every later deploy, for a change whose desired end state is simply
-- "these columns exist".

-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "ai_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "ai_paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "ai_paused_at" TIMESTAMPTZ(6);
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "ai_paused_by" UUID;

-- No foreign key on ai_paused_by, on purpose: it is a display/audit
-- attribution, and a deleted staff account must not either block the delete
-- (RESTRICT) or silently erase the record that a human took this conversation
-- over (SET NULL would, but only after the FK made the delete a decision at
-- all). The inbox falls back to "موظف" when the id no longer resolves.
