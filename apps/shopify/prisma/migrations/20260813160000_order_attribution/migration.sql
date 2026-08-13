-- Where an order came from: first/last touch source, referral code, UTMs and a
-- query-stripped landing path, from Shopify's customerJourneySummary.
--
-- Jefe could describe what a store sold and never why anyone arrived, so "paid vs organic
-- vs email vs social" was not a question it could answer at all.
--
-- Populated only when ORDER_ATTRIBUTION_INGEST_ENABLED=true. The flag guards the QUERY as
-- well as the write: customer journey data sits behind Shopify's protected-customer-data
-- approval, and requesting an unapproved field fails the whole request — which would take
-- down order backfill for every store, not just attribution.
--
-- Empty for existing rows. Beliefs reading this must coverage-gate: '{}' means "never
-- requested", which is indistinguishable from "no journey recorded" at the column level.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "attribution" JSONB NOT NULL DEFAULT '{}';
