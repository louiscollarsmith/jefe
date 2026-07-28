-- Additive: variant cost-per-item, from Shopify InventoryItem.unitCost (read_inventory scope).
-- Nullable because coverage is patchy (the field is optional in Shopify); Merchant Memory
-- margin beliefs gate on its presence rather than assuming it.
ALTER TABLE "variants" ADD COLUMN "unit_cost" DECIMAL(18,2);
