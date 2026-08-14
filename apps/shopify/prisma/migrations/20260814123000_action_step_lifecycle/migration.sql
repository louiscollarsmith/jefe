-- Durable action-step lifecycle state. Additive: existing recommendation steps
-- keep their current status, and new metadata is optional/defaulted.
ALTER TABLE "merchant_recommendation_steps"
  ADD COLUMN "status_reason" TEXT,
  ADD COLUMN "progress_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "attention_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "started_at" TIMESTAMPTZ(6),
  ADD COLUMN "completed_at" TIMESTAMPTZ(6);

CREATE TABLE "merchant_recommendation_step_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "step_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "actor" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "idempotency_key" TEXT NOT NULL,
  "action_execution_run_id" UUID,
  "result_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);

CREATE UNIQUE INDEX "merchant_recommendation_step_runs_step_id_idempotency_key_key"
  ON "merchant_recommendation_step_runs"("step_id", "idempotency_key");
CREATE INDEX "merchant_recommendation_step_runs_merchant_id_shop_id_statu_idx"
  ON "merchant_recommendation_step_runs"("merchant_id", "shop_id", "status", "queued_at");
CREATE INDEX "merchant_recommendation_step_runs_shop_id_status_queued_at_idx"
  ON "merchant_recommendation_step_runs"("shop_id", "status", "queued_at");
CREATE INDEX "merchant_recommendation_step_runs_action_execution_run_id_idx"
  ON "merchant_recommendation_step_runs"("action_execution_run_id");

ALTER TABLE "merchant_recommendation_step_runs"
  ADD CONSTRAINT "merchant_recommendation_step_runs_step_id_fkey"
  FOREIGN KEY ("step_id") REFERENCES "merchant_recommendation_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_step_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_step_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_step_runs_action_execution_run_id_fkey"
  FOREIGN KEY ("action_execution_run_id") REFERENCES "action_executions"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;
