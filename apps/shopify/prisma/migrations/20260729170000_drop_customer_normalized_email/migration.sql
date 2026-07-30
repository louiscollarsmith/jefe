-- Drop the unused plaintext normalized_email column (founder-approved cleanup).
-- The app never reads or writes it: ingestion stores only the sha256 email_hash
-- (for joins) and masked_email (for display). Removing it is a PII reduction.
ALTER TABLE "customer_identities" DROP COLUMN "normalized_email";
