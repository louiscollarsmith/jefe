-- Add the minimum durable Merchant Memory foundation without changing existing commerce tables.

CREATE TABLE "merchant_memory_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "title" TEXT NOT NULL DEFAULT 'Merchant Memory',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "current_version_number" INTEGER,
  "current_version_id" UUID,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "document_id" UUID NOT NULL,
  "version_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "generated_by" TEXT NOT NULL DEFAULT 'system',
  "generation_reason" TEXT NOT NULL DEFAULT 'initial_synthesis',
  "document_json" JSONB NOT NULL DEFAULT '{}',
  "source_snapshot" JSONB NOT NULL DEFAULT '{}',
  "summary" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(6),
  "superseded_at" TIMESTAMPTZ(6),

  CONSTRAINT "merchant_memory_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_evidence_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "evidence_type" TEXT NOT NULL,
  "fact_key" TEXT,
  "summary" TEXT NOT NULL,
  "value_json" JSONB NOT NULL DEFAULT '{}',
  "source_system" TEXT,
  "source_table" TEXT,
  "source_record_id" TEXT,
  "ledger_event_id" UUID,
  "observed_at" TIMESTAMPTZ(6),
  "computed_at" TIMESTAMPTZ(6),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_evidence_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "version_id" UUID NOT NULL,
  "section_key" TEXT NOT NULL,
  "claim_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'model_inference',
  "confidence" DECIMAL(5,4),
  "statement" TEXT NOT NULL,
  "normalized_value" JSONB NOT NULL DEFAULT '{}',
  "evidence_summary" JSONB NOT NULL DEFAULT '[]',
  "supersedes_claim_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_claims_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_claim_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "claim_id" UUID NOT NULL,
  "evidence_item_id" UUID,
  "ledger_event_id" UUID,
  "relationship" TEXT NOT NULL DEFAULT 'supports',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_claim_evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_corrections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "version_id" UUID,
  "claim_id" UUID,
  "merchant_user_id" UUID,
  "correction_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'applied',
  "original_text" TEXT,
  "corrected_text" TEXT,
  "correction_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_corrections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_open_questions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "version_id" UUID,
  "section_key" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "reason" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "status" TEXT NOT NULL DEFAULT 'open',
  "answer_json" JSONB NOT NULL DEFAULT '{}',
  "answered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_memory_open_questions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "merchant_memory_documents_merchant_id_status_idx"
  ON "merchant_memory_documents"("merchant_id", "status");
CREATE INDEX "merchant_memory_documents_shop_id_idx"
  ON "merchant_memory_documents"("shop_id");

CREATE UNIQUE INDEX "merchant_memory_versions_document_id_version_number_key"
  ON "merchant_memory_versions"("document_id", "version_number");
CREATE INDEX "merchant_memory_versions_merchant_id_status_created_at_idx"
  ON "merchant_memory_versions"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_memory_versions_shop_id_idx"
  ON "merchant_memory_versions"("shop_id");

CREATE INDEX "merchant_memory_evidence_items_merchant_id_evidence_type_created_at_idx"
  ON "merchant_memory_evidence_items"("merchant_id", "evidence_type", "created_at");
CREATE INDEX "merchant_memory_evidence_items_shop_id_idx"
  ON "merchant_memory_evidence_items"("shop_id");
CREATE INDEX "merchant_memory_evidence_items_ledger_event_id_idx"
  ON "merchant_memory_evidence_items"("ledger_event_id");

CREATE INDEX "merchant_memory_claims_merchant_id_status_section_key_idx"
  ON "merchant_memory_claims"("merchant_id", "status", "section_key");
CREATE INDEX "merchant_memory_claims_version_id_section_key_idx"
  ON "merchant_memory_claims"("version_id", "section_key");
CREATE INDEX "merchant_memory_claims_supersedes_claim_id_idx"
  ON "merchant_memory_claims"("supersedes_claim_id");

CREATE INDEX "merchant_memory_claim_evidence_claim_id_idx"
  ON "merchant_memory_claim_evidence"("claim_id");
CREATE INDEX "merchant_memory_claim_evidence_evidence_item_id_idx"
  ON "merchant_memory_claim_evidence"("evidence_item_id");
CREATE INDEX "merchant_memory_claim_evidence_ledger_event_id_idx"
  ON "merchant_memory_claim_evidence"("ledger_event_id");

CREATE INDEX "merchant_memory_corrections_merchant_id_created_at_idx"
  ON "merchant_memory_corrections"("merchant_id", "created_at");
CREATE INDEX "merchant_memory_corrections_claim_id_idx"
  ON "merchant_memory_corrections"("claim_id");
CREATE INDEX "merchant_memory_corrections_version_id_idx"
  ON "merchant_memory_corrections"("version_id");

CREATE INDEX "merchant_memory_open_questions_merchant_id_status_priority_idx"
  ON "merchant_memory_open_questions"("merchant_id", "status", "priority");
CREATE INDEX "merchant_memory_open_questions_version_id_idx"
  ON "merchant_memory_open_questions"("version_id");

ALTER TABLE "merchant_memory_documents"
  ADD CONSTRAINT "merchant_memory_documents_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_documents_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_versions"
  ADD CONSTRAINT "merchant_memory_versions_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_versions_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_versions_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "merchant_memory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_evidence_items"
  ADD CONSTRAINT "merchant_memory_evidence_items_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_evidence_items_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_evidence_items_ledger_event_id_fkey"
  FOREIGN KEY ("ledger_event_id") REFERENCES "ledger_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_claims"
  ADD CONSTRAINT "merchant_memory_claims_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_claims_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_claims_version_id_fkey"
  FOREIGN KEY ("version_id") REFERENCES "merchant_memory_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_claims_supersedes_claim_id_fkey"
  FOREIGN KEY ("supersedes_claim_id") REFERENCES "merchant_memory_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_claim_evidence"
  ADD CONSTRAINT "merchant_memory_claim_evidence_claim_id_fkey"
  FOREIGN KEY ("claim_id") REFERENCES "merchant_memory_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_claim_evidence_evidence_item_id_fkey"
  FOREIGN KEY ("evidence_item_id") REFERENCES "merchant_memory_evidence_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_claim_evidence_ledger_event_id_fkey"
  FOREIGN KEY ("ledger_event_id") REFERENCES "ledger_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_corrections"
  ADD CONSTRAINT "merchant_memory_corrections_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_corrections_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_corrections_version_id_fkey"
  FOREIGN KEY ("version_id") REFERENCES "merchant_memory_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_corrections_claim_id_fkey"
  FOREIGN KEY ("claim_id") REFERENCES "merchant_memory_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_corrections_merchant_user_id_fkey"
  FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_open_questions"
  ADD CONSTRAINT "merchant_memory_open_questions_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_open_questions_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_memory_open_questions_version_id_fkey"
  FOREIGN KEY ("version_id") REFERENCES "merchant_memory_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
