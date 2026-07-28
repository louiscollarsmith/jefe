-- Idempotency guard for the transactional WELCOME email (Day 0, sent once when
-- Shopify OAuth completes). The install trigger claims this timestamp atomically
-- (UPDATE ... WHERE welcome_email_sent_at IS NULL) so the welcome is dispatched
-- exactly once per shop no matter how many times afterAuth runs. Nullable, no
-- default: NULL means "welcome not yet sent".

ALTER TABLE "shops"
  ADD COLUMN "welcome_email_sent_at" TIMESTAMPTZ(6);
