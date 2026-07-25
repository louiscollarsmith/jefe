ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "onboarding_started_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "goals_completed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "house_rules_completed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cogs_completion_percentage" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cogs_confidence_level" TEXT NOT NULL DEFAULT 'missing',
  ADD COLUMN IF NOT EXISTS "onboarding_metadata" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "shops_onboarding_completed_at_idx"
  ON "shops"("onboarding_completed_at");
