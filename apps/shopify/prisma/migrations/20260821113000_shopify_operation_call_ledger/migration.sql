-- Ledger every Shopify Admin GraphQL operation the universal gateway admits or
-- denies. Reads need provenance too, so this sits beside the existing
-- action_execution_writes per-target write ledger instead of replacing it.

CREATE TABLE "shopify_operation_calls" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "merchant_action_id" UUID,
  "action_execution_id" UUID,
  "accepted_action_revision" TEXT,
  "shop_domain" TEXT NOT NULL,
  "api_version" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "operation_name" TEXT NOT NULL,
  "operation_kind" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT '',
  "expected_effect" TEXT NOT NULL DEFAULT '',
  "idempotency_key" TEXT,
  "variables_json" JSONB NOT NULL DEFAULT '{}',
  "variables_hash" TEXT NOT NULL DEFAULT '',
  "gateway_decision" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "user_errors_json" JSONB NOT NULL DEFAULT '[]',
  "resource_ids_json" JSONB NOT NULL DEFAULT '[]',
  "response_summary_json" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shopify_operation_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shopify_operation_calls_merchant_id_shop_id_created_at_idx"
  ON "shopify_operation_calls"("merchant_id", "shop_id", "created_at");

CREATE INDEX "shopify_operation_calls_merchant_action_id_created_at_idx"
  ON "shopify_operation_calls"("merchant_action_id", "created_at");

CREATE INDEX "shopify_operation_calls_action_execution_id_created_at_idx"
  ON "shopify_operation_calls"("action_execution_id", "created_at");

CREATE INDEX "shopify_operation_calls_operation_name_status_idx"
  ON "shopify_operation_calls"("operation_name", "status");

ALTER TABLE "shopify_operation_calls"
  ADD CONSTRAINT "shopify_operation_calls_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shopify_operation_calls"
  ADD CONSTRAINT "shopify_operation_calls_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shopify_operation_calls"
  ADD CONSTRAINT "shopify_operation_calls_merchant_action_id_fkey"
  FOREIGN KEY ("merchant_action_id") REFERENCES "merchant_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shopify_operation_calls"
  ADD CONSTRAINT "shopify_operation_calls_action_execution_id_fkey"
  FOREIGN KEY ("action_execution_id") REFERENCES "action_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
