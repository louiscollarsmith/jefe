-- Per-merchant notification preferences: one row per (merchant, category); an
-- absent row (or a null field) means "use the registry default". Composes with
-- Channels + EmailPreference rather than duplicating them. Also adds a stable
-- Shop.contact_email so notifications have a real "to" (the app uses offline
-- tokens, so the merchant email is not otherwise reliably stored). Additive only.

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "contact_email" TEXT;

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN,
    "channels" JSONB,
    "schedule" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_merchant_id_category_key" ON "notification_preferences"("merchant_id", "category");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
