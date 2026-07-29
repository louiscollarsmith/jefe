-- Additive: destination country of an order (from shipping/billing address
-- country_code at ingest), for geo-revenue memory. Nullable; older orders stay
-- null until re-backfilled.
ALTER TABLE "orders" ADD COLUMN "shipping_country" TEXT;
