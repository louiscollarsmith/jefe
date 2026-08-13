import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const schemaSource = fs.readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migrationSource = fs.readFileSync(
  new URL(
    "../prisma/migrations/20260813173000_focused_actions/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("schema exposes MerchantAction as the durable action identity", () => {
  assert.match(schemaSource, /model MerchantAction \{/);
  assert.match(schemaSource, /@@map\("merchant_actions"\)/);
  assert.match(schemaSource, /sourceRecommendationId\s+String\?\s+@unique/);
  assert.match(schemaSource, /currentActionRunId\s+String\?/);
  assert.match(schemaSource, /model MerchantActionEvent \{/);
  assert.match(schemaSource, /@@map\("merchant_action_events"\)/);
  assert.match(schemaSource, /focusedActionId\s+String\?\s+@map\("focused_action_id"\)/);
  assert.match(schemaSource, /merchantActionId\s+String\?\s+@map\("merchant_action_id"\)/);
});

test("migration is additive and backfills recommendations, executions, and old action chats", () => {
  assert.match(migrationSource, /CREATE TABLE "merchant_actions"/);
  assert.match(migrationSource, /CREATE TABLE "merchant_action_events"/);
  assert.match(
    migrationSource,
    /ALTER TABLE "merchant_memory_conversations"\s+ADD COLUMN "focused_action_id"/,
  );
  assert.match(
    migrationSource,
    /ALTER TABLE "action_executions"\s+ADD COLUMN "merchant_action_id"/,
  );
  assert.match(migrationSource, /INSERT INTO "merchant_actions"/);
  assert.match(migrationSource, /FROM "merchant_plan_recommendations" rec/);
  assert.match(migrationSource, /UPDATE "action_executions" exec/);
  assert.match(migrationSource, /source_recommendation_id/);
  assert.match(migrationSource, /conversation\."topic" = \('action:' \|\| action\."source_recommendation_id"::text\)/);
  assert.match(migrationSource, /conversation\."topic" = \('action:' \|\| action\."current_action_run_id"::text\)/);
  assert.match(migrationSource, /conversation\."context_json"->>'recommendationId'/);
  assert.match(migrationSource, /conversation\."context_json"->>'actionRunId'/);
  assert.match(migrationSource, /focus_migrated/);
});

test("migration uses the new lifecycle terms without deleting source lifecycles", () => {
  for (const status of [
    "proposed",
    "accepted",
    "in_progress",
    "deferred",
    "declined",
    "completed",
    "superseded",
  ]) {
    assert.match(migrationSource, new RegExp(`'${status}'`));
  }
  assert.doesNotMatch(migrationSource, /DROP TABLE "merchant_plan_recommendations"/);
  assert.doesNotMatch(migrationSource, /DROP TABLE "action_executions"/);
});
