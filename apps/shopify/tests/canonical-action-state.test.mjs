/* global process */
/**
 * Regression tests for canonical action-state propagation.
 *
 * Spec invariants enforced here:
 *   1. Changing the plan invalidates ALL stale downstream steps — even when all
 *      steps were already completed (the "all-done + plan change" case).
 *   2. resolveWorkChain includes stale upstream steps in the execution chain so
 *      draft_supplier_email never re-runs ahead of its stale prerequisites.
 *   3. isArtifactStale catches plan-version drift correctly.
 *   4. ADD_PLAN_STEP persists a new step with real UUID deps, not LLM placeholders.
 *   5. The inventory-transfer adapter preview validates inputs and enforces the
 *      blast-radius cap.
 *   6. The adapter is idempotent — a second call with the same key is a no-op.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isArtifactStale, resolveActionState, workNeedsExecution } from "../app/lib/actions/action-state.server.js";
import { resolveWorkChain } from "../app/lib/actions/agent/assist-runner.server.js";
import { ACTION_COMMAND, executeActionCommand } from "../app/lib/actions/action-command.server.js";
import {
  previewInventoryTransfer,
  executeInventoryTransfer,
  TRANSFER_BLAST_RADIUS_CAP,
} from "../app/lib/actions/inventory-transfer-adapter.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const ACTION_ID = "a1";
const quietLogger = { info() {}, warn() {}, error() {} };

// ── Test 1: isArtifactStale detects plan-version drift ──────────────────────

test("isArtifactStale returns true when planVersion differs from current version", () => {
  const step = {
    progress: {
      artifactType: "inventory_review",
      planVersion: "hash-120",
      inputHash: "input-1",
    },
  };
  assert.equal(isArtifactStale(step, { planVersion: "hash-90", inputHash: "input-1" }), true);
});

test("isArtifactStale returns false when planVersion matches", () => {
  const step = {
    progress: {
      artifactType: "inventory_review",
      planVersion: "hash-90",
      inputHash: "input-1",
    },
  };
  assert.equal(isArtifactStale(step, { planVersion: "hash-90", inputHash: "input-1" }), false);
});

test("isArtifactStale returns false when progress has no artifactType (not an artifact step)", () => {
  const step = { progress: { planVersion: "hash-120" } };
  assert.equal(isArtifactStale(step, { planVersion: "hash-90" }), false);
});

// ── Test 2: workNeedsExecution ───────────────────────────────────────────────

test("workNeedsExecution returns false only for complete and non-stale", () => {
  assert.equal(workNeedsExecution({ state: "complete", stale: false }), false);
  assert.equal(workNeedsExecution({ state: "complete", stale: true }), true);
  assert.equal(workNeedsExecution({ state: "needs_updating", stale: true }), true);
  assert.equal(workNeedsExecution({ state: "skipped", stale: false }), false);
});

// ── Test 3: resolveWorkChain uses orderIndex fallback when deps unresolved ───

test("resolveWorkChain includes stale predecessors when dependsOnStepIds reference unknown IDs", () => {
  // Simulate legacy action where dependsOnStepIds contain LLM-generated IDs
  // that do not correspond to real DB step IDs.
  const state = {
    work: [
      {
        step: { id: "uuid-step-1", title: "Review low-cover inventory", orderIndex: 0, capabilityRef: "assist:inventory_review", mode: "assist" },
        state: "needs_updating",
        stale: true,
        dependsOn: [],  // LLM IDs gone; empty because they didn't resolve
        validResult: { artifactType: "inventory_review", planVersion: "hash-120", items: [] },
        blockers: [],
      },
      {
        step: { id: "uuid-step-2", title: "Build replenishment proposal", orderIndex: 1, capabilityRef: "assist:replenishment_proposal", mode: "assist" },
        state: "needs_updating",
        stale: true,
        dependsOn: ["step_1"],  // LLM placeholder — NOT a real DB UUID
        validResult: { artifactType: "replenishment_proposal", planVersion: "hash-120", items: [] },
        blockers: [],
      },
      {
        step: { id: "uuid-step-3", title: "Draft supplier email", orderIndex: 2, capabilityRef: "assist:supplier_email_draft", mode: "assist" },
        state: "needs_updating",
        stale: true,
        dependsOn: ["step_2"],  // LLM placeholder — NOT a real DB UUID
        validResult: { artifactType: "supplier_email_draft", planVersion: "hash-120", body: "..." },
        blockers: [],
      },
    ],
  };

  const chain = resolveWorkChain(state, "uuid-step-3");
  assert.equal(chain.ok, true);
  // The defensive fallback should include all 3 stale steps via orderIndex
  const stepIds = chain.chain.map((row) => row.step.id);
  assert.ok(stepIds.includes("uuid-step-1"), "inventory review must be in chain");
  assert.ok(stepIds.includes("uuid-step-2"), "proposal must be in chain");
  assert.ok(stepIds.includes("uuid-step-3"), "email must be in chain");
  // Chain should be ordered by orderIndex
  const indices = chain.chain.map((row) => Number(row.step.orderIndex ?? 0));
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] >= indices[i - 1], "chain must be ordered by orderIndex");
  }
});

test("resolveWorkChain skips up-to-date predecessors even with unresolved dep IDs", () => {
  const state = {
    work: [
      {
        step: { id: "uuid-step-1", title: "Review low-cover inventory", orderIndex: 0, capabilityRef: "assist:inventory_review", mode: "assist" },
        state: "complete",
        stale: false,
        dependsOn: [],
        validResult: { artifactType: "inventory_review", planVersion: "hash-90", items: [] },
        blockers: [],
      },
      {
        step: { id: "uuid-step-3", title: "Draft supplier email", orderIndex: 2, capabilityRef: "assist:supplier_email_draft", mode: "assist" },
        state: "needs_updating",
        stale: true,
        dependsOn: ["step_2"],  // unresolved
        validResult: { artifactType: "supplier_email_draft", planVersion: "hash-120", body: "..." },
        blockers: [],
      },
    ],
  };

  const chain = resolveWorkChain(state, "uuid-step-3");
  assert.equal(chain.ok, true);
  const stepIds = chain.chain.map((row) => row.step.id);
  // step-1 is NOT stale so should NOT be in chain
  assert.ok(!stepIds.includes("uuid-step-1"), "up-to-date step should not be rebuilt");
  assert.ok(stepIds.includes("uuid-step-3"), "stale email step must be in chain");
});

// ── Test 4: ADD_PLAN_STEP command ────────────────────────────────────────────

test("ADD_PLAN_STEP creates a new step persisted to workflow", async () => {
  const prisma = buildRuntimePrismaForStepMutation();

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_PLAN_STEP,
    params: {
      title: "Create Shopify transfer",
      description: "Move stock from warehouse to fulfilment location",
      capabilityRef: "execute:shopify_inventory_transfer:restock",
    },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.command, ACTION_COMMAND.ADD_PLAN_STEP);
  assert.match(result.reply, /Create Shopify transfer/);
  // Step must have been created in the mock DB
  assert.ok(prisma.state.steps.length > 1, "a new step was appended");
  const newStep = prisma.state.steps.find((s) => s.title === "Create Shopify transfer");
  assert.ok(newStep, "new step exists in workflow");
  // The new step must depend on the last existing step (coherent chain)
  assert.ok(
    newStep.dependsOnStepIds.length > 0,
    "new step has at least one declared dependency"
  );
  // The declared dep must reference an existing step ID (UUID, not LLM placeholder)
  const knownIds = new Set(prisma.state.steps.filter((s) => s !== newStep).map((s) => s.id));
  assert.ok(
    newStep.dependsOnStepIds.every((id) => knownIds.has(id)),
    "dependsOnStepIds reference real DB step IDs, not LLM placeholders"
  );
});

// ── Test 5: Inventory transfer preview validates inputs ──────────────────────

test("previewInventoryTransfer rejects missing origin location", () => {
  const result = previewInventoryTransfer({
    originLocationId: "",
    destinationLocationId: "gid://shopify/Location/2",
    lineItems: [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 5 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_origin");
});

test("previewInventoryTransfer rejects same origin and destination", () => {
  const result = previewInventoryTransfer({
    originLocationId: "gid://shopify/Location/1",
    destinationLocationId: "gid://shopify/Location/1",
    lineItems: [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 5 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "same_location");
});

test("previewInventoryTransfer rejects zero or negative quantities", () => {
  const result = previewInventoryTransfer({
    originLocationId: "gid://shopify/Location/1",
    destinationLocationId: "gid://shopify/Location/2",
    lineItems: [
      { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 0 },
      { inventoryItemId: "gid://shopify/InventoryItem/2", quantity: -3 },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_valid_items");
});

// ── Test 6: Blast-radius cap ─────────────────────────────────────────────────

test("previewInventoryTransfer rejects runs exceeding TRANSFER_BLAST_RADIUS_CAP", () => {
  const lineItems = Array.from({ length: TRANSFER_BLAST_RADIUS_CAP + 1 }, (_, i) => ({
    inventoryItemId: `gid://shopify/InventoryItem/${i + 1}`,
    quantity: 1,
  }));
  const result = previewInventoryTransfer({
    originLocationId: "gid://shopify/Location/1",
    destinationLocationId: "gid://shopify/Location/2",
    lineItems,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blast_radius_exceeded");
});

test("previewInventoryTransfer accepts valid inputs and returns a summary", () => {
  const result = previewInventoryTransfer({
    originLocationId: "gid://shopify/Location/1",
    destinationLocationId: "gid://shopify/Location/2",
    lineItems: [
      { inventoryItemId: "gid://shopify/InventoryItem/1", title: "Pear Skin Sipon", quantity: 9 },
    ],
  });
  assert.equal(result.ok, true);
  assert.match(result.summary, /Pear Skin Sipon/);
  assert.match(result.summary, /9/);
  assert.equal(result.preview.lineItems.length, 1);
});

// ── Test 7: Adapter flag-gate ─────────────────────────────────────────────────

test("executeInventoryTransfer refuses when flag is disabled", async () => {
  const prevFlag = process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
  delete process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
  try {
    const result = await executeInventoryTransfer({}, {
      actionId: "a1",
      merchantId: "m1",
      shopId: "s1",
      idempotencyKey: "k1",
      preview: {
        originLocationId: "gid://shopify/Location/1",
        destinationLocationId: "gid://shopify/Location/2",
        lineItems: [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 5 }],
      },
      shopifyClient: { createInventoryTransfer: async () => ({ transfer: { id: "t1", status: "OPEN" } }) },
      logger: quietLogger,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "flag_disabled");
  } finally {
    if (prevFlag !== undefined) process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = prevFlag;
    else delete process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
  }
});

// ── Test 8: Adapter idempotency ───────────────────────────────────────────────

test("executeInventoryTransfer deduplicates on second call with same idempotency key", async () => {
  const prevFlag = process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
  process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = "true";
  try {
    let calls = 0;
    const fakePrisma = {
      actionExecutionWrite: {
        upsert: async ({ where }) => {
          assert.equal(
            where.executionId_targetRef_targetValueKey.targetValueKey,
            "idempotency:idem-key-1",
          );
          return {
            id: "write-1",
            status: "applied",
            targetValue: { shopifyTransferId: "t-shopify-1" },
          };
        },
      },
    };
    const result = await executeInventoryTransfer(fakePrisma, {
      actionId: "a1",
      executionId: "execution-1",
      merchantId: "m1",
      shopId: "s1",
      idempotencyKey: "idem-key-1",
      preview: {
        originLocationId: "gid://shopify/Location/1",
        destinationLocationId: "gid://shopify/Location/2",
        lineItems: [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 5 }],
      },
      shopifyClient: { createInventoryTransfer: async () => { calls++; return {}; } },
      logger: quietLogger,
    });
    assert.equal(result.ok, true);
    assert.equal(result.deduplicated, true);
    assert.equal(result.shopifyTransferId, "t-shopify-1");
    assert.equal(calls, 0, "Shopify was not called again on dedup");
  } finally {
    if (prevFlag !== undefined) process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = prevFlag;
    else delete process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
  }
});

// ── Test 9: resolveActionState projects needs_updating for stale steps ────────

test("resolveActionState projects needs_updating for steps whose planVersion drifted", async () => {
  const prisma = buildPrismaForStateTest();
  const state = await resolveActionState(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
  });

  const work = state?.work ?? [];
  // All 3 steps should be projected as needs_updating (stale planVersion)
  for (const row of work) {
    if (row.validResult?.artifactType) {
      assert.equal(row.stale, true, `${row.step.title} should be stale`);
      assert.ok(
        row.state === "needs_updating",
        `${row.step.title} should project as needs_updating, got ${row.state}`
      );
    }
  }
});

// ── Test 10: ADD_PLAN_STEP rejects missing title ──────────────────────────────

test("ADD_PLAN_STEP returns error when title is missing", async () => {
  const prisma = buildRuntimePrismaForStepMutation();
  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_PLAN_STEP,
    params: { description: "Something without a name" },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_title");
  // No new step was created
  assert.equal(prisma.state.steps.length, 2, "step count unchanged on failure");
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Build a minimal prisma mock for action-state projection tests. */
function buildPrismaForStateTest() {
  const stepsInDb = [
    {
      id: "db-uuid-step-1",
      workflowId: "wf-1",
      recommendationId: "rec-1",
      merchantId: MERCHANT,
      shopId: SHOP,
      orderIndex: 0,
      title: "Review low-cover inventory",
      status: "completed",
      mode: "assist",
      capabilityRef: "assist:inventory_review",
      dependsOnStepIds: [],
      // progress was stamped with OLD planVersion
      progress: { artifactType: "inventory_review", planVersion: "hash-120", items: [{ title: "Pear Skin Sipon", units: 12 }] },
      attention: {},
    },
    {
      id: "db-uuid-step-2",
      workflowId: "wf-1",
      recommendationId: "rec-1",
      merchantId: MERCHANT,
      shopId: SHOP,
      orderIndex: 1,
      title: "Build replenishment proposal",
      status: "completed",
      mode: "assist",
      capabilityRef: "assist:replenishment_proposal",
      dependsOnStepIds: ["db-uuid-step-1"],
      progress: { artifactType: "replenishment_proposal", planVersion: "hash-120", items: [] },
      attention: {},
    },
    {
      id: "db-uuid-step-3",
      workflowId: "wf-1",
      recommendationId: "rec-1",
      merchantId: MERCHANT,
      shopId: SHOP,
      orderIndex: 2,
      title: "Draft supplier email",
      status: "completed",
      mode: "assist",
      capabilityRef: "assist:supplier_email_draft",
      dependsOnStepIds: ["db-uuid-step-2"],
      progress: { artifactType: "supplier_email_draft", planVersion: "hash-120", body: "..." },
      attention: {},
    },
  ];

  return {
    merchantAction: {
      findFirst: async () => ({
        id: ACTION_ID,
        merchantId: MERCHANT,
        shopId: SHOP,
        title: "Replenishment action",
        status: "in_progress",
        sourceRecommendationId: "rec-1",
        plan: { coverDays: 90 },  // updated to 90 days
        progress: {},
        outcome: {},
        sourceRecommendation: {
          id: "rec-1",
          title: "Replenishment",
          workflows: [
            {
              id: "wf-1",
              status: "active",
              version: 1,
              steps: stepsInDb,
            },
          ],
        },
        currentExecution: null,
        executions: [],
        constraints: [],
        changeSets: [],
      }),
    },
    merchantMemoryBelief: {
      findFirst: async ({ where }) => {
        if (where.key === "inventory.low_cover_products.trailing_30d") {
          return {
            key: where.key,
            status: "active",
            value: {
              items: [
                { title: "Pear Skin Sipon", available: 3, dailyVelocity: 0.1, daysOfCover: 30 },
              ],
            },
          };
        }
        return null;
      },
    },
    merchantActionConstraint: {
      findMany: async () => [],
    },
    actionChangeSet: {
      findFirst: async () => null,
    },
    merchantRecommendationStep: {
      findMany: async () => stepsInDb,
    },
  };
}

