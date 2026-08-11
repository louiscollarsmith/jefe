-- Additive: durable evidence snapshots for plan recommendations. These rows let
-- action-scoped chat answer why a plan was made from the evidence Jefe had at
-- recommendation time, even if current Merchant Memory later changes.

-- CreateTable
CREATE TABLE "merchant_plan_evidence_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recommendation_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "snapshot_version" TEXT NOT NULL,
    "source_snapshot_hash" TEXT,
    "blocks_json" JSONB NOT NULL DEFAULT '[]',
    "limits_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_plan_evidence_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_plan_evidence_snapshots_recommendation_id_key"
ON "merchant_plan_evidence_snapshots"("recommendation_id");

-- CreateIndex
CREATE INDEX "merchant_plan_evidence_snapshots_merchant_id_created_at_idx"
ON "merchant_plan_evidence_snapshots"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "merchant_plan_evidence_snapshots_shop_id_created_at_idx"
ON "merchant_plan_evidence_snapshots"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "merchant_plan_evidence_snapshots_run_id_idx"
ON "merchant_plan_evidence_snapshots"("run_id");

-- AddForeignKey
ALTER TABLE "merchant_plan_evidence_snapshots"
ADD CONSTRAINT "merchant_plan_evidence_snapshots_recommendation_id_fkey"
FOREIGN KEY ("recommendation_id") REFERENCES "merchant_plan_recommendations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_plan_evidence_snapshots"
ADD CONSTRAINT "merchant_plan_evidence_snapshots_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "merchant_plan_runs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_plan_evidence_snapshots"
ADD CONSTRAINT "merchant_plan_evidence_snapshots_merchant_id_fkey"
FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_plan_evidence_snapshots"
ADD CONSTRAINT "merchant_plan_evidence_snapshots_shop_id_fkey"
FOREIGN KEY ("shop_id") REFERENCES "shops"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
