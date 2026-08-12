-- Holistic cross-conversation Merchant Memory. Messages remain canonical; the
-- episode/candidate/retrieval tables are additive, rebuildable derivatives.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "merchant_memory_beliefs"
  ADD COLUMN "scope_json" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "valid_from" TIMESTAMPTZ(6),
  ADD COLUMN "valid_until" TIMESTAMPTZ(6);

ALTER TABLE "merchant_memory_conversations"
  ADD COLUMN "conversation_type" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'app',
  ADD COLUMN "external_thread_id" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "last_message_at" TIMESTAMPTZ(6),
  ADD COLUMN "closed_at" TIMESTAMPTZ(6);

UPDATE "merchant_memory_conversations" AS conversation
SET
  "conversation_type" = CASE
    WHEN conversation."topic" = 'memory' THEN 'legacy'
    WHEN conversation."topic" = 'onboarding_goals' THEN 'goal_coaching'
    WHEN conversation."topic" = 'onboarding_plan' THEN 'plan_refinement'
    WHEN conversation."topic" LIKE 'action:%' THEN 'action'
    ELSE 'legacy'
  END,
  "last_message_at" = COALESCE(
    (
      SELECT MAX(message."created_at")
      FROM "merchant_memory_conversation_messages" AS message
      WHERE message."conversation_id" = conversation."id"
    ),
    conversation."updated_at"
  );

CREATE INDEX "mm_conversations_type_surface_last_message_idx"
  ON "merchant_memory_conversations"("merchant_id", "shop_id", "conversation_type", "surface", "last_message_at");
CREATE UNIQUE INDEX "mm_conversations_external_thread_key"
  ON "merchant_memory_conversations"("merchant_id", "shop_id", "surface", "external_thread_id");

ALTER TABLE "merchant_memory_conversation_messages"
  ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'app',
  ADD COLUMN "external_message_id" TEXT,
  ADD COLUMN "recommendation_id" UUID,
  ADD COLUMN "action_run_id" UUID,
  ADD COLUMN "metadata_json" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "processing_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'current',
  ADD COLUMN "retracted_at" TIMESTAMPTZ(6);

UPDATE "merchant_memory_conversation_messages" AS message
SET "surface" = conversation."surface",
    "processing_status" = 'backfill_pending'
FROM "merchant_memory_conversations" AS conversation
WHERE conversation."id" = message."conversation_id";

CREATE INDEX "mm_messages_visibility_created_idx"
  ON "merchant_memory_conversation_messages"("merchant_id", "shop_id", "visibility", "created_at");
CREATE INDEX "merchant_memory_conversation_messages_recommendation_id_idx"
  ON "merchant_memory_conversation_messages"("recommendation_id");
CREATE INDEX "merchant_memory_conversation_messages_action_run_id_idx"
  ON "merchant_memory_conversation_messages"("action_run_id");
CREATE UNIQUE INDEX "mm_messages_external_id_key"
  ON "merchant_memory_conversation_messages"("merchant_id", "surface", "external_message_id");

CREATE TABLE "merchant_memory_episodes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "conversation_id" UUID NOT NULL,
  "document_type" TEXT NOT NULL,
  "role" TEXT,
  "source_message_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "search_text" TEXT NOT NULL,
  "structured_summary_json" JSONB NOT NULL DEFAULT '{}',
  "entity_refs_json" JSONB NOT NULL DEFAULT '[]',
  "related_belief_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "recommendation_id" UUID,
  "action_run_id" UUID,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'current',
  "source_hash" TEXT NOT NULL,
  "index_version" TEXT NOT NULL DEFAULT 'episodic-v1',
  "processing_status" TEXT NOT NULL DEFAULT 'pending',
  "embedding_status" TEXT NOT NULL DEFAULT 'pending',
  "embedding_model" TEXT,
  "embedding_dimensions" INTEGER,
  "embedding_error_code" TEXT,
  "embedded_at" TIMESTAMPTZ(6),
  "search_vector" TSVECTOR,
  "embedding" vector(768),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "merchant_memory_episodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_memory_episodes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_memory_episodes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_memory_episodes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "merchant_memory_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "mm_episodes_conversation_document_hash_key"
  ON "merchant_memory_episodes"("conversation_id", "document_type", "source_hash");
