-- Per-recipient email notification preferences, keyed by (shop, sha256(email)).
-- No plaintext email at rest — matches the app's PII posture. A row with
-- unsubscribed_at set suppresses Jefe emails to that recipient. Additive.

CREATE TABLE "email_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_id" UUID NOT NULL,
    "email_hash" TEXT NOT NULL,
    "unsubscribed_at" TIMESTAMPTZ(6),
    "source" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "email_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_preferences_shop_id_email_hash_key" ON "email_preferences"("shop_id", "email_hash");
CREATE INDEX "email_preferences_shop_id_idx" ON "email_preferences"("shop_id");

ALTER TABLE "email_preferences" ADD CONSTRAINT "email_preferences_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
