CREATE TABLE "store_understanding_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "trigger" TEXT NOT NULL DEFAULT 'post_memory_rebuild',
  "input_summary_version" TEXT NOT NULL,
  "input_summary_hash" TEXT,
  "derivation_version" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "candidate_count" INTEGER NOT NULL DEFAULT 0,
  "accepted_count" INTEGER NOT NULL DEFAULT 0,
  "rejected_count" INTEGER NOT NULL DEFAULT 0,
  "obsolete_count" INTEGER NOT NULL DEFAULT 0,
  "result_json" JSONB NOT NULL DEFAULT '{}',
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "store_understanding_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_understanding_runs_merchant_id_status_created_at_idx"
  ON "store_understanding_runs"("merchant_id", "status", "created_at");

CREATE INDEX "store_understanding_runs_shop_id_status_idx"
  ON "store_understanding_runs"("shop_id", "status");

CREATE INDEX "store_understanding_runs_input_summary_hash_idx"
  ON "store_understanding_runs"("input_summary_hash");

ALTER TABLE "store_understanding_runs"
  ADD CONSTRAINT "store_understanding_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "store_understanding_runs"
  ADD CONSTRAINT "store_understanding_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