/** Build a minimal prisma mock for step mutation tests. */
function buildRuntimePrismaForStepMutation() {
  const state = {
    action: {
      id: ACTION_ID,
      merchantId: MERCHANT,
      shopId: SHOP,
      title: "Replenishment action",
      status: "in_progress",
      sourceRecommendationId: "rec-1",
      plan: { coverDays: 120 },
      progress: {},
      outcome: {},
    },
    constraints: [],
    changeSets: [],
    beliefs: [],
    steps: [
      {
        id: "db-uuid-step-1",
        workflowId: "wf-1",
        recommendationId: "rec-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        orderIndex: 0,
        title: "Review low-cover inventory",
        status: "completed",
        mode: "assist",
        capabilityRef: "assist:inventory_review",
        dependsOnStepIds: [],
        progress: { artifactType: "inventory_review", items: [] },
        attention: {},
      },
      {
        id: "db-uuid-step-2",
        workflowId: "wf-1",
        recommendationId: "rec-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        orderIndex: 1,
        title: "Draft supplier email",
        status: "completed",
        mode: "assist",
        capabilityRef: "assist:supplier_email_draft",
        dependsOnStepIds: ["db-uuid-step-1"],
        progress: { artifactType: "supplier_email_draft", body: "..." },
        attention: {},
      },
    ],
    stepRuns: [],
  };

  const actionRow = () => ({
    ...state.action,
    sourceRecommendation: {
      id: "rec-1",
      title: "Replenishment",
      workflows: [{ id: "wf-1", status: "active", version: 1, steps: state.steps }],
    },
    currentExecution: null,
    executions: [],
    constraints: state.constraints.filter((r) => r.status === "active"),
    changeSets: [...state.changeSets].sort((a, b) => b.generatedAt - a.generatedAt),
  });

  return {
    state,
    merchantAction: {
      findFirst: async () => actionRow(),
      update: async ({ data }) => { Object.assign(state.action, data); return state.action; },
      updateMany: async ({ data }) => { Object.assign(state.action, data); return { count: 1 }; },
    },
    merchantActionConstraint: {
      findMany: async () => state.constraints.filter((r) => r.status === "active"),
      create: async ({ data }) => {
        const row = { id: `c-${state.constraints.length + 1}`, status: "active", ...data };
        state.constraints.push(row);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
    },
    actionChangeSet: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const row = { id: `cs-${state.changeSets.length + 1}`, generatedAt: new Date(), ...data };
        state.changeSets.push(row);
        return row;
      },
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    actionExecution: { findUnique: async () => null },
    merchantMemoryBelief: { findFirst: async () => null },
    merchantActionEvent: { create: async ({ data }) => data },
    merchantPlanRecommendation: { updateMany: async () => ({ count: 1 }) },
    merchantRecommendationWorkflow: { updateMany: async () => ({ count: 1 }) },
    merchantRecommendationStep: {
      findMany: async () => [...state.steps],
      findFirst: async ({ where }) => state.steps.find((r) => r.id === where.id) ?? null,
      create: async ({ data }) => {
        const row = { status: "waiting", progress: {}, attention: {}, ...data };
        state.steps.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.steps.filter((r) => {
          if (where.id && r.id !== where.id) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantRecommendationStepRun: {
      create: async ({ data }) => {
        const row = { id: `sr-${state.stepRuns.length + 1}`, ...data };
        state.stepRuns.push(row);
        return row;
      },
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
  };
}
