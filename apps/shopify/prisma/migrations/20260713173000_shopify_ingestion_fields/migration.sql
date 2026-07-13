-- Add Shopify source fields needed by read ingestion.
ALTER TABLE "products"
  ADD COLUMN "source_created_at" TIMESTAMPTZ(6),
  ADD COLUMN "source_updated_at" TIMESTAMPTZ(6);

ALTER TABLE "variants"
  ADD COLUMN "inventory_item_external_id" TEXT,
  ADD COLUMN "source_created_at" TIMESTAMPTZ(6),
  ADD COLUMN "source_updated_at" TIMESTAMPTZ(6);

ALTER TABLE "orders"
  ADD COLUMN "financial_status" TEXT,
  ADD COLUMN "fulfillment_status" TEXT,
  ADD COLUMN "source_created_at" TIMESTAMPTZ(6),
  ADD COLUMN "source_updated_at" TIMESTAMPTZ(6);

ALTER TABLE "order_line_items"
  ADD COLUMN "discount_allocations" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "refunds"
  ADD COLUMN "source_created_at" TIMESTAMPTZ(6);

ALTER TABLE "inventory_levels"
  ADD COLUMN "source_updated_at" TIMESTAMPTZ(6);

CREATE INDEX "inventory_levels_shop_id_inventory_item_external_id_idx"
  ON "inventory_levels"("shop_id", "inventory_item_external_id");
