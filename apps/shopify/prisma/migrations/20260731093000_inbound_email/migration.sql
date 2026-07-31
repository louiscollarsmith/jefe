-- Inbound email → Jefe (feature #15, Door A/B). Two additive tables, no changes to
-- existing tables — additive, safe and reversible.
--
-- email_identities: sha256(normalizeEmail(owner email)) -> shop, so an inbound
-- reply (Door A) routes to the merchant's memory by HASH only (never plaintext),
-- matching email_preferences' PII posture. Populated while a merchant is active so
-- a later win-back reply — sent after the shop's Session rows are deleted on
-- uninstall — still resolves. Cascades with the shop (GDPR shop/redact drops it).
--
-- inbound_email_events: idempotency + observability ledger. One row per received
-- message keyed by the provider message id, so a webhook retry can't double-process
-- or double-reply. Identifiers + outcome only — never the body; sender as a hash.

-- CreateTable
CREATE TABLE "email_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_hash" TEXT NOT NULL,
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_email_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_message_id" TEXT NOT NULL,
    "door" TEXT NOT NULL,
    "email_hash" TEXT,
    "shop_id" UUID,
    "merchant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'received',
    "safe_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_email_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_identities_email_hash_key" ON "email_identities"("email_hash");

-- CreateIndex
CREATE INDEX "email_identities_shop_id_idx" ON "email_identities"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_email_events_provider_message_id_key" ON "inbound_email_events"("provider_message_id");

-- CreateIndex
CREATE INDEX "inbound_email_events_status_created_at_idx" ON "inbound_email_events"("status", "created_at");

-- AddForeignKey
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
