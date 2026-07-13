-- Add structured House Rule fields needed before the first winback write loop.
ALTER TABLE "house_rules"
ADD COLUMN "max_default_discount_bps" INTEGER,
ADD COLUMN "max_winback_discount_bps" INTEGER,
ADD COLUMN "allow_winback_discount_above_default" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "max_campaign_audience_size" INTEGER,
ADD COLUMN "email_cooldown_days" INTEGER,
ADD COLUMN "email_frequency_scope" TEXT,
ADD COLUMN "bfcm_freeze_mode" BOOLEAN NOT NULL DEFAULT false;

UPDATE "house_rules"
SET "max_default_discount_bps" = "max_discount_bps"
WHERE "max_default_discount_bps" IS NULL;
