-- Idempotency guard for the transactional WIN-BACK email (Day 0 of churn, sent
-- once when Shopify fires app/uninstalled). The uninstall trigger claims this
-- timestamp atomically (UPDATE ... WHERE winback_email_sent_at IS NULL) so the
-- farewell is dispatched exactly once per shop no matter how many times the
-- uninstall webhook is re-delivered. Nullable, no default: NULL means "win-back
-- not yet sent".

ALTER TABLE "shops"
  ADD COLUMN "winback_email_sent_at" TIMESTAMPTZ(6);
