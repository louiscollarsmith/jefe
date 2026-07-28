-- Append-only activity/event log for the internal observability panel. Every
-- meaningful user/system action is one row: type + topic + a searchable summary,
-- keyed by merchant/shop. PII-free (shop domain + event metadata only). Additive;
-- deliberately no FK on shop_id so the log survives shop removal.

CREATE TABLE "activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID,
    "shop_id" UUID,
    "shop_domain" TEXT,
    "type" TEXT NOT NULL,
    "topic" TEXT,
    "summary" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activity_events_created_at_idx" ON "activity_events"("created_at");
CREATE INDEX "activity_events_type_created_at_idx" ON "activity_events"("type", "created_at");
CREATE INDEX "activity_events_shop_id_created_at_idx" ON "activity_events"("shop_id", "created_at");
