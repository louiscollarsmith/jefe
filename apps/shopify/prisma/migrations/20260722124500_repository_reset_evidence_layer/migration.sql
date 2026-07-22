-- Repository reset: retain only Shopify install/auth, commerce evidence backfills,
-- commerce evidence webhooks, and minimum operational state.

DELETE FROM "backfill_jobs"
WHERE "job_type" NOT IN (
  'shop_backfill_start',
  'products_backfill',
  'orders_backfill_365d',
  'inventory_backfill',
  'backfill_delta_sync',
  'backfill_finalize'
);

DELETE FROM "shop_backfill_statuses"
WHERE "domain" NOT IN (
  'shop',
  'webhooks',
  'products',
  'orders',
  'customers',
  'inventory',
  'refunds'
);

DROP TABLE IF EXISTS "merchant_memory_claim_evidence" CASCADE;
DROP TABLE IF EXISTS "merchant_memory_open_questions" CASCADE;
DROP TABLE IF EXISTS "merchant_memory_corrections" CASCADE;
DROP TABLE IF EXISTS "merchant_memory_claims" CASCADE;
DROP TABLE IF EXISTS "merchant_memory_evidence_items" CASCADE;
DROP TABLE IF EXISTS "merchant_memory_versions" CASCADE;
DROP TABLE IF EXISTS "merchant_memory_documents" CASCADE;
DROP TABLE IF EXISTS "cost_metering" CASCADE;
DROP TABLE IF EXISTS "external_action_artifacts" CASCADE;
DROP TABLE IF EXISTS "merchant_klaviyo_credentials" CASCADE;
DROP TABLE IF EXISTS "attribution_results" CASCADE;
DROP TABLE IF EXISTS "holdout_assignments" CASCADE;
DROP TABLE IF EXISTS "provenance_links" CASCADE;
DROP TABLE IF EXISTS "feedback" CASCADE;
DROP TABLE IF EXISTS "executions" CASCADE;
DROP TABLE IF EXISTS "action_approval_events" CASCADE;
DROP TABLE IF EXISTS "actions" CASCADE;
DROP TABLE IF EXISTS "daily_briefs" CASCADE;
DROP TABLE IF EXISTS "cogs_inputs" CASCADE;
DROP TABLE IF EXISTS "goals" CASCADE;
DROP TABLE IF EXISTS "house_rules" CASCADE;
DROP TABLE IF EXISTS "merchant_users" CASCADE;

ALTER TABLE "merchants"
  DROP COLUMN IF EXISTS "primary_currency",
  DROP COLUMN IF EXISTS "timezone",
  DROP COLUMN IF EXISTS "goals_json";

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "historical_order_access" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "available_order_history_days" INTEGER NOT NULL DEFAULT 0,
  DROP COLUMN IF EXISTS "onboarding_started_at",
  DROP COLUMN IF EXISTS "onboarding_completed_at",
  DROP COLUMN IF EXISTS "goals_completed",
  DROP COLUMN IF EXISTS "house_rules_completed",
  DROP COLUMN IF EXISTS "cogs_completion_percentage",
  DROP COLUMN IF EXISTS "cogs_confidence_level",
  DROP COLUMN IF EXISTS "product_costs_skipped",
  DROP COLUMN IF EXISTS "last_successful_cogs_sync_at",
  DROP COLUMN IF EXISTS "last_inventory_item_cost_webhook_at",
  DROP COLUMN IF EXISTS "last_cogs_recompute_at",
  DROP COLUMN IF EXISTS "last_cogs_sync_error",
  DROP COLUMN IF EXISTS "onboarding_metadata";

DROP TYPE IF EXISTS "goal_horizon";
DROP TYPE IF EXISTS "verification_class";
