/**
 * Regression tests: run identity and ownership invariant.
 *
 * Guards the invariant:
 *   A worker job created for run X must either execute run X or explicitly
 *   transition X out of its active state. It must never silently execute run Y
 *   while leaving X queued/running.
 *
 * Root cause of the live regression (2026-08-23):
 *   When the snapshot hash changed between enqueue and worker pickup (because
 *   shopifyMirrorWatermark was added to the schema), loadPreparedAgenticRecommendationRun
 *   fell through to prepareAgenticRecommendationRun, which created a new run Y with
 *   sourceMode="agentic". The original home-triggered run X stayed queued forever.
 *   Home polling continued to observe X (sourceMode="home", status="queued") and the
 *   UI showed "Finding your next move…" indefinitely.
 *
 * After fix:
 *   - Queued run + any hash change → refresh in-place; original run is executed.
 *   - sourceMode is read from the persisted run, never from a default.
 *   - No run Y is created.
 *   - Running run → immutable snapshot for that attempt.
 *   - Terminal run + hash change → new run created (legitimate re-investigation).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { runAgenticRecommendationInvestigation } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

/**
 * Minimal mock Prisma that returns a queued run and enough snapshot data to
 * satisfy buildAgenticRecommendationSnapshot (3 goal horizons for hasGoals).
 *
 * Captures all update/create/upsert calls for assertion.
 */
