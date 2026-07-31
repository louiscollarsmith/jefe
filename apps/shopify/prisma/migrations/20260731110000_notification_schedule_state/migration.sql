-- Durable per-(shop, category) schedule guard for time-based notifications (the
-- morning brief). At-most-once-per-merchant-local-day is enforced by an atomic
-- updateMany claim on last_fired_local_day, so it survives worker restarts/deploys
-- (unlike an in-memory guard). FK-less by design (like inbound_email_events) — a
-- tiny operational row keyed by shop+category. Additive only.

-- CreateTable
CREATE TABLE "notification_schedule_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "last_fired_local_day" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_schedule_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_schedule_states_shop_id_category_key" ON "notification_schedule_states"("shop_id", "category");
