-- CreateTable
CREATE TABLE "merchant_opportunity_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "source_run_id" UUID,
    "source_mode" TEXT,
    "discovery_log_json" JSONB NOT NULL DEFAULT '[]',
    "llm_call_count" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_opportunity_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_opportunity_candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "opportunity_set_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "diagnosed_problem" TEXT NOT NULL,
    "business_evidence_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mechanism_hypothesis" TEXT,
    "possible_intervention" TEXT,
    "relevant_family_id" TEXT,
    "confidence" DOUBLE PRECISION,
    "rescue" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "final_disposition" TEXT,
    "reason" TEXT,
    "investigated_by_run_id" UUID,
    "recommendation_id" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_opportunity_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_opportunity_sets_merchant_id_shop_id_expires_at_idx" ON "merchant_opportunity_sets"("merchant_id", "shop_id", "expires_at");

-- CreateIndex
CREATE INDEX "merchant_opportunity_candidates_opportunity_set_id_status_r_idx" ON "merchant_opportunity_candidates"("opportunity_set_id", "status", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_opportunity_candidates_opportunity_set_id_candidat_key" ON "merchant_opportunity_candidates"("opportunity_set_id", "candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_opportunity_candidates_opportunity_set_id_rank_key" ON "merchant_opportunity_candidates"("opportunity_set_id", "rank");

-- AddForeignKey
ALTER TABLE "merchant_opportunity_sets" ADD CONSTRAINT "merchant_opportunity_sets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_opportunity_sets" ADD CONSTRAINT "merchant_opportunity_sets_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_opportunity_candidates" ADD CONSTRAINT "merchant_opportunity_candidates_opportunity_set_id_fkey" FOREIGN KEY ("opportunity_set_id") REFERENCES "merchant_opportunity_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
