-- Scope Merchant Memory conversation threads by durable topic so onboarding
-- surfaces such as Goals and Plan can keep separate chat history.

ALTER TABLE "merchant_memory_conversations"
ADD COLUMN "topic" TEXT NOT NULL DEFAULT 'memory';

CREATE INDEX "merchant_memory_conversations_merchant_id_shop_id_topic_status_updated_at_idx"
ON "merchant_memory_conversations"("merchant_id", "shop_id", "topic", "status", "updated_at");