function makeQueuedRunPrisma({
  runId = "run-x",
  sourceMode = "home",
  snapshotHash = sha256({ seed: "stale" }),
  baseSnapshotHash = sha256({ seed: "stale-base" }),
  status = "queued",
  startedAt = null,
} = {}) {
  const updates = [];
  const creates = [];
  const upserts = [];

  const run = {
    id: runId,
    status,
    sourceMode,
    snapshotHash,
    merchantId: "m1",
    shopId: "s1",
    startedAt,
    result: {
      retryOfRunId: null,
      baseSnapshotHash,
      onboardingEpoch: null,
      attemptNumber: 1,
      attemptReason: "explicit_retry",
      runtime: "agentic_shopify",
    },
    provider: null,
    modelIdentifier: null,
  };

  const threeGoals = [
    { id: "h1", horizon: "short", title: "Grow revenue", description: "...", supportingBeliefIds: [] },
    { id: "h2", horizon: "medium", title: "Improve margin", description: "...", supportingBeliefIds: [] },
    { id: "h3", horizon: "long", title: "Reduce churn", description: "...", supportingBeliefIds: [] },
  ];

  const prisma = {
    merchantPlanRun: {
      findFirst: async (args) => {
        // First call: find by runId (return queued run)
        // Subsequent calls (e.g. loadPreviousAttemptDiagnostics): return null
        if (args?.where?.id === runId) return run;
        return null;
      },
      update: async (args) => {
        updates.push(args);
        return { ...run, ...args.data };
      },
      updateMany: async (args) => {
        updates.push({ ...args, _many: true });
        return { count: 1 };
      },
      create: async (args) => {
        creates.push(args);
        return { id: "run-new-" + creates.length, status: "queued", ...args.data };
      },
      upsert: async (args) => {
        upserts.push(args);
        return { id: "run-upsert-" + upserts.length, status: "queued", ...args.create };
      },
      count: async () => 1,
    },
    merchantGoalRun: {
      findFirst: async () => ({
        id: "gr1",
        horizons: threeGoals,
        completedAt: new Date(),
      }),
    },
    merchantInsightRun: {
      findFirst: async () => ({
        id: "ir1",
        findings: [],
        completedAt: new Date(),
      }),
    },
    merchantMemoryBelief: {
      findMany: async () => [],
    },
    merchantPlanRecommendation: {
      findMany: async () => [],
    },
    merchantMemoryEvidence: {
      findMany: async () => [],
    },
    merchantAction: {
      findMany: async () => [],
    },
    shopBackfillStatus: {
      findUnique: async () => ({ updatedAt: new Date("2026-08-23T10:00:00Z") }),
    },
    merchantEpisodicMemory: {
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  return { prisma, updates, creates, upserts, run };
}

/** Mock LLM provider that immediately returns model_disabled (avoids actual LLM calls). */
function disabledProvider() {
  return {
    provider: "test",
    model: "test-model",
    enabled: false,
    generateStructuredJson: null,
  };
}

/** Mock LLM provider that immediately returns BLOCKED. */
function blockedProvider() {
  const blocked = {
    ok: false,
    status: "BLOCKED",
    blocker: "Test BLOCKED outcome — no safe action available.",
    diagnostics: { shopifyReads: [], investigationTurns: 1, hypothesesConsidered: [], feasibleInterventions: [], rejectedInterventions: [], retrievedOperations: [], semanticRepair: null },
    trace: { turns: [{ status: "BLOCKED", hypothesesConsidered: [], toolCallCount: 0 }], toolResults: [] },
  };
  return {
    provider: "test",
    model: "test-model",
    enabled: true,
    generateStructuredJson: async () => blocked,
  };
}

const BASE_INPUT = {
  merchantId: "m1",
  shopId: "s1",
  shopDomain: "test.myshopify.com",
  accessToken: "shpat_test",
  scopes: [],
};

// ---------------------------------------------------------------------------
// Test 1: Queued run + hash mismatch → original run is used, no new run created
// ---------------------------------------------------------------------------

test("queued run with hash mismatch: original run is executed, no new run created", async () => {
  const { prisma, updates, creates, upserts, run } = makeQueuedRunPrisma({
    runId: "run-x",
    sourceMode: "home",
    // Deliberately stale hash — current snapshot will produce a different hash
    snapshotHash: sha256({ seed: "stale-hash-before-watermark" }),
  });

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  // No new run must be created or upserted
  assert.equal(creates.length, 0, "No new run must be created");
  assert.equal(upserts.length, 0, "No upsert must be called");

  // The first update must be for the original run (transition to running)
  const runningUpdate = updates.find((u) => u.data?.status === "running");
  assert.ok(runningUpdate, "Run must be transitioned to running");
  assert.equal(runningUpdate.where.id, run.id, "The running update must target the original run X");
});

// ---------------------------------------------------------------------------
// Test 2: sourceMode is preserved from the persisted run, never defaulted
// ---------------------------------------------------------------------------

test("queued run: sourceMode is preserved from DB, not defaulted to 'agentic'", async () => {
  const { prisma, updates, run } = makeQueuedRunPrisma({
    runId: "run-home",
    sourceMode: "home",
    snapshotHash: sha256({ seed: "old" }),
  });

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  // The run that was marked running should be the same run with sourceMode=home.
  // We verify this by confirming the update was on the original run ID, not a new one.
  const runningUpdate = updates.find((u) => u.data?.status === "running");
  assert.equal(runningUpdate?.where?.id, run.id, "Update must target original run ID");
  // sourceMode must remain "home" on the DB row (no update to sourceMode field)
  const sourceModeOverwritten = updates.some((u) => u.data?.sourceMode && u.data.sourceMode !== "home");
  assert.equal(sourceModeOverwritten, false, "sourceMode must not be overwritten");
});

// ---------------------------------------------------------------------------
// Test 3: Watermark advances before pickup → original run still used
// ---------------------------------------------------------------------------

test("watermark advance between enqueue and pickup: original run is still executed", async () => {
  const { prisma, updates, creates, run } = makeQueuedRunPrisma({
    runId: "run-watermark",
    sourceMode: "home",
    snapshotHash: sha256({ snapshotVersion: "v1", watermark: "2026-08-23T10:00:00Z" }),
  });

  // Simulate watermark advancing: Prisma returns a later timestamp
  prisma.shopBackfillStatus.findUnique = async () => ({ updatedAt: new Date("2026-08-23T10:05:00Z") });

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  assert.equal(creates.length, 0, "No new run must be created after watermark advance");
  const runningUpdate = updates.find((u) => u.data?.status === "running");
  assert.equal(runningUpdate?.where?.id, run.id, "Original run must be executed");
});

// ---------------------------------------------------------------------------
// Test 4: Active Action added before pickup → original run still used
// ---------------------------------------------------------------------------

test("active Action added between enqueue and pickup: original run is still executed", async () => {
  const { prisma, updates, creates, run } = makeQueuedRunPrisma({
    runId: "run-action-change",
    sourceMode: "home",
    snapshotHash: sha256({ seed: "no-actions" }),
  });

  // Simulate a new proposed Action appearing
  prisma.merchantAction.findMany = async () => [
    {
      id: "action-new",
      status: "proposed",
      title: "Hide out-of-stock products",
      plan: { agentic: { semanticAction: { feasibleWriteOperations: ["productUpdate"], eligibilityCriteria: [] } } },
      outcome: {},
      updatedAt: new Date(),
    },
  ];

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  assert.equal(creates.length, 0, "No new run must be created after Action state change");
  const runningUpdate = updates.find((u) => u.data?.status === "running");
  assert.equal(runningUpdate?.where?.id, run.id);
});

// ---------------------------------------------------------------------------
// Test 5: Memory changes before pickup → original run still used
// ---------------------------------------------------------------------------

test("Memory belief added before pickup: original run is refreshed in place", async () => {
  const { prisma, updates, creates, run } = makeQueuedRunPrisma({
    runId: "run-memory-change",
    sourceMode: "home",
    snapshotHash: sha256({ seed: "no-beliefs" }),
  });

  // Simulate a new belief
  prisma.merchantMemoryBelief.findMany = async () => [
    {
      id: "b1", key: "dead_stock_count", category: "inventory", valueType: "number",
      value: { number: 5 }, status: "inferred", confidence: 0.9, precedence: 50,
      evidence: [], updatedAt: new Date(),
    },
  ];

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  assert.equal(creates.length, 0);
  const runningUpdate = updates.find((u) => u.data?.status === "running");
  assert.equal(runningUpdate?.where?.id, run.id);
});

// ---------------------------------------------------------------------------
// Test 6: Snapshot version changes → queued run still executed (not replaced)
// ---------------------------------------------------------------------------

test("snapshot schema version bump: queued run is refreshed in-place, not replaced", async () => {
  // Simulate a run created under an old snapshot version (v1 hash)
  const staleHash = sha256({ snapshotVersion: "agentic-recommendation-snapshot-v1", seed: "data" });
  const { prisma, updates, creates, run } = makeQueuedRunPrisma({
    runId: "run-version-change",
    sourceMode: "home",
    snapshotHash: staleHash,
    baseSnapshotHash: staleHash,
  });

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  assert.equal(creates.length, 0, "No new run must be created after schema version change");
  const runningUpdate = updates.find((u) => u.data?.status === "running");
  assert.equal(runningUpdate?.where?.id, run.id, "Original run must execute despite version change");
});

// ---------------------------------------------------------------------------
// Test 7: No hidden successor run (DB run count does not increase)
// ---------------------------------------------------------------------------

test("snapshot mismatch on queued run: database run count does not increase", async () => {
  const { prisma, updates, creates, upserts } = makeQueuedRunPrisma({
    runId: "run-no-successor",
    sourceMode: "home",
    snapshotHash: sha256({ seed: "mismatched" }),
  });

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: "run-no-successor",
    llmProvider: disabledProvider(),
  });

  assert.equal(creates.length + upserts.length, 0, "No new runs must be created or upserted");
});

