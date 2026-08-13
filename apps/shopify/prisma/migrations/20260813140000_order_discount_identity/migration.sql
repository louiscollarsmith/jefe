-- Discount identity on orders: WHICH offer discounted an order, not just how much.
--
-- `total_discount` already told us a store gives away N% of gross. It could never say
-- which code did it, so the questions that change behaviour — is this code cannibalising
-- full-price sales, does it bring anyone back, is a permanent WELCOME10 just a price cut —
-- were unanswerable from stored data.
--
-- Backfilled as empty for existing rows. Beliefs reading these columns must coverage-gate:
-- orders ingested before this migration carry [] because the field was never requested,
-- which is indistinguishable from "no discount" at the column level. Re-backfill populates.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "discount_codes" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "discount_applications" JSONB NOT NULL DEFAULT '[]';