CREATE INDEX "mm_episodes_visibility_occurred_idx"
  ON "merchant_memory_episodes"("merchant_id", "shop_id", "visibility", "occurred_at");
CREATE INDEX "merchant_memory_episodes_conversation_id_occurred_at_idx"
  ON "merchant_memory_episodes"("conversation_id", "occurred_at");
CREATE INDEX "merchant_memory_episodes_recommendation_id_idx"
  ON "merchant_memory_episodes"("recommendation_id");
CREATE INDEX "merchant_memory_episodes_action_run_id_idx"
  ON "merchant_memory_episodes"("action_run_id");
CREATE INDEX "mm_episodes_processing_created_idx"
  ON "merchant_memory_episodes"("processing_status", "created_at");
CREATE INDEX "mm_episodes_embedding_created_idx"
  ON "merchant_memory_episodes"("embedding_status", "created_at");
CREATE INDEX "mm_episodes_search_vector_idx"
  ON "merchant_memory_episodes" USING GIN ("search_vector");

CREATE OR REPLACE FUNCTION merchant_memory_episode_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW."search_vector" := to_tsvector('simple', COALESCE(NEW."search_text", ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER merchant_memory_episode_search_vector_trigger
BEFORE INSERT OR UPDATE OF "search_text" ON "merchant_memory_episodes"
FOR EACH ROW EXECUTE FUNCTION merchant_memory_episode_search_vector_update();

CREATE TABLE "merchant_memory_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "source_message_id" UUID NOT NULL,
  "candidate_fingerprint" TEXT NOT NULL,
  "operation_type" TEXT NOT NULL,
  "category" TEXT,
  "key" TEXT,
  "proposed_value_json" JSONB,
  "value_type" TEXT,
  "scope_json" JSONB NOT NULL DEFAULT '{}',
  "valid_from" TIMESTAMPTZ(6),
  "valid_until" TIMESTAMPTZ(6),
  "confidence" DECIMAL(5,4),
  "rationale_summary" TEXT,
  "extractor_version" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason_code" TEXT,
  "promoted_belief_id" UUID,
  "processed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "merchant_memory_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_memory_candidates_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_memory_candidates_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_memory_candidates_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "merchant_memory_conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_memory_candidates_promoted_belief_id_fkey" FOREIGN KEY ("promoted_belief_id") REFERENCES "merchant_memory_beliefs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "merchant_memory_candidates_candidate_fingerprint_key"
  ON "merchant_memory_candidates"("candidate_fingerprint");
CREATE INDEX "mm_candidates_status_created_idx"
  ON "merchant_memory_candidates"("merchant_id", "shop_id", "status", "created_at");
CREATE INDEX "merchant_memory_candidates_source_message_id_idx"
  ON "merchant_memory_candidates"("source_message_id");
CREATE INDEX "merchant_memory_candidates_promoted_belief_id_idx"
  ON "merchant_memory_candidates"("promoted_belief_id");

CREATE TABLE "merchant_context_retrieval_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "query_message_id" UUID,
  "task" TEXT NOT NULL,
  "query_hash" TEXT NOT NULL,
  "strategy_json" JSONB NOT NULL DEFAULT '{}',
  "historical_mode" BOOLEAN NOT NULL DEFAULT false,
  "candidate_counts_json" JSONB NOT NULL DEFAULT '{}',
  "selected_items_json" JSONB NOT NULL DEFAULT '[]',
  "token_budget" INTEGER NOT NULL,
  "token_used" INTEGER NOT NULL,
  "discarded_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "merchant_context_retrieval_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_context_retrieval_runs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_context_retrieval_runs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_context_retrieval_runs_query_message_id_fkey" FOREIGN KEY ("query_message_id") REFERENCES "merchant_memory_conversation_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "merchant_context_retrieval_task_created_idx"
  ON "merchant_context_retrieval_runs"("merchant_id", "shop_id", "task", "created_at");
CREATE INDEX "merchant_context_retrieval_runs_query_message_id_idx"
  ON "merchant_context_retrieval_runs"("query_message_id");

-- A direct message FK does not prove that its duplicated tenant columns match
-- the parent conversation. Enforce that invariant for every new/updated row.
CREATE OR REPLACE FUNCTION merchant_memory_assert_shop_merchant()
RETURNS trigger AS $$
DECLARE
  shop_merchant UUID;
BEGIN
  IF NEW."shop_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "merchant_id" INTO shop_merchant
  FROM "shops"
  WHERE "id" = NEW."shop_id";

  IF shop_merchant IS NULL OR shop_merchant IS DISTINCT FROM NEW."merchant_id" THEN
    RAISE EXCEPTION 'merchant memory shop tenant mismatch';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "merchant_memory_conversations" AS conversation
    JOIN "shops" AS shop ON shop."id" = conversation."shop_id"
    WHERE conversation."merchant_id" IS DISTINCT FROM shop."merchant_id"
  ) THEN
    RAISE EXCEPTION 'existing merchant memory conversation shop tenant mismatch';
  END IF;
END
$$;

CREATE TRIGGER merchant_memory_conversation_shop_tenant_trigger
BEFORE INSERT OR UPDATE OF "merchant_id", "shop_id"
ON "merchant_memory_conversations"
FOR EACH ROW EXECUTE FUNCTION merchant_memory_assert_shop_merchant();

CREATE OR REPLACE FUNCTION merchant_memory_assert_conversation_tenant()
RETURNS trigger AS $$
DECLARE
  parent_merchant UUID;
  parent_shop UUID;
BEGIN
  SELECT "merchant_id", "shop_id"
    INTO parent_merchant, parent_shop
  FROM "merchant_memory_conversations"
  WHERE "id" = NEW."conversation_id";

  IF parent_merchant IS NULL OR parent_merchant IS DISTINCT FROM NEW."merchant_id"
     OR parent_shop IS DISTINCT FROM NEW."shop_id" THEN
    RAISE EXCEPTION 'merchant memory conversation tenant mismatch';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER merchant_memory_message_tenant_trigger
BEFORE INSERT OR UPDATE OF "conversation_id", "merchant_id", "shop_id"
ON "merchant_memory_conversation_messages"
FOR EACH ROW EXECUTE FUNCTION merchant_memory_assert_conversation_tenant();

CREATE TRIGGER merchant_memory_episode_tenant_trigger
BEFORE INSERT OR UPDATE OF "conversation_id", "merchant_id", "shop_id"
ON "merchant_memory_episodes"
FOR EACH ROW EXECUTE FUNCTION merchant_memory_assert_conversation_tenant();

CREATE OR REPLACE FUNCTION merchant_memory_assert_candidate_tenant()
RETURNS trigger AS $$
DECLARE
  source_merchant UUID;
  source_shop UUID;
BEGIN
  SELECT "merchant_id", "shop_id"
    INTO source_merchant, source_shop
  FROM "merchant_memory_conversation_messages"
  WHERE "id" = NEW."source_message_id";

  IF source_merchant IS NULL OR source_merchant IS DISTINCT FROM NEW."merchant_id"
     OR source_shop IS DISTINCT FROM NEW."shop_id" THEN
    RAISE EXCEPTION 'merchant memory candidate tenant mismatch';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER merchant_memory_candidate_tenant_trigger
BEFORE INSERT OR UPDATE OF "source_message_id", "merchant_id", "shop_id"
ON "merchant_memory_candidates"
FOR EACH ROW EXECUTE FUNCTION merchant_memory_assert_candidate_tenant();
