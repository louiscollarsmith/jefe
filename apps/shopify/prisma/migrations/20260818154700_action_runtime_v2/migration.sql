-- Action Runtime V2: revisable plan params, action-scoped constraints, and
-- first-class Change Sets. Additive only — existing actions keep working.

ALTER TABLE "merchant_actions"
  ADD COLUMN "plan_json" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE "merchant_action_constraints" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "merchant_action_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "params_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "label" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'chat',
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "removed_at" TIMESTAMPTZ(6)
);

CREATE INDEX "merchant_action_constraints_action_status_idx"
  ON "merchant_action_constraints"("merchant_action_id", "status");
CREATE INDEX "merchant_action_constraints_merchant_id_shop_id_status_idx"
  ON "merchant_action_constraints"("merchant_id", "shop_id", "status");

ALTER TABLE "merchant_action_constraints"
  ADD CONSTRAINT "merchant_action_constraints_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_action_constraints_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_action_constraints_merchant_action_id_fkey"
  FOREIGN KEY ("merchant_action_id") REFERENCES "merchant_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "action_change_sets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "shop_id" UUID NOT NULL,
  "merchant_action_id" UUID NOT NULL,
  "workflow_step_id" UUID,
  "action_execution_id" UUID,
  "action_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "items_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "excluded_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "constraint_snapshot_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "result_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "approved_at" TIMESTAMPTZ(6),
  "applied_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);

CREATE INDEX "action_change_sets_action_status_generated_idx"
  ON "action_change_sets"("merchant_action_id", "status", "generated_at");
CREATE INDEX "action_change_sets_action_execution_id_idx"
  ON "action_change_sets"("action_execution_id");
CREATE INDEX "action_change_sets_merchant_id_shop_id_status_idx"
  ON "action_change_sets"("merchant_id", "shop_id", "status");

ALTER TABLE "action_change_sets"
  ADD CONSTRAINT "action_change_sets_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "action_change_sets_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "action_change_sets_merchant_action_id_fkey"
  FOREIGN KEY ("merchant_action_id") REFERENCES "merchant_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "action_change_sets_workflow_step_id_fkey"
  FOREIGN KEY ("workflow_step_id") REFERENCES "merchant_recommendation_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "action_change_sets_action_execution_id_fkey"
  FOREIGN KEY ("action_execution_id") REFERENCES "action_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
