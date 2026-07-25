CREATE TABLE "merchant_insight_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "belief_snapshot_version" TEXT NOT NULL,
  "belief_snapshot_hash" TEXT NOT NULL,
  "relevant_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "memory_refresh_run_id" UUID,
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
  CONSTRAINT "merchant_insight_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_insight_findings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "order_index" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "finding" TEXT NOT NULL,
  "why_it_matters" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "caveat" TEXT,
  "supporting_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "review_status" TEXT NOT NULL DEFAULT 'unreviewed',
  "reviewed_at" TIMESTAMPTZ(6),
  "corrected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_insight_findings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_insight_runs_shop_id_belief_snapshot_hash_prompt_ver_key"
  ON "merchant_insight_runs"("shop_id", "belief_snapshot_hash", "prompt_version", "schema_version");
CREATE INDEX "merchant_insight_runs_merchant_id_status_created_at_idx"
  ON "merchant_insight_runs"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_insight_runs_shop_id_status_created_at_idx"
  ON "merchant_insight_runs"("shop_id", "status", "created_at");
CREATE INDEX "merchant_insight_runs_belief_snapshot_hash_idx"
  ON "merchant_insight_runs"("belief_snapshot_hash");

CREATE UNIQUE INDEX "merchant_insight_findings_run_id_order_index_key"
  ON "merchant_insight_findings"("run_id", "order_index");
CREATE INDEX "merchant_insight_findings_merchant_id_review_status_idx"
  ON "merchant_insight_findings"("merchant_id", "review_status");
CREATE INDEX "merchant_insight_findings_shop_id_review_status_idx"
  ON "merchant_insight_findings"("shop_id", "review_status");

ALTER TABLE "merchant_insight_runs"
  ADD CONSTRAINT "merchant_insight_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_insight_runs"
  ADD CONSTRAINT "merchant_insight_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_insight_findings"
  ADD CONSTRAINT "merchant_insight_findings_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "merchant_insight_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_insight_findings"
  ADD CONSTRAINT "merchant_insight_findings_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_insight_findings"
  ADD CONSTRAINT "merchant_insight_findings_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
