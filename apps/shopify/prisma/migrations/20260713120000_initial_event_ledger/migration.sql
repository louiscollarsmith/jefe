-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Enable database-generated UUID primary keys.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "verification_class" AS ENUM ('verified', 'estimated');

-- CreateEnum
CREATE TYPE "goal_horizon" AS ENUM ('3_months', '6_months', '12_months');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "primary_currency" TEXT NOT NULL DEFAULT 'GBP',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "goals_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "shop_domain" TEXT NOT NULL,
    "external_shop_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "status" TEXT NOT NULL DEFAULT 'active',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "house_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "structured_rules" JSONB NOT NULL DEFAULT '{}',
    "free_text_rules" TEXT,
    "max_discount_bps" INTEGER,
    "email_frequency_rules" JSONB NOT NULL DEFAULT '{}',
    "brand_voice_rules" JSONB NOT NULL DEFAULT '{}',
    "protected_products" JSONB NOT NULL DEFAULT '[]',
    "margin_priority_rules" JSONB NOT NULL DEFAULT '{}',
    "seasonal_priorities" JSONB NOT NULL DEFAULT '{}',
    "risky_action_rules" JSONB NOT NULL DEFAULT '{}',
    "last_edited_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "house_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "horizon" "goal_horizon" NOT NULL,
    "description" TEXT NOT NULL,
    "metric" TEXT,
    "target_value" DECIMAL(18,2),
    "currency" TEXT DEFAULT 'GBP',
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "event_type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_event_id" TEXT,
    "dedupe_key" TEXT,
    "idempotency_key" TEXT,
    "actor_type" TEXT,
    "actor_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "event_ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "status" TEXT,
    "vendor" TEXT,
    "product_type" TEXT,
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT,
    "price" DECIMAL(18,2),
    "currency" TEXT DEFAULT 'GBP',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "order_name" TEXT,
    "customer_external_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "subtotal_price" DECIMAL(18,2),
    "total_price" DECIMAL(18,2),
    "total_discount" DECIMAL(18,2),
    "total_tax" DECIMAL(18,2),
    "total_shipping" DECIMAL(18,2),
    "processed_at" TIMESTAMPTZ(6),
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID,
    "variant_id" UUID,
    "external_id" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(18,2),
    "total_price" DECIMAL(18,2),
    "discount" DECIMAL(18,2),
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "reason" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_levels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "variant_id" UUID,
    "inventory_item_external_id" TEXT,
    "location_external_id" TEXT NOT NULL,
    "available" INTEGER,
    "committed" INTEGER,
    "incoming" INTEGER,
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cogs_inputs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "product_id" UUID,
    "variant_id" UUID,
    "sku" TEXT,
    "cost_amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "source" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cogs_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_briefs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "brief_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "channel" TEXT NOT NULL DEFAULT 'app',
    "verdict" JSONB NOT NULL DEFAULT '{}',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "idempotency_key" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "daily_brief_id" UUID,
    "action_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "expected_value" JSONB NOT NULL DEFAULT '{}',
    "confidence" DECIMAL(5,4),
    "risk_level" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "rules_consulted" JSONB NOT NULL DEFAULT '[]',
    "rule_constraints_applied" JSONB NOT NULL DEFAULT '[]',
    "preview" JSONB NOT NULL DEFAULT '{}',
    "verification_class" "verification_class" NOT NULL,
    "idempotency_key" TEXT,
    "proposed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "action_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "connector" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "request" JSONB NOT NULL DEFAULT '{}',
    "response" JSONB NOT NULL DEFAULT '{}',
    "error" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "action_id" UUID,
    "daily_brief_id" UUID,
    "merchant_user_id" UUID,
    "feedback_type" TEXT NOT NULL,
    "sentiment" TEXT,
    "severity" TEXT,
    "raw_text" TEXT,
    "distilled_summary" TEXT,
    "implied_request" TEXT,
    "status" TEXT NOT NULL DEFAULT 'captured',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provenance_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "source_event_id" UUID,
    "source_table" TEXT,
    "source_record_id" UUID,
    "url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provenance_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holdout_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "action_id" UUID NOT NULL,
    "variant_id" UUID,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT,
    "subject_external_id" TEXT,
    "assignment_group" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holdout_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "action_id" UUID NOT NULL,
    "verification_class" "verification_class" NOT NULL,
    "method" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "incremental_revenue" DECIMAL(18,2),
    "incremental_margin" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "result" JSONB NOT NULL DEFAULT '{}',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "connector" TEXT NOT NULL,
    "account_external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "read_token_ref" TEXT,
    "write_token_ref" TEXT,
    "auth_metadata" JSONB NOT NULL DEFAULT '{}',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "connected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "connector_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_metering" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "usage_date" DATE NOT NULL,
    "provider" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "cost_amount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_metering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shops_merchant_id_idx" ON "shops"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_platform_shop_domain_key" ON "shops"("platform", "shop_domain");

