CREATE TABLE "merchant_interviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'not_started',
  "readiness_score" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "paused_at" TIMESTAMPTZ(6),
  "current_topic" TEXT,
  "current_question" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "merchant_interviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_interview_topics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "interview_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "topic_key" TEXT NOT NULL,
  "belief_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "source" TEXT NOT NULL DEFAULT 'registry',
  "answered_at" TIMESTAMPTZ(6),
  "related_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "merchant_interview_topics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_interview_turns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "interview_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "topic_key" TEXT,
  "question" TEXT NOT NULL,
  "acknowledgement" TEXT,
  "answer_suggestions_json" JSONB NOT NULL DEFAULT '[]',
  "merchant_answer" TEXT,
  "structured_interpretation_json" JSONB,
  "operation_status" TEXT NOT NULL DEFAULT 'pending',
  "related_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "idempotency_key" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answered_at" TIMESTAMPTZ(6),

  CONSTRAINT "merchant_interview_turns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "merchant_interviews_merchant_id_status_updated_at_idx" ON "merchant_interviews"("merchant_id", "status", "updated_at");
CREATE INDEX "merchant_interviews_shop_id_status_idx" ON "merchant_interviews"("shop_id", "status");

CREATE UNIQUE INDEX "merchant_interview_topics_interview_id_topic_key_key" ON "merchant_interview_topics"("interview_id", "topic_key");
CREATE INDEX "merchant_interview_topics_merchant_id_status_priority_idx" ON "merchant_interview_topics"("merchant_id", "status", "priority");
CREATE INDEX "merchant_interview_topics_shop_id_status_idx" ON "merchant_interview_topics"("shop_id", "status");

CREATE UNIQUE INDEX "merchant_interview_turns_interview_id_idempotency_key_key" ON "merchant_interview_turns"("interview_id", "idempotency_key");
CREATE INDEX "merchant_interview_turns_interview_id_created_at_idx" ON "merchant_interview_turns"("interview_id", "created_at");
CREATE INDEX "merchant_interview_turns_merchant_id_created_at_idx" ON "merchant_interview_turns"("merchant_id", "created_at");
CREATE INDEX "merchant_interview_turns_shop_id_created_at_idx" ON "merchant_interview_turns"("shop_id", "created_at");

ALTER TABLE "merchant_interviews"
  ADD CONSTRAINT "merchant_interviews_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_interviews"
  ADD CONSTRAINT "merchant_interviews_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_interview_topics"
  ADD CONSTRAINT "merchant_interview_topics_interview_id_fkey"
  FOREIGN KEY ("interview_id") REFERENCES "merchant_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_interview_topics"
  ADD CONSTRAINT "merchant_interview_topics_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_interview_topics"
  ADD CONSTRAINT "merchant_interview_topics_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_interview_turns"
  ADD CONSTRAINT "merchant_interview_turns_interview_id_fkey"
  FOREIGN KEY ("interview_id") REFERENCES "merchant_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_interview_turns"
  ADD CONSTRAINT "merchant_interview_turns_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_interview_turns"
  ADD CONSTRAINT "merchant_interview_turns_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
