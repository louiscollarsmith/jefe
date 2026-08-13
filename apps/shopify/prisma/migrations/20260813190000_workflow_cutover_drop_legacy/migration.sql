-- Breaking workflow cutover.
-- The product decision for this branch is to restart recommendations/actions in
-- every environment rather than preserve old proposal rows. The workflow tables
-- are now authoritative; recommendation-level execution JSON and action intent
-- are removed, and ActionExecution links to a workflow step rather than directly
-- to a recommendation.

ALTER TABLE "action_executions"
  DROP CONSTRAINT IF EXISTS "action_executions_source_recommendation_id_fkey";

DROP INDEX IF EXISTS "action_executions_source_recommendation_id_key";

ALTER TABLE "action_executions"
  DROP COLUMN IF EXISTS "source_recommendation_id";

ALTER TABLE "merchant_plan_recommendations"
  DROP COLUMN IF EXISTS "execution_steps_json",
  DROP COLUMN IF EXISTS "action_intent_json";
