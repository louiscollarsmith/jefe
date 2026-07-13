ALTER TABLE "shops"
  ADD COLUMN "onboarding_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "goals_completed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "house_rules_completed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cogs_completion_percentage" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "cogs_confidence_level" TEXT NOT NULL DEFAULT 'missing',
  ADD COLUMN "onboarding_metadata" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "cogs_inputs"
  ADD COLUMN "confidence_level" TEXT NOT NULL DEFAULT 'confirmed',
  ADD COLUMN "confirmed_by_merchant" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "shops_onboarding_completed_at_idx"
  ON "shops"("onboarding_completed_at");
