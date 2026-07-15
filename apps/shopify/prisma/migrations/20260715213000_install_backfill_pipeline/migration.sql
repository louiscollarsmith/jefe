ALTER TABLE "shops"
  ADD COLUMN "setup_status" TEXT NOT NULL DEFAULT 'installed',
  ADD COLUMN "historical_order_access" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "available_order_history_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "backfill_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "backfill_completed_at" TIMESTAMPTZ(6);

CREATE TABLE "customer_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "normalized_email" TEXT NOT NULL,
  "email_hash" TEXT NOT NULL,
  "masked_email" TEXT NOT NULL,
  "first_seen_order_at" TIMESTAMPTZ(6),
  "last_order_at" TIMESTAMPTZ(6),
  "order_count" INTEGER NOT NULL DEFAULT 0,
  "total_spend" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "average_order_value" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL,
  "shopify_customer_id" TEXT,
  "raw_payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "customer_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shop_backfill_statuses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "records_processed" INTEGER NOT NULL DEFAULT 0,
  "total_records_estimate" INTEGER,
  "last_cursor" TEXT,
  "bulk_operation_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "shop_backfill_statuses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "backfill_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "job_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "payload_json" JSONB NOT NULL DEFAULT '{}',
  "result_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "backfill_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_identities_shop_id_email_hash_key"
  ON "customer_identities"("shop_id", "email_hash");
CREATE INDEX "customer_identities_merchant_id_last_order_at_idx"
  ON "customer_identities"("merchant_id", "last_order_at");

CREATE UNIQUE INDEX "shop_backfill_statuses_shop_id_domain_key"
  ON "shop_backfill_statuses"("shop_id", "domain");
CREATE INDEX "shop_backfill_statuses_merchant_id_status_idx"
  ON "shop_backfill_statuses"("merchant_id", "status");

CREATE UNIQUE INDEX "backfill_jobs_shop_id_job_type_key"
  ON "backfill_jobs"("shop_id", "job_type");
CREATE INDEX "backfill_jobs_status_run_after_priority_idx"
  ON "backfill_jobs"("status", "run_after", "priority");
CREATE INDEX "backfill_jobs_merchant_id_status_idx"
  ON "backfill_jobs"("merchant_id", "status");

ALTER TABLE "customer_identities"
  ADD CONSTRAINT "customer_identities_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_identities_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shop_backfill_statuses"
  ADD CONSTRAINT "shop_backfill_statuses_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "shop_backfill_statuses_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "backfill_jobs"
  ADD CONSTRAINT "backfill_jobs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "backfill_jobs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
