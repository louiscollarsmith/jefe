ALTER TABLE "merchant_insight_runs"
  ADD COLUMN "source_mode" TEXT NOT NULL DEFAULT 'full';

ALTER TABLE "merchant_memory_beliefs"
  ADD COLUMN "derivation_source_mode" TEXT NOT NULL DEFAULT 'full';

ALTER TABLE "merchant_plan_runs"
  ADD COLUMN "source_mode" TEXT NOT NULL DEFAULT 'full';

ALTER TABLE "merchant_plan_recommendations"
  ALTER COLUMN "primary_goal_id" DROP NOT NULL,
  ADD COLUMN "source_mode" TEXT NOT NULL DEFAULT 'full',
  ADD COLUMN "action_intent_json" JSONB,
  ADD COLUMN "review_at" TIMESTAMPTZ,
  ADD COLUMN "outcome_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "outcome_measured_at" TIMESTAMPTZ,
  ADD COLUMN "outcome_json" JSONB;

ALTER TABLE "action_executions"
  ADD COLUMN "source_recommendation_id" UUID;

CREATE UNIQUE INDEX "action_executions_source_recommendation_id_key"
  ON "action_executions"("source_recommendation_id");

ALTER TABLE "action_executions"
  ADD CONSTRAINT "action_executions_source_recommendation_id_fkey"
  FOREIGN KEY ("source_recommendation_id") REFERENCES "merchant_plan_recommendations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "activity_events"
  ADD COLUMN "dedupe_key" TEXT;

CREATE UNIQUE INDEX "activity_events_dedupe_key_key"
  ON "activity_events"("dedupe_key");

CREATE TABLE "onboarding_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onboarding_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboarding_handoffs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "onboarding_handoffs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "onboarding_handoffs_token_hash_key"
  ON "onboarding_handoffs"("token_hash");

CREATE INDEX "onboarding_handoffs_shop_id_consumed_at_expires_at_idx"
  ON "onboarding_handoffs"("shop_id", "consumed_at", "expires_at");
