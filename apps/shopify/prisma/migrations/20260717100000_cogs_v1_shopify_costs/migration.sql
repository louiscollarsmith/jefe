ALTER TABLE "shops"
ADD COLUMN "product_costs_skipped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "last_successful_cogs_sync_at" TIMESTAMPTZ(6),
ADD COLUMN "last_inventory_item_cost_webhook_at" TIMESTAMPTZ(6),
ADD COLUMN "last_cogs_recompute_at" TIMESTAMPTZ(6),
ADD COLUMN "last_cogs_sync_error" TEXT;

ALTER TABLE "cogs_inputs"
ADD COLUMN "inventory_item_external_id" TEXT,
ADD COLUMN "rule_id" UUID,
ADD COLUMN "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN "confirmed_by" UUID,
ADD COLUMN "imported_at" TIMESTAMPTZ(6),
ADD COLUMN "shopify_inventory_item_updated_at" TIMESTAMPTZ(6),
ADD COLUMN "last_synced_at" TIMESTAMPTZ(6),
ADD COLUMN "missing_reason" TEXT,
ALTER COLUMN "cost_amount" DROP NOT NULL;

UPDATE "cogs_inputs"
SET "confirmed_at" = "created_at"
WHERE "confidence_level" = 'confirmed'
  AND "confirmed_at" IS NULL;

CREATE INDEX "cogs_inputs_shop_id_inventory_item_external_id_idx"
ON "cogs_inputs"("shop_id", "inventory_item_external_id");

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "shop_id", "variant_id"
      ORDER BY "updated_at" DESC, "effective_from" DESC, "created_at" DESC
    ) AS "rank"
  FROM "cogs_inputs"
  WHERE "shop_id" IS NOT NULL
    AND "variant_id" IS NOT NULL
    AND "effective_to" IS NULL
)
UPDATE "cogs_inputs"
SET "effective_to" = now()
FROM ranked
WHERE "cogs_inputs"."id" = ranked."id"
  AND ranked."rank" > 1;

CREATE UNIQUE INDEX "cogs_inputs_shop_id_variant_id_active_key"
ON "cogs_inputs"("shop_id", "variant_id")
WHERE "shop_id" IS NOT NULL
  AND "variant_id" IS NOT NULL
  AND "effective_to" IS NULL;

CREATE UNIQUE INDEX "cogs_inputs_shop_id_inventory_item_external_id_active_key"
ON "cogs_inputs"("shop_id", "inventory_item_external_id")
WHERE "shop_id" IS NOT NULL
  AND "inventory_item_external_id" IS NOT NULL
  AND "effective_to" IS NULL;
