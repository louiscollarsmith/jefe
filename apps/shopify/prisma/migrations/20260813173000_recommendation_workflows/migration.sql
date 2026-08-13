-- Recommendation workflows turn one merchant-facing recommendation into an ordered
-- route to completion. The LLM proposes the steps; Jefe validates capabilities,
-- persists step state, and only typed adapters perform external writes.
CREATE TABLE "merchant_recommendation_workflows" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "recommendation_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "source" TEXT NOT NULL DEFAULT 'plan_generation',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);

CREATE TABLE "merchant_recommendation_steps" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" UUID NOT NULL,
  "recommendation_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "order_index" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "completion_criteria" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "mode" TEXT NOT NULL,
  "capability_ref" TEXT,
  "depends_on_step_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidence_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "action_executions"
  ADD COLUMN "recommendation_step_id" UUID;


CREATE UNIQUE INDEX "merchant_recommendation_workflows_recommendation_id_version_key"
  ON "merchant_recommendation_workflows"("recommendation_id", "version");
CREATE INDEX "merchant_recommendation_workflows_recommendation_id_status_idx"
  ON "merchant_recommendation_workflows"("recommendation_id", "status");
CREATE INDEX "merchant_recommendation_workflows_merchant_id_status_create_idx"
  ON "merchant_recommendation_workflows"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_recommendation_workflows_shop_id_status_created_at_idx"
  ON "merchant_recommendation_workflows"("shop_id", "status", "created_at");

CREATE UNIQUE INDEX "merchant_recommendation_steps_workflow_id_order_index_key"
  ON "merchant_recommendation_steps"("workflow_id", "order_index");
CREATE INDEX "merchant_recommendation_steps_recommendation_id_status_idx"
  ON "merchant_recommendation_steps"("recommendation_id", "status");
CREATE INDEX "merchant_recommendation_steps_merchant_id_status_created_at_idx"
  ON "merchant_recommendation_steps"("merchant_id", "status", "created_at");
CREATE INDEX "merchant_recommendation_steps_shop_id_status_created_at_idx"
  ON "merchant_recommendation_steps"("shop_id", "status", "created_at");
CREATE INDEX "merchant_recommendation_steps_capability_ref_idx"
  ON "merchant_recommendation_steps"("capability_ref");
CREATE INDEX "action_executions_recommendation_step_id_idx"
  ON "action_executions"("recommendation_step_id");

ALTER TABLE "merchant_recommendation_workflows"
  ADD CONSTRAINT "merchant_recommendation_workflows_recommendation_id_fkey"
  FOREIGN KEY ("recommendation_id") REFERENCES "merchant_plan_recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_workflows_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_workflows_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_recommendation_steps"
  ADD CONSTRAINT "merchant_recommendation_steps_workflow_id_fkey"
  FOREIGN KEY ("workflow_id") REFERENCES "merchant_recommendation_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_steps_recommendation_id_fkey"
  FOREIGN KEY ("recommendation_id") REFERENCES "merchant_plan_recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_steps_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_recommendation_steps_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "action_executions"
  ADD CONSTRAINT "action_executions_recommendation_step_id_fkey"
  FOREIGN KEY ("recommendation_step_id") REFERENCES "merchant_recommendation_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
