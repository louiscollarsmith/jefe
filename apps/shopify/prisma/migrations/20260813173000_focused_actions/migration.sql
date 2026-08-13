-- First-class Merchant Actions and structured Chat -> focused Action state.
--
-- Existing MerchantPlanRecommendation and ActionExecution rows remain authoritative
-- for proposal/execution data. This migration adds the durable product-level action
-- identity chats focus on, then backfills it from existing recommendations and
-- execution ledger rows without deleting old action:* topics or context JSON.

CREATE TABLE "merchant_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "source_recommendation_id" UUID,
  "current_action_run_id" UUID,
  "progress_json" JSONB NOT NULL DEFAULT '{}',
  "outcome_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "merchant_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_actions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_actions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_actions_source_recommendation_id_fkey" FOREIGN KEY ("source_recommendation_id") REFERENCES "merchant_plan_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "merchant_actions_current_action_run_id_fkey" FOREIGN KEY ("current_action_run_id") REFERENCES "action_executions"("run_id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "merchant_actions_source_recommendation_id_key"
  ON "merchant_actions"("source_recommendation_id");
CREATE INDEX "merchant_actions_status_updated_idx"
  ON "merchant_actions"("merchant_id", "shop_id", "status", "updated_at");
CREATE INDEX "merchant_actions_shop_id_status_idx"
  ON "merchant_actions"("shop_id", "status");
CREATE INDEX "merchant_actions_current_action_run_id_idx"
  ON "merchant_actions"("current_action_run_id");

ALTER TABLE "action_executions"
  ADD COLUMN "merchant_action_id" UUID;

CREATE INDEX "action_executions_merchant_action_id_idx"
  ON "action_executions"("merchant_action_id");

ALTER TABLE "action_executions"
  ADD CONSTRAINT "action_executions_merchant_action_id_fkey"
  FOREIGN KEY ("merchant_action_id") REFERENCES "merchant_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_conversations"
  ADD COLUMN "focused_action_id" UUID;

CREATE INDEX "mm_conversations_focused_action_idx"
  ON "merchant_memory_conversations"("merchant_id", "shop_id", "focused_action_id", "updated_at");

ALTER TABLE "merchant_memory_conversations"
  ADD CONSTRAINT "merchant_memory_conversations_focused_action_id_fkey"
  FOREIGN KEY ("focused_action_id") REFERENCES "merchant_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "merchant_action_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "merchant_action_id" UUID NOT NULL,
  "conversation_id" UUID,
  "message_id" UUID,
  "event_type" TEXT NOT NULL,
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_action_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_action_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_action_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_action_events_merchant_action_id_fkey" FOREIGN KEY ("merchant_action_id") REFERENCES "merchant_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_action_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "merchant_memory_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "merchant_action_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "merchant_memory_conversation_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "merchant_action_events_type_created_idx"
  ON "merchant_action_events"("merchant_id", "shop_id", "event_type", "created_at");
CREATE INDEX "merchant_action_events_merchant_action_id_created_at_idx"
  ON "merchant_action_events"("merchant_action_id", "created_at");
CREATE INDEX "merchant_action_events_conversation_id_created_at_idx"
  ON "merchant_action_events"("conversation_id", "created_at");

INSERT INTO "merchant_actions" (
  "merchant_id",
  "shop_id",
  "title",
  "summary",
  "status",
  "source_recommendation_id",
  "current_action_run_id",
  "progress_json",
  "outcome_json",
  "created_at",
  "updated_at"
)
SELECT
  rec."merchant_id",
  rec."shop_id",
  rec."title",
  COALESCE(rec."summary", ''),
  CASE
    WHEN rec."completed_at" IS NOT NULL OR rec."review_status" = 'completed' THEN 'completed'
    WHEN exec."status" IN ('applied', 'partially_applied', 'approved') THEN 'in_progress'
    WHEN exec."status" IN ('rejected', 'reverted') THEN 'declined'
    WHEN rec."review_status" = 'accepted' THEN 'accepted'
    WHEN rec."review_status" = 'deferred' THEN 'deferred'
    WHEN rec."review_status" = 'rejected' THEN 'declined'
    WHEN rec."review_status" = 'superseded' THEN 'superseded'
    ELSE 'proposed'
  END,
  rec."id",
  exec."run_id",
  jsonb_build_object(
    'executionSteps', COALESCE(rec."execution_steps_json", '[]'::jsonb),
    'successSignal', COALESCE(rec."success_signal_json", '{}'::jsonb),
    'reviewStatus', rec."review_status"
  ),
  COALESCE(exec."outcome_json", rec."outcome_json", '{}'::jsonb),
  rec."created_at",
  GREATEST(rec."updated_at", COALESCE(exec."updated_at", rec."updated_at"))
FROM "merchant_plan_recommendations" rec
LEFT JOIN "action_executions" exec
  ON exec."source_recommendation_id" = rec."id"
ON CONFLICT ("source_recommendation_id") DO NOTHING;

UPDATE "action_executions" exec
SET "merchant_action_id" = action."id"
FROM "merchant_actions" action
WHERE action."source_recommendation_id" = exec."source_recommendation_id"
  AND exec."merchant_action_id" IS NULL;

INSERT INTO "merchant_actions" (
  "merchant_id",
  "shop_id",
  "title",
  "summary",
  "status",
  "current_action_run_id",
  "progress_json",
  "outcome_json",
  "created_at",
  "updated_at"
)
SELECT
  exec."merchant_id",
  exec."shop_id",
  COALESCE(
    NULLIF(exec."proposal_summary" #>> '{sourceRecommendation,title}', ''),
    NULLIF(exec."action_kind", ''),
    exec."action_type"
  ),
  COALESCE(exec."proposal_summary" #>> '{sourceRecommendation,summary}', ''),
  CASE
    WHEN exec."status" IN ('applied', 'partially_applied', 'approved') THEN 'in_progress'
    WHEN exec."status" IN ('rejected', 'reverted') THEN 'declined'
    WHEN exec."status" = 'superseded' THEN 'superseded'
    ELSE 'proposed'
  END,
  exec."run_id",
  jsonb_build_object(
    'actionType', exec."action_type",
    'actionKind', exec."action_kind",
    'preview', COALESCE(exec."preview_json", '{}'::jsonb)
  ),
  COALESCE(exec."outcome_json", '{}'::jsonb),
  exec."created_at",
  exec."updated_at"
FROM "action_executions" exec
WHERE exec."merchant_action_id" IS NULL;

UPDATE "action_executions" exec
SET "merchant_action_id" = action."id"
FROM "merchant_actions" action
WHERE action."current_action_run_id" = exec."run_id"
  AND exec."merchant_action_id" IS NULL;

UPDATE "merchant_memory_conversations" conversation
SET "focused_action_id" = action."id"
FROM "merchant_actions" action
WHERE conversation."focused_action_id" IS NULL
  AND conversation."merchant_id" = action."merchant_id"
  AND conversation."shop_id" = action."shop_id"
  AND (
    conversation."topic" = ('action:' || action."source_recommendation_id"::text)
    OR conversation."topic" = ('action:' || action."current_action_run_id"::text)
    OR conversation."context_json"->>'recommendationId' = action."source_recommendation_id"::text
    OR conversation."context_json"->>'actionRunId' = action."current_action_run_id"::text
    OR conversation."context_json"->>'currentActionRunId' = action."current_action_run_id"::text
  );

INSERT INTO "merchant_action_events" (
  "merchant_id",
  "shop_id",
  "merchant_action_id",
  "conversation_id",
  "event_type",
  "metadata_json",
  "created_at"
)
SELECT
  conversation."merchant_id",
  conversation."shop_id",
  conversation."focused_action_id",
  conversation."id",
  'focus_migrated',
  jsonb_build_object('sourceTopic', conversation."topic"),
  conversation."created_at"
FROM "merchant_memory_conversations" conversation
WHERE conversation."focused_action_id" IS NOT NULL
  AND conversation."shop_id" IS NOT NULL;
