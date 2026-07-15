-- Extend actions with shared safety lifecycle fields.
ALTER TABLE "actions"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT 'Action',
  ADD COLUMN "summary" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "value_currency" TEXT NOT NULL DEFAULT 'GBP',
  ADD COLUMN "value_type" TEXT NOT NULL DEFAULT 'estimated_margin',
  ADD COLUMN "approval_required" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "caps_applied" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "provenance_references" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "execution_mode" TEXT NOT NULL DEFAULT 'dry_run',
  ADD COLUMN "external_system" TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN "external_draft_id" TEXT,
  ADD COLUMN "external_execution_id" TEXT,
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "rejected_at" TIMESTAMPTZ(6),
  ADD COLUMN "rejected_by" UUID,
  ADD COLUMN "blocked_reason" TEXT;

-- Immutable approval/rejection/transition history for auditable state changes.
CREATE TABLE "action_approval_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "action_id" UUID NOT NULL,
  "previous_status" TEXT NOT NULL,
  "new_status" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "reason" TEXT,
  "request_snapshot" JSONB NOT NULL DEFAULT '{}',
  "event_ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "action_approval_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "action_approval_events_action_id_event_ts_idx"
  ON "action_approval_events"("action_id", "event_ts");

CREATE INDEX "action_approval_events_merchant_id_event_ts_idx"
  ON "action_approval_events"("merchant_id", "event_ts");

ALTER TABLE "action_approval_events"
  ADD CONSTRAINT "action_approval_events_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "action_approval_events"
  ADD CONSTRAINT "action_approval_events_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "action_approval_events"
  ADD CONSTRAINT "action_approval_events_action_id_fkey"
  FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
