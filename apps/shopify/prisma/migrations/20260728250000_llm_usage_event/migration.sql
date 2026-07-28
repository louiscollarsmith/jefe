-- LLM cost/usage ledger — one row per model call (cost per merchant + margin
-- denominator). cost_usd is derived from token counts via the app pricing table.
-- Additive; no FK on shop_id so the ledger survives shop removal.

CREATE TABLE "llm_usage_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID,
    "shop_id" UUID,
    "feature" TEXT NOT NULL,
    "run_type" TEXT,
    "run_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'gemini',
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL,
    "latency_ms" INTEGER,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "llm_usage_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "llm_usage_event_merchant_id_created_at_idx" ON "llm_usage_event"("merchant_id", "created_at");
CREATE INDEX "llm_usage_event_feature_created_at_idx" ON "llm_usage_event"("feature", "created_at");
