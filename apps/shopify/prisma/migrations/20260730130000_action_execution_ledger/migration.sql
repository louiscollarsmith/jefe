-- Additive: the execution ledger for the typed action-primitive layer (the Action
-- Capability Registry's record). Two NEW tables, no changes to existing ones — safe
-- to deploy empty; nothing writes here until an action primitive is wired + flagged
-- on. `action_executions` = one row per action run (approval, autonomy decision,
-- outcome for Observe→Learn); `action_execution_writes` = per-target writes, whose
-- unique (execution, target, value) key gives run-scoped idempotency and whose
-- `expected_from` is the compare-and-set + revert source (authoritative prior value).

-- CreateTable
CREATE TABLE "action_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "action_kind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "merchant_setting" TEXT NOT NULL,
    "resolved_mode" TEXT NOT NULL,
    "eligibility_json" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "reverted_at" TIMESTAMPTZ(6),
    "preview_json" JSONB NOT NULL DEFAULT '{}',
    "caps_json" JSONB,
    "outcome_status" TEXT NOT NULL DEFAULT 'pending',
    "outcome_measured_at" TIMESTAMPTZ(6),
    "outcome_json" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "action_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_execution_writes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "execution_id" UUID NOT NULL,
    "target_ref" TEXT NOT NULL,
    "expected_from" JSONB,
    "target_value_key" TEXT NOT NULL,
    "target_value" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "applied_at" TIMESTAMPTZ(6),

    CONSTRAINT "action_execution_writes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "action_executions_run_id_key" ON "action_executions"("run_id");

-- CreateIndex
CREATE INDEX "action_executions_merchant_id_action_type_status_idx" ON "action_executions"("merchant_id", "action_type", "status");

-- CreateIndex
CREATE INDEX "action_executions_shop_id_outcome_status_idx" ON "action_executions"("shop_id", "outcome_status");

-- CreateIndex
CREATE INDEX "action_execution_writes_execution_id_status_idx" ON "action_execution_writes"("execution_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "action_execution_writes_execution_id_target_ref_target_valu_key" ON "action_execution_writes"("execution_id", "target_ref", "target_value_key");

-- AddForeignKey
ALTER TABLE "action_execution_writes" ADD CONSTRAINT "action_execution_writes_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "action_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
