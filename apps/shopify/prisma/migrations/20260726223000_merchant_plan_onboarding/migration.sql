CREATE TABLE "merchant_plan_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "snapshot_version" TEXT NOT NULL,
  "snapshot_hash" TEXT NOT NULL,
  "relevant_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "insight_run_id" UUID,
  "goal_run_id" UUID,
  "prompt_version" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "provider" TEXT,
  "model_identifier" TEXT,
  "safe_error_code" TEXT,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  "superseded_at" TIMESTAMPTZ(6),
  "result_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_plan_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_plan_recommendations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "primary_goal_id" TEXT NOT NULL,
  "supporting_goal_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "why_this_action" TEXT NOT NULL,
  "why_now" TEXT NOT NULL,
  "start_today" TEXT NOT NULL,
  "execution_steps_json" JSONB NOT NULL DEFAULT '[]',
  "success_signal_json" JSONB NOT NULL DEFAULT '{}',
  "expected_benefit" TEXT NOT NULL,
  "supporting_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "supporting_insight_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "confidence" TEXT NOT NULL,
  "assumption" TEXT,
  "caveat" TEXT,
  "review_status" TEXT NOT NULL DEFAULT 'proposed',
  "accepted_at" TIMESTAMPTZ(6),
  "rejected_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_plan_recommendations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_plan_runs_shop_id_snapshot_hash_prompt_version_schema_version_key"
  ON "merchant_plan_runs"("shop_id", "snapshot_hash", "prompt_version", "schema_version");
CREATE INDEX "merchant_plan_runs_merchant_id_status_created_at_idx"
  ON "merchant_plan_runs"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_plan_runs_shop_id_status_created_at_idx"
  ON "merchant_plan_runs"("shop_id", "status", "created_at");
CREATE INDEX "merchant_plan_runs_snapshot_hash_idx"
  ON "merchant_plan_runs"("snapshot_hash");
CREATE INDEX "merchant_plan_runs_insight_run_id_idx"
  ON "merchant_plan_runs"("insight_run_id");
CREATE INDEX "merchant_plan_runs_goal_run_id_idx"
  ON "merchant_plan_runs"("goal_run_id");

CREATE UNIQUE INDEX "merchant_plan_recommendations_run_id_key"
  ON "merchant_plan_recommendations"("run_id");
CREATE INDEX "merchant_plan_recommendations_merchant_id_review_status_created_at_idx"
  ON "merchant_plan_recommendations"("merchant_id", "review_status", "created_at");
CREATE INDEX "merchant_plan_recommendations_shop_id_review_status_created_at_idx"
  ON "merchant_plan_recommendations"("shop_id", "review_status", "created_at");
CREATE INDEX "merchant_plan_recommendations_primary_goal_id_idx"
  ON "merchant_plan_recommendations"("primary_goal_id");

ALTER TABLE "merchant_plan_runs"
  ADD CONSTRAINT "merchant_plan_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_plan_runs"
  ADD CONSTRAINT "merchant_plan_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_plan_recommendations"
  ADD CONSTRAINT "merchant_plan_recommendations_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "merchant_plan_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_plan_recommendations"
  ADD CONSTRAINT "merchant_plan_recommendations_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_plan_recommendations"
  ADD CONSTRAINT "merchant_plan_recommendations_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
