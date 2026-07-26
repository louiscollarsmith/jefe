CREATE TABLE "merchant_goal_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "belief_snapshot_version" TEXT NOT NULL,
  "belief_snapshot_hash" TEXT NOT NULL,
  "relevant_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "insight_run_id" UUID,
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

  CONSTRAINT "merchant_goal_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_goal_horizons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "horizon" TEXT NOT NULL,
  "order_index" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "supporting_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "memory_belief_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_goal_horizons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_goal_runs_shop_id_belief_snapshot_hash_prompt_version_schema_version_key"
  ON "merchant_goal_runs"("shop_id", "belief_snapshot_hash", "prompt_version", "schema_version");
CREATE INDEX "merchant_goal_runs_merchant_id_status_created_at_idx"
  ON "merchant_goal_runs"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_goal_runs_shop_id_status_created_at_idx"
  ON "merchant_goal_runs"("shop_id", "status", "created_at");
CREATE INDEX "merchant_goal_runs_belief_snapshot_hash_idx"
  ON "merchant_goal_runs"("belief_snapshot_hash");
CREATE INDEX "merchant_goal_runs_insight_run_id_idx"
  ON "merchant_goal_runs"("insight_run_id");

CREATE UNIQUE INDEX "merchant_goal_horizons_run_id_horizon_key"
  ON "merchant_goal_horizons"("run_id", "horizon");
CREATE UNIQUE INDEX "merchant_goal_horizons_run_id_order_index_key"
  ON "merchant_goal_horizons"("run_id", "order_index");
CREATE INDEX "merchant_goal_horizons_merchant_id_horizon_idx"
  ON "merchant_goal_horizons"("merchant_id", "horizon");
CREATE INDEX "merchant_goal_horizons_shop_id_horizon_idx"
  ON "merchant_goal_horizons"("shop_id", "horizon");
CREATE INDEX "merchant_goal_horizons_memory_belief_id_idx"
  ON "merchant_goal_horizons"("memory_belief_id");

ALTER TABLE "merchant_goal_runs"
  ADD CONSTRAINT "merchant_goal_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_goal_runs"
  ADD CONSTRAINT "merchant_goal_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_goal_horizons"
  ADD CONSTRAINT "merchant_goal_horizons_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "merchant_goal_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_goal_horizons"
  ADD CONSTRAINT "merchant_goal_horizons_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_goal_horizons"
  ADD CONSTRAINT "merchant_goal_horizons_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
