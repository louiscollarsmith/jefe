CREATE TABLE "merchant_memory_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "context_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_memory_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_open_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "category" TEXT NOT NULL,
    "question_key" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'open',
    "answer_type" TEXT NOT NULL,
    "answer_options_json" JSONB NOT NULL DEFAULT '[]',
    "answered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_memory_open_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_memory_conversation_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "structured_operation_json" JSONB,
    "operation_status" TEXT,
    "related_belief_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "related_open_question_id" UUID,
    "safe_summary" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_memory_conversation_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "merchant_memory_conversations_merchant_id_status_updated_at_idx" ON "merchant_memory_conversations"("merchant_id", "status", "updated_at");
CREATE INDEX "merchant_memory_conversations_shop_id_status_idx" ON "merchant_memory_conversations"("shop_id", "status");

CREATE UNIQUE INDEX "merchant_memory_open_questions_merchant_id_question_key_key" ON "merchant_memory_open_questions"("merchant_id", "question_key");
CREATE INDEX "merchant_memory_open_questions_merchant_id_status_priority_idx" ON "merchant_memory_open_questions"("merchant_id", "status", "priority");
CREATE INDEX "merchant_memory_open_questions_shop_id_status_idx" ON "merchant_memory_open_questions"("shop_id", "status");

CREATE INDEX "merchant_memory_conversation_messages_conversation_id_created_at_idx" ON "merchant_memory_conversation_messages"("conversation_id", "created_at");
CREATE INDEX "merchant_memory_conversation_messages_merchant_id_created_at_idx" ON "merchant_memory_conversation_messages"("merchant_id", "created_at");
CREATE INDEX "merchant_memory_conversation_messages_shop_id_created_at_idx" ON "merchant_memory_conversation_messages"("shop_id", "created_at");
CREATE INDEX "merchant_memory_conversation_messages_related_open_question_id_idx" ON "merchant_memory_conversation_messages"("related_open_question_id");

ALTER TABLE "merchant_memory_conversations" ADD CONSTRAINT "merchant_memory_conversations_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_memory_conversations" ADD CONSTRAINT "merchant_memory_conversations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_open_questions" ADD CONSTRAINT "merchant_memory_open_questions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_memory_open_questions" ADD CONSTRAINT "merchant_memory_open_questions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_memory_conversation_messages" ADD CONSTRAINT "merchant_memory_conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "merchant_memory_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_memory_conversation_messages" ADD CONSTRAINT "merchant_memory_conversation_messages_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_memory_conversation_messages" ADD CONSTRAINT "merchant_memory_conversation_messages_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "merchant_memory_conversation_messages" ADD CONSTRAINT "merchant_memory_conversation_messages_related_open_question_id_fkey" FOREIGN KEY ("related_open_question_id") REFERENCES "merchant_memory_open_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