// ---------------------------------------------------------------------------
// Test 8: Running run — snapshot change does not silently switch identity
// ---------------------------------------------------------------------------

test("running run: snapshot change does not switch to a different run", async () => {
  const { prisma, updates, creates, upserts, run } = makeQueuedRunPrisma({
    runId: "run-already-running",
    sourceMode: "home",
    status: "running",
    startedAt: new Date(Date.now() - 5000),
    snapshotHash: sha256({ seed: "original-snapshot" }),
  });

  // Advance watermark so current hash differs
  prisma.shopBackfillStatus.findUnique = async () => ({ updatedAt: new Date("2026-08-23T12:00:00Z") });

  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  // A running run may be retried by the worker (crash recovery) — in all cases,
  // no NEW run must be silently created. Identity must stay on the original run.
  assert.equal(creates.length, 0, "No new run must be created for a running run");
  assert.equal(upserts.length, 0, "No upsert must be called for a running run");

  // Any status update must target the original run, not a new one
  for (const u of updates) {
    if (u.where?.id) {
      assert.equal(u.where.id, run.id, `Update targeted wrong run: expected ${run.id}, got ${u.where.id}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Test 9: Worker exception after claim → run reaches 'failed', not stuck queued
// ---------------------------------------------------------------------------

test("worker exception after claiming run → run reaches failed, not stuck in queued", async () => {
  const { prisma, updates, run } = makeQueuedRunPrisma({
    runId: "run-exception",
    sourceMode: "home",
    snapshotHash: sha256({ seed: "exception-test" }),
  });

  // Provider throws — simulates an error during investigation
  const throwingProvider = {
    provider: "test",
    model: "test-model",
    enabled: true,
    generateStructuredJson: async () => {
      throw new Error("Simulated LLM network error");
    },
  };

  await assert.rejects(
    () => runAgenticRecommendationInvestigation(prisma, {
      ...BASE_INPUT,
      runId: run.id,
      llmProvider: throwingProvider,
    }),
    (err) => err instanceof Error, // catch block re-throws the original error
  );

  // After the throw, the catch block must have called updateMany on the run to 'failed'
  const failedUpdate = updates.find((u) => u.data?.status === "failed");
  assert.ok(failedUpdate, "Run must be marked failed after exception");
  // The updateMany targets by id (via where.id) — must reference the original run
  assert.equal(failedUpdate.where?.id, run.id, "Failed update must target original run ID");
});

// ---------------------------------------------------------------------------
// Test 10: Home polling path — snapshot change mid-flight: same run ID observed throughout
// ---------------------------------------------------------------------------

test("home polling path: same durable run ID throughout despite snapshot change", async () => {
  const originalHash = sha256({ seed: "pre-watermark" });
  const { prisma, updates, creates, run } = makeQueuedRunPrisma({
    runId: "run-home-poll",
    sourceMode: "home",
    snapshotHash: originalHash,
  });

  // Simulate watermark advance before pickup
  prisma.shopBackfillStatus.findUnique = async () => ({ updatedAt: new Date("2026-08-23T11:00:00Z") });

  const result = await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  });

  // The result must reference the original run ID, not a new one
  assert.equal(result.runId, run.id, "Result must carry the original run ID");

  // No new run must have been created
  assert.equal(creates.length, 0, "No new run created during home polling path");

  // Home polling looks for runId in the result — it must be the same durable ID
  // regardless of how many times the snapshot changes before the worker starts.
  assert.equal(typeof result.runId, "string");
  assert.notEqual(result.runId, undefined);
});

// ---------------------------------------------------------------------------
// Test 11: BLOCKED → no_actionable_opportunity (not failed)
// ---------------------------------------------------------------------------

test("BLOCKED investigation outcome → no_actionable_opportunity terminal state", async () => {
  const { prisma, updates, run } = makeQueuedRunPrisma({
    runId: "run-blocked",
    sourceMode: "home",
    snapshotHash: sha256({ seed: "blocked-test" }),
  });

  const result = await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: blockedProvider(),
  });

  assert.equal(result.status, "no_actionable_opportunity",
    "BLOCKED outcome must map to no_actionable_opportunity, not failed");

  // DB update must set terminal status to no_actionable_opportunity
  const terminalUpdate = updates.find((u) => u.data?.status === "no_actionable_opportunity");
  assert.ok(terminalUpdate, "DB must be updated to no_actionable_opportunity");

  // completedAt must be set, failedAt must not be
  assert.ok(terminalUpdate.data.completedAt, "completedAt must be set for no_actionable_opportunity");
  assert.equal(terminalUpdate.data.failedAt ?? null, null, "failedAt must not be set");

  // safeErrorCode must be null (no error for legitimate blocker)
  assert.equal(terminalUpdate.data.safeErrorCode ?? null, null,
    "safeErrorCode must be null for BLOCKED outcome");
});

// ---------------------------------------------------------------------------
// Test 12: Terminal run + hash mismatch → new run IS created (legitimate case)
// ---------------------------------------------------------------------------

test("terminal run + hash mismatch → new run is legitimately created (not the orphan case)", async () => {
  const staleHash = sha256({ seed: "completed-run" });
  const { prisma, updates, creates, upserts, run } = makeQueuedRunPrisma({
    runId: "run-terminal",
    sourceMode: "home",
    status: "no_actionable_opportunity", // terminal
    snapshotHash: staleHash,
    baseSnapshotHash: staleHash,
  });

  // Run that is terminal and whose hash changed: worker should create a new run
  // This is the intended "re-investigate after state change" path.
  await runAgenticRecommendationInvestigation(prisma, {
    ...BASE_INPUT,
    runId: run.id,
    llmProvider: disabledProvider(),
  }).catch(() => {}); // may error because upsert mock is simplified

  // For a terminal run with hash mismatch, a new run is created/upserted
  // (this is correct behavior — the terminal run's state changed, re-investigate)
  const anyNewRun = creates.length + upserts.length > 0;
  assert.ok(anyNewRun, "Terminal run + hash mismatch should create a new run (legitimate path)");
});
