-- WhatsApp Embedded Signup (Meta) — the identity Meta hands back during the
-- official signup flow. Everything here is ADDITIVE and NULLABLE on purpose:
-- every existing manually-connected channel account predates this flow and
-- must keep working untouched. `external_account_id` stays the canonical
-- routing key for webhooks; `phone_number_id` mirrors it explicitly for
-- accounts created by the ES flow so the column names match Meta's own
-- vocabulary when debugging against the Graph API.
ALTER TABLE "channel_accounts"
  ADD COLUMN "waba_id" TEXT,
  ADD COLUMN "business_id" TEXT,
  ADD COLUMN "phone_number_id" TEXT,
  ADD COLUMN "app_scoped_user_id" TEXT,
  ADD COLUMN "token_type" TEXT,
  ADD COLUMN "token_scopes" JSONB NOT NULL DEFAULT '[]';

-- "Which stores belong to this WABA?" is the sweep the token-refresh job
-- runs; without an index it is a sequential scan on every pass.
CREATE INDEX "channel_accounts_waba_id_idx" ON "channel_accounts"("waba_id");

-- PKCE verifier for OAuth flows that support it (Meta Embedded Signup).
-- Nullable: the Salla/Zid rows never carry one.
ALTER TABLE "oauth_states" ADD COLUMN "code_verifier" TEXT;
