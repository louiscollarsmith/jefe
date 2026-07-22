-- Add the Merchant Memory foundation as a domain above retained raw commerce evidence.

CREATE TABLE "merchant_memory_beliefs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "category" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value_json" JSONB NOT NULL DEFAULT '{}',
  "value_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'inferred',
  "confidence" DECIMAL(5,4),
  "confidence_reason" TEXT,
  "precedence" INTEGER NOT NULL DEFAULT 20,
  "derivation_version" TEXT,
  "first_observed_at" TIMESTAMPTZ(6),
  "last_observed_at" TIMESTAMPTZ(6),
  "last_evaluated_at" TIMESTAMPTZ(6),
  "last_confirmed_at" TIMESTAMPTZ(6),
  "superseded_at" TIMESTAMPTZ(6),
  "supersedes_belief_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_beliefs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "belief_id" UUID,
  "source_type" TEXT NOT NULL,
  "source_reference" TEXT,
  "evidence_type" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "observed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_belief_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "belief_id" UUID,
  "key" TEXT NOT NULL,
  "previous_status" TEXT,
  "new_status" TEXT NOT NULL,
  "previous_value_json" JSONB,
  "new_value_json" JSONB,
  "change_reason" TEXT NOT NULL,
  "changed_by" TEXT NOT NULL DEFAULT 'system',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_belief_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_refresh_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "refresh_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requested_categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "result_json" JSONB NOT NULL DEFAULT '{}',
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_refresh_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "merchant_memory_beliefs_merchant_id_category_key_idx"
  ON "merchant_memory_beliefs"("merchant_id", "category", "key");
CREATE INDEX "merchant_memory_beliefs_merchant_id_status_idx"
  ON "merchant_memory_beliefs"("merchant_id", "status");
CREATE INDEX "merchant_memory_beliefs_shop_id_idx"
  ON "merchant_memory_beliefs"("shop_id");
CREATE INDEX "merchant_memory_beliefs_supersedes_belief_id_idx"
  ON "merchant_memory_beliefs"("supersedes_belief_id");
CREATE UNIQUE INDEX "merchant_memory_beliefs_current_key_unique"
  ON "merchant_memory_beliefs"("merchant_id", "key")
  WHERE "status" IN ('inferred', 'merchant_confirmed', 'merchant_corrected');

CREATE INDEX "merchant_memory_evidence_merchant_id_evidence_type_created_at_idx"
  ON "merchant_memory_evidence"("merchant_id", "evidence_type", "created_at");
CREATE INDEX "merchant_memory_evidence_belief_id_created_at_idx"
  ON "merchant_memory_evidence"("belief_id", "created_at");
CREATE INDEX "merchant_memory_evidence_shop_id_idx"
  ON "merchant_memory_evidence"("shop_id");

CREATE INDEX "merchant_memory_belief_history_merchant_id_key_created_at_idx"
  ON "merchant_memory_belief_history"("merchant_id", "key", "created_at");
CREATE INDEX "merchant_memory_belief_history_belief_id_created_at_idx"
  ON "merchant_memory_belief_history"("belief_id", "created_at");
CREATE INDEX "merchant_memory_belief_history_shop_id_idx"
  ON "merchant_memory_belief_history"("shop_id");

CREATE INDEX "merchant_memory_refresh_runs_merchant_id_status_created_at_idx"
  ON "merchant_memory_refresh_runs"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_memory_refresh_runs_shop_id_status_idx"
  ON "merchant_memory_refresh_runs"("shop_id", "status");

ALTER TABLE "merchant_memory_beliefs"
  ADD CONSTRAINT "merchant_memory_beliefs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_beliefs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_beliefs_supersedes_belief_id_fkey"
  FOREIGN KEY ("supersedes_belief_id") REFERENCES "merchant_memory_beliefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_evidence"
  ADD CONSTRAINT "merchant_memory_evidence_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_evidence_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_evidence_belief_id_fkey"
  FOREIGN KEY ("belief_id") REFERENCES "merchant_memory_beliefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_belief_history"
  ADD CONSTRAINT "merchant_memory_belief_history_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_belief_history_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_belief_history_belief_id_fkey"
  FOREIGN KEY ("belief_id") REFERENCES "merchant_memory_beliefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_refresh_runs"
  ADD CONSTRAINT "merchant_memory_refresh_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_refresh_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
