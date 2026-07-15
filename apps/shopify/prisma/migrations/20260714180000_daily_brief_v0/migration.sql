ALTER TABLE "daily_briefs"
  ADD COLUMN "period_start" TIMESTAMPTZ(6),
  ADD COLUMN "period_end" TIMESTAMPTZ(6),
  ADD COLUMN "generated_at" TIMESTAMPTZ(6),
  ADD COLUMN "confidence_level" TEXT,
  ADD COLUMN "headline" TEXT,
  ADD COLUMN "sections" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "delivery_status" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "data_incomplete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "degraded_reasons" JSONB NOT NULL DEFAULT '[]';
