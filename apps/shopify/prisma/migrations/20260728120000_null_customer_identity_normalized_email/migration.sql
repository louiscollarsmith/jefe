-- GDPR / PII-at-rest remediation for customer_identities.normalized_email.
--
-- normalized_email stored each customer's plaintext email address at rest. The
-- application never reads it: every lookup, join and aggregate uses email_hash
-- (sha256) and, for display, masked_email. The plaintext column is therefore
-- pure PII exposure with no functional use, so ingestion now stops populating it
-- (see app/lib/ingestion/shopify/canonical.server.js) and this migration removes
-- the values already stored.
--
-- Two steps, in order:
--   1. DROP NOT NULL. The live column was created NOT NULL by
--      20260715213000_install_backfill_pipeline, but the Prisma model already
--      declares the field optional (normalizedEmail String?). That drift was
--      harmless only while ingestion always wrote a value. Now that ingestion
--      omits the column, and because a NOT NULL column cannot be set to NULL,
--      the constraint must be relaxed first. This also realigns the database
--      with the Prisma schema.
--   2. NULL every existing value, deleting the plaintext email at rest.
--
-- The column itself is intentionally KEPT (not dropped) so the change is cheap
-- to reverse and needs no destructive schema rewrite.

ALTER TABLE "customer_identities" ALTER COLUMN "normalized_email" DROP NOT NULL;

UPDATE "customer_identities"
SET "normalized_email" = NULL
WHERE "normalized_email" IS NOT NULL;
