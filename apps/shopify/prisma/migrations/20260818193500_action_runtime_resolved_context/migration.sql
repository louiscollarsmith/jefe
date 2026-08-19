-- Persist the exact plan/constraint/scope a Step Run executed against, and
-- the plan version that produced a Change Set, so chat and execution cannot
-- silently diverge.

ALTER TABLE "merchant_recommendation_step_runs"
  ADD COLUMN "input_snapshot_json" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "action_change_sets"
  ADD COLUMN "plan_snapshot_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "input_hash" TEXT NOT NULL DEFAULT '';
