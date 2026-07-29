-- Additive: records when a shop uninstalled the app. Nullable; set in
-- markShopifyInstallInactive on the app/uninstalled webhook. Complements the
-- shop_uninstalled activity event (churn) with a queryable timestamp on the row.
ALTER TABLE "shops" ADD COLUMN "uninstalled_at" TIMESTAMPTZ(6);
