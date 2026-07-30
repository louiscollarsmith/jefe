-- DropIndex
DROP INDEX "inventory_levels_shop_id_inventory_item_external_id_idx";

-- DropIndex
DROP INDEX "shops_onboarding_completed_at_idx";

-- AlterTable
ALTER TABLE "channel_connections" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "channel_credentials" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "channel_message_deliveries" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "customer_identities" ALTER COLUMN "masked_email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "inventory_levels" ALTER COLUMN "inventory_item_external_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "merchant_goal_horizons" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_goal_runs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_insight_findings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_insight_runs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_memory_beliefs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_memory_conversations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_memory_open_questions" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_memory_refresh_runs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_plan_recommendations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_plan_runs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "order_line_items" ALTER COLUMN "external_id" SET NOT NULL,
ALTER COLUMN "quantity" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "refunds" ALTER COLUMN "currency" DROP NOT NULL;

-- AlterTable
ALTER TABLE "store_understanding_runs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "action_autonomy_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "action_autonomy_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "action_autonomy_policies_merchant_id_action_type_key" ON "action_autonomy_policies"("merchant_id", "action_type");

-- CreateIndex
CREATE INDEX "inventory_levels_variant_id_idx" ON "inventory_levels"("variant_id");

-- CreateIndex
CREATE INDEX "order_line_items_product_id_idx" ON "order_line_items"("product_id");

-- CreateIndex
CREATE INDEX "order_line_items_variant_id_idx" ON "order_line_items"("variant_id");

-- CreateIndex
CREATE INDEX "orders_shop_id_processed_at_idx" ON "orders"("shop_id", "processed_at");

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- RenameForeignKey
ALTER TABLE "merchant_memory_conversation_messages" RENAME CONSTRAINT "merchant_memory_conversation_messages_related_open_question_id_" TO "merchant_memory_conversation_messages_related_open_questio_fkey";

-- RenameIndex
ALTER INDEX "channel_verification_challenges_merchant_id_provider_expires_at" RENAME TO "channel_verification_challenges_merchant_id_provider_expire_idx";

-- RenameIndex
ALTER INDEX "merchant_goal_runs_shop_id_belief_snapshot_hash_prompt_version_" RENAME TO "merchant_goal_runs_shop_id_belief_snapshot_hash_prompt_vers_key";

-- RenameIndex
ALTER INDEX "merchant_insight_runs_shop_id_belief_snapshot_hash_prompt_ver_k" RENAME TO "merchant_insight_runs_shop_id_belief_snapshot_hash_prompt_v_key";

-- RenameIndex
ALTER INDEX "merchant_memory_conversation_messages_conversation_id_created_a" RENAME TO "merchant_memory_conversation_messages_conversation_id_creat_idx";

-- RenameIndex
ALTER INDEX "merchant_memory_conversation_messages_merchant_id_created_at_id" RENAME TO "merchant_memory_conversation_messages_merchant_id_created_a_idx";

-- RenameIndex
ALTER INDEX "merchant_memory_conversation_messages_related_open_question_id_" RENAME TO "merchant_memory_conversation_messages_related_open_question_idx";

-- RenameIndex
ALTER INDEX "merchant_memory_evidence_merchant_id_evidence_type_created_at_i" RENAME TO "merchant_memory_evidence_merchant_id_evidence_type_created__idx";

-- RenameIndex
ALTER INDEX "merchant_plan_recommendations_merchant_id_review_status_created" RENAME TO "merchant_plan_recommendations_merchant_id_review_status_cre_idx";

-- RenameIndex
ALTER INDEX "merchant_plan_recommendations_shop_id_review_status_created_at_" RENAME TO "merchant_plan_recommendations_shop_id_review_status_created_idx";

-- RenameIndex
ALTER INDEX "merchant_plan_runs_shop_id_snapshot_hash_prompt_version_schema_" RENAME TO "merchant_plan_runs_shop_id_snapshot_hash_prompt_version_sch_key";