-- CreateIndex
CREATE INDEX "merchant_users_shop_id_idx" ON "merchant_users"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_users_merchant_id_email_key" ON "merchant_users"("merchant_id", "email");

-- CreateIndex
CREATE INDEX "house_rules_merchant_id_status_idx" ON "house_rules"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "house_rules_shop_id_idx" ON "house_rules"("shop_id");

-- CreateIndex
CREATE INDEX "goals_merchant_id_idx" ON "goals"("merchant_id");

-- CreateIndex
CREATE INDEX "goals_shop_id_idx" ON "goals"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "goals_merchant_id_shop_id_horizon_status_key" ON "goals"("merchant_id", "shop_id", "horizon", "status");

-- CreateIndex
CREATE INDEX "ledger_events_merchant_id_event_type_event_ts_idx" ON "ledger_events"("merchant_id", "event_type", "event_ts");

-- CreateIndex
CREATE INDEX "ledger_events_shop_id_event_ts_idx" ON "ledger_events"("shop_id", "event_ts");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_events_merchant_id_dedupe_key_key" ON "ledger_events"("merchant_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_events_merchant_id_idempotency_key_key" ON "ledger_events"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "products_merchant_id_idx" ON "products"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_shop_id_external_id_key" ON "products"("shop_id", "external_id");

-- CreateIndex
CREATE INDEX "variants_merchant_id_idx" ON "variants"("merchant_id");

-- CreateIndex
CREATE INDEX "variants_product_id_idx" ON "variants"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "variants_shop_id_external_id_key" ON "variants"("shop_id", "external_id");

