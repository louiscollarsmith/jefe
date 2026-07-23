-- Add persisted chronological interview messages and explicit turn lifecycle links.
ALTER TABLE "merchant_interview_turns"
  ADD COLUMN "interpretation_result_id" UUID,
  ADD COLUMN "committed_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "question_message_id" UUID,
  ADD COLUMN "answer_message_id" UUID,
  ADD COLUMN "acknowledgement_message_id" UUID,
  ADD COLUMN "next_turn_id" UUID;

CREATE TABLE "merchant_interview_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "interview_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID,
  "turn_id" UUID,
  "source_turn_id" UUID,
  "interpretation_result_id" UUID,
  "type" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "topic_key" TEXT,
  "sequence" INTEGER NOT NULL,
  "committed_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "operation_status" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_interview_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_interview_messages_interview_id_sequence_key" ON "merchant_interview_messages"("interview_id", "sequence");
CREATE INDEX "merchant_interview_messages_interview_id_created_at_idx" ON "merchant_interview_messages"("interview_id", "created_at");
CREATE INDEX "merchant_interview_messages_turn_id_type_idx" ON "merchant_interview_messages"("turn_id", "type");
CREATE INDEX "merchant_interview_messages_source_turn_id_idx" ON "merchant_interview_messages"("source_turn_id");
CREATE INDEX "merchant_interview_messages_merchant_id_created_at_idx" ON "merchant_interview_messages"("merchant_id", "created_at");
CREATE INDEX "merchant_interview_messages_shop_id_created_at_idx" ON "merchant_interview_messages"("shop_id", "created_at");

ALTER TABLE "merchant_interview_messages" ADD CONSTRAINT "merchant_interview_messages_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "merchant_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_interview_messages" ADD CONSTRAINT "merchant_interview_messages_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_interview_messages" ADD CONSTRAINT "merchant_interview_messages_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "merchant_interview_messages" ADD CONSTRAINT "merchant_interview_messages_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "merchant_interview_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