-- CreateIndex
CREATE INDEX "orders_merchant_id_processed_at_idx" ON "orders"("merchant_id", "processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_external_id_key" ON "orders"("shop_id", "external_id");

-- CreateIndex
CREATE INDEX "order_line_items_merchant_id_idx" ON "order_line_items"("merchant_id");

-- CreateIndex
CREATE INDEX "order_line_items_shop_id_idx" ON "order_line_items"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_items_order_id_external_id_key" ON "order_line_items"("order_id", "external_id");

-- CreateIndex
CREATE INDEX "refunds_merchant_id_processed_at_idx" ON "refunds"("merchant_id", "processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_shop_id_external_id_key" ON "refunds"("shop_id", "external_id");

-- CreateIndex
CREATE INDEX "inventory_levels_merchant_id_observed_at_idx" ON "inventory_levels"("merchant_id", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_levels_shop_id_inventory_item_external_id_locatio_key" ON "inventory_levels"("shop_id", "inventory_item_external_id", "location_external_id");

-- CreateIndex
CREATE INDEX "cogs_inputs_merchant_id_sku_idx" ON "cogs_inputs"("merchant_id", "sku");

-- CreateIndex
CREATE INDEX "cogs_inputs_variant_id_effective_from_idx" ON "cogs_inputs"("variant_id", "effective_from");

-- CreateIndex
CREATE INDEX "daily_briefs_merchant_id_brief_date_idx" ON "daily_briefs"("merchant_id", "brief_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_briefs_merchant_id_shop_id_brief_date_channel_key" ON "daily_briefs"("merchant_id", "shop_id", "brief_date", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "daily_briefs_merchant_id_idempotency_key_key" ON "daily_briefs"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "actions_merchant_id_status_proposed_at_idx" ON "actions"("merchant_id", "status", "proposed_at");

-- CreateIndex
CREATE INDEX "actions_shop_id_idx" ON "actions"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "actions_merchant_id_idempotency_key_key" ON "actions"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "executions_action_id_idx" ON "executions"("action_id");

-- CreateIndex
CREATE INDEX "executions_merchant_id_status_idx" ON "executions"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "executions_merchant_id_idempotency_key_key" ON "executions"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "feedback_merchant_id_created_at_idx" ON "feedback"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "feedback_action_id_idx" ON "feedback"("action_id");

-- CreateIndex
CREATE INDEX "provenance_links_merchant_id_entity_type_entity_id_idx" ON "provenance_links"("merchant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "provenance_links_source_event_id_idx" ON "provenance_links"("source_event_id");

-- CreateIndex
CREATE INDEX "holdout_assignments_action_id_assignment_group_idx" ON "holdout_assignments"("action_id", "assignment_group");

-- CreateIndex
CREATE UNIQUE INDEX "holdout_assignments_merchant_id_dedupe_key_key" ON "holdout_assignments"("merchant_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "attribution_results_merchant_id_verification_class_computed_idx" ON "attribution_results"("merchant_id", "verification_class", "computed_at");

-- CreateIndex
CREATE INDEX "attribution_results_action_id_idx" ON "attribution_results"("action_id");

-- CreateIndex
CREATE INDEX "connector_accounts_shop_id_idx" ON "connector_accounts"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_accounts_merchant_id_connector_account_external_i_key" ON "connector_accounts"("merchant_id", "connector", "account_external_id");

-- CreateIndex
CREATE INDEX "cost_metering_merchant_id_usage_date_idx" ON "cost_metering"("merchant_id", "usage_date");

-- CreateIndex
CREATE INDEX "cost_metering_provider_service_idx" ON "cost_metering"("provider", "service");

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_rules" ADD CONSTRAINT "house_rules_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_rules" ADD CONSTRAINT "house_rules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_rules" ADD CONSTRAINT "house_rules_last_edited_by_user_id_fkey" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "merchant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cogs_inputs" ADD CONSTRAINT "cogs_inputs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cogs_inputs" ADD CONSTRAINT "cogs_inputs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cogs_inputs" ADD CONSTRAINT "cogs_inputs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cogs_inputs" ADD CONSTRAINT "cogs_inputs_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_daily_brief_id_fkey" FOREIGN KEY ("daily_brief_id") REFERENCES "daily_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_daily_brief_id_fkey" FOREIGN KEY ("daily_brief_id") REFERENCES "daily_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_merchant_user_id_fkey" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_links" ADD CONSTRAINT "provenance_links_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_links" ADD CONSTRAINT "provenance_links_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provenance_links" ADD CONSTRAINT "provenance_links_source_event_id_fkey" FOREIGN KEY ("source_event_id") REFERENCES "ledger_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdout_assignments" ADD CONSTRAINT "holdout_assignments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdout_assignments" ADD CONSTRAINT "holdout_assignments_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdout_assignments" ADD CONSTRAINT "holdout_assignments_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdout_assignments" ADD CONSTRAINT "holdout_assignments_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_results" ADD CONSTRAINT "attribution_results_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_results" ADD CONSTRAINT "attribution_results_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_results" ADD CONSTRAINT "attribution_results_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_metering" ADD CONSTRAINT "cost_metering_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_metering" ADD CONSTRAINT "cost_metering_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
