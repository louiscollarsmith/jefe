import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptMerchantActionPlan,
  advanceActionWorkflow,
  assertWorkflowConsistent,
  completeActionStepRun,
  completeCurrentActionStep,
  hasDerivableInconsistency,
  healInconsistentWorkflow,
  reconcileWorkflow,
  skipCurrentActionStep,
  startActionStep,
  stopActionStep,
  unlockActiveWorkflowIfNeeded,
} from "../app/lib/actions/action-step-lifecycle.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const NOW = new Date("2026-08-14T12:00:00.000Z");

test("accepting a proposed action unlocks the first eligible step without execution", async () => {
  const prisma = buildPrisma();

  const result = await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(prisma.state.action.status, "accepted");
  assert.equal(prisma.state.recommendation.reviewStatus, "accepted");
  assert.equal(prisma.state.steps[0].status, "ready");
  assert.equal(prisma.state.steps[1].status, "waiting");
  assert.equal(prisma.state.stepRuns.length, 0);
  assert.equal(prisma.state.executions[0].status, "proposed");
});

test("starting a ready step atomically creates one queued step run", async () => {
  const prisma = buildPrisma();
  await acceptMerchantActionPlan({
    ...prisma,
    $transaction: undefined,
  }, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  const first = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });
  const second = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(first.ok, true);
  assert.equal(prisma.state.action.status, "in_progress");
  assert.equal(prisma.state.steps[0].status, "running");
  assert.equal(prisma.state.stepRuns.length, 1);
  assert.equal(prisma.state.stepRuns[0].status, "queued");
  assert.equal(second.ok, false);
  assert.match(second.reason, /^step_not_ready:running/);
});

test("completing a Jefe step advances to a merchant-owned next step", async () => {
  const prisma = buildPrisma();
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });
  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  const completed = await completeActionStepRun(prisma, {
    stepRunId: started.stepRunId,
    result: { ok: true, appliedCount: 0 },
    logger: quietLogger,
  });

  assert.equal(completed.ok, true);
  assert.equal(prisma.state.steps[0].status, "completed");
  assert.equal(prisma.state.steps[1].status, "needs_merchant");
  assert.equal(prisma.state.action.status, "in_progress");
});

test("starting advances pending steps when the plan is accepted but not unlocked yet", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "accepted";
  prisma.state.recommendation.reviewStatus = "accepted";
  prisma.state.steps[0].status = "pending";
  prisma.state.steps[1].status = "pending";

  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(started.ok, true);
  assert.equal(prisma.state.steps[0].status, "running");
  assert.equal(prisma.state.steps[1].status, "waiting");
  assert.equal(prisma.state.stepRuns.length, 1);
});

test("unlocking an accepted workflow with leftover pending steps makes the first step ready", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "accepted";
  prisma.state.recommendation.reviewStatus = "accepted";
  prisma.state.steps[0].status = "pending";
  prisma.state.steps[1].status = "pending";

  const unlocked = await unlockActiveWorkflowIfNeeded(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
  });

  assert.equal(unlocked.unlocked, true);
  assert.equal(prisma.state.steps[0].status, "ready");
  assert.equal(prisma.state.steps[1].status, "waiting");
});

test("starting can claim an assist step unlocked as needs_merchant", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "accepted";
  prisma.state.recommendation.reviewStatus = "accepted";
  prisma.state.steps = [
    step({
      id: "step-1",
      orderIndex: 0,
      mode: "assist",
      capabilityRef: "assist:inventory_review",
      status: "needs_merchant",
    }),
    step({
      id: "step-2",
      orderIndex: 1,
      mode: "merchant_action",
      dependsOnStepIds: ["step-1"],
      status: "waiting",
    }),
  ];
  prisma.state.workflow.steps = prisma.state.steps;
  prisma.state.recommendation.workflows = [prisma.state.workflow];

  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(started.ok, true);
  assert.equal(prisma.state.steps[0].status, "running");
  assert.equal(prisma.state.stepRuns.length, 1);
});

test("stopping a running step cancels the run and restores ready", async () => {
  const prisma = buildPrisma();
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });
  await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  const stopped = await stopActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  assert.equal(stopped.ok, true);
  assert.equal(prisma.state.steps[0].status, "ready");
  assert.equal(prisma.state.stepRuns[0].status, "cancelled");
});

test("completing a merchant-owned step advances the plan", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "needs_merchant";
  prisma.state.steps[1].mode = "merchant_action";

  const completed = await completeCurrentActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.completed, true);
  assert.equal(prisma.state.steps[1].status, "completed");
  assert.equal(prisma.state.action.status, "completed");
});

test("skipping the current step unlocks the next one", async () => {
  const prisma = buildPrisma();
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  const skipped = await skipCurrentActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  assert.equal(skipped.ok, true);
  assert.equal(prisma.state.steps[0].status, "skipped");
  assert.equal(prisma.state.steps[1].status, "needs_merchant");
});

test("advance does not complete the action while workflow steps are still waiting", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting";

  const advance = await advanceActionWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(advance.completed, false);
  assert.equal(prisma.state.action.status, "in_progress");
  assert.equal(prisma.state.steps[1].status, "needs_merchant");
});

test("reconcile fixes an impossible completed->waiting dependency state", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";

  // Impossible state: step 2 depends only on step 1, but step 2 is still waiting.
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, false);
  assert.equal(prisma.state.steps[0].status, "completed");
  assert.equal(prisma.state.steps[1].status, "needs_merchant");
});

test("partial execution records needs_attention instead of completing the action", async () => {
  const prisma = buildPrisma();
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });
  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  const completed = await completeActionStepRun(prisma, {
    stepRunId: started.stepRunId,
    result: { ok: true, status: "partially_applied", skippedCount: 2 },
    logger: quietLogger,
  });

  assert.equal(completed.ok, true);
  assert.equal(prisma.state.steps[0].status, "needs_attention");
  assert.equal(prisma.state.steps[0].attention.skippedCount, 2);
  assert.equal(prisma.state.steps[1].status, "waiting");
});

// ---------------------------------------------------------------------------
// LIFECYCLE PROPERTY TESTS
// ---------------------------------------------------------------------------

test("INVARIANT: completed prerequisite — dependent cannot remain waiting", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, false);
  // Step 2 depends only on step 1 (completed) → must be promoted
  assert.notEqual(prisma.state.steps[1].status, "waiting");
  assert.ok(
    ["ready", "needs_merchant"].includes(prisma.state.steps[1].status),
    `expected ready/needs_merchant, got ${prisma.state.steps[1].status}`,
  );
});

test("INVARIANT: unsatisfied prerequisite — dependent cannot be ready", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "waiting";
  prisma.state.steps[1].status = "waiting";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, false);
  // Step 1 is waiting (unsatisfied) → step 2 must not become ready
  assert.ok(
    !["ready", "needs_merchant"].includes(prisma.state.steps[1].status),
    `step 2 must not be ready when step 1 is waiting, got ${prisma.state.steps[1].status}`,
  );
});

test("INVARIANT: all steps terminal — action completes", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "completed";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, true);
  assert.equal(prisma.state.action.status, "completed");
});

test("INVARIANT: failed step — dependent cannot become ready", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "needs_attention";
  prisma.state.steps[1].status = "waiting";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, false);
  // Step 1 needs attention (not terminal) → step 2 must not be ready
  assert.equal(prisma.state.steps[1].status, "waiting");
});

test("INVARIANT: retry succeeds — dependent becomes ready", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "needs_attention";
  prisma.state.steps[1].status = "waiting";

  // Simulate retry: step 1 becomes completed
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[0].completedAt = new Date();

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, false);
  assert.ok(
    ["ready", "needs_merchant"].includes(prisma.state.steps[1].status),
    `after retry, step 2 should be ready/needs_merchant, got ${prisma.state.steps[1].status}`,
  );
});

test("INVARIANT: optional step skipped — action can complete when all required satisfied", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  // Remove dependency so both steps are independent
  prisma.state.steps[1].dependsOnStepIds = [];
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "skipped";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, true);
  assert.equal(prisma.state.action.status, "completed");
});

test("START_STEP reconciles stale waiting state before validating startability", async () => {
  const prisma = buildPrisma();
  // Impossible persisted state: step 1 completed, step 2 still waiting
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting";

  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  // Reconciliation should promote step 2 to needs_merchant (merchant_action mode).
  // needs_merchant is not Jefe-startable, so the attempt is correctly rejected —
  // but the reason must reflect the reconciled state, not the stale "waiting" state.
  assert.equal(prisma.state.steps[1].status, "needs_merchant", "reconcile must promote the dependent");
  assert.equal(started.ok, false);
  // Should report needs_merchant, NOT "waiting" (which would be the stale reason)
  assert.match(started.reason, /step_not_ready:needs_merchant/);
});

test("START_STEP reconciles and starts assist step that was stale waiting", async () => {
  const prisma = buildPrisma();
  // Override step 2 to be assist mode (Jefe-startable when ready)
  prisma.state.steps[1].mode = "assist";
  prisma.state.steps[1].capabilityRef = "assist:replenishment_proposal";
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting"; // stale

  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  // Reconcile promotes step 2 to ready, then start claims it.
  assert.equal(started.ok, true, `expected start ok, got reason: ${started.reason}`);
  assert.equal(prisma.state.steps[1].status, "running");
  assert.equal(prisma.state.stepRuns.length, 1);
});

test("START_STEP on genuinely waiting step returns structured reason", async () => {
  const prisma = buildPrisma();
  // Three-step workflow: A → B → C. A is in_progress (not terminal), B waiting.
  prisma.state.steps.push(
    step({ id: "step-3", orderIndex: 2, mode: "assist", dependsOnStepIds: ["step-2"], status: "waiting" }),
  );
  prisma.state.workflow.steps = prisma.state.steps;
  prisma.state.recommendation.workflows = [prisma.state.workflow];

  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "running"; // A still running
  prisma.state.steps[1].status = "waiting"; // B waiting on A
  prisma.state.steps[2].status = "waiting"; // C waiting on B

  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  // Step 1 is running (active) → start claims it → step_not_ready:running
  assert.equal(started.ok, false);
  assert.match(started.reason, /step_not_ready:running/);
});

// ---------------------------------------------------------------------------
// REGRESSION: hasDerivableInconsistency
// ---------------------------------------------------------------------------

test("hasDerivableInconsistency detects completed-prerequisite/waiting-dependent stale state", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "completed", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "waiting", dependsOnStepIds: ["s1"] },
  ];
  assert.equal(hasDerivableInconsistency(steps), true);
});

test("hasDerivableInconsistency returns false when dependency is not terminal", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "running", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "waiting", dependsOnStepIds: ["s1"] },
  ];
  assert.equal(hasDerivableInconsistency(steps), false);
});

test("hasDerivableInconsistency returns false when no steps are waiting", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "completed", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "needs_merchant", dependsOnStepIds: ["s1"] },
  ];
  assert.equal(hasDerivableInconsistency(steps), false);
});

// ---------------------------------------------------------------------------
// REGRESSION: assertWorkflowConsistent
// ---------------------------------------------------------------------------

test("assertWorkflowConsistent throws on completed-prerequisite/waiting-dependent", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "completed", title: "Step 1", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "waiting", title: "Step 2", dependsOnStepIds: ["s1"] },
  ];
  assert.throws(
    () => assertWorkflowConsistent(steps, { throwOnViolation: true }),
    /Step "Step 2" is waiting but all dependencies are satisfied/,
  );
});

test("assertWorkflowConsistent returns violations without throwing when throwOnViolation is false", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "completed", title: "Step 1", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "waiting", title: "Step 2", dependsOnStepIds: ["s1"] },
  ];
  const result = assertWorkflowConsistent(steps, { throwOnViolation: false });
  assert.equal(result.consistent, false);
  assert.equal(result.violations.length, 1);
});

test("assertWorkflowConsistent passes for a clean state", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "completed", title: "Step 1", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "needs_merchant", title: "Step 2", dependsOnStepIds: ["s1"] },
    { id: "s3", orderIndex: 2, status: "waiting", title: "Step 3", dependsOnStepIds: ["s2"] },
  ];
  const result = assertWorkflowConsistent(steps, { throwOnViolation: false });
  assert.equal(result.consistent, true);
  assert.equal(result.violations.length, 0);
});

test("assertWorkflowConsistent detects completed action with non-terminal steps", () => {
  const steps = [
    { id: "s1", orderIndex: 0, status: "completed", title: "Step 1", dependsOnStepIds: [] },
    { id: "s2", orderIndex: 1, status: "running", title: "Step 2", dependsOnStepIds: ["s1"] },
  ];
  const result = assertWorkflowConsistent(steps, { actionStatus: "completed", throwOnViolation: false });
  assert.equal(result.consistent, false);
  assert.ok(result.violations.some((v) => /completed but steps are still non-terminal/.test(v)));
});

// ---------------------------------------------------------------------------
// REGRESSION: healInconsistentWorkflow
// ---------------------------------------------------------------------------

test("healInconsistentWorkflow repairs stale completed-prerequisite/waiting-dependent state", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting";

  const result = await healInconsistentWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  assert.equal(result.healed, true);
  // Step 2 should now be promoted to needs_merchant (its mode is merchant_action)
  assert.ok(
    ["ready", "needs_merchant"].includes(prisma.state.steps[1].status),
    `expected promoted, got ${prisma.state.steps[1].status}`,
  );
});

test("healInconsistentWorkflow no-ops when state is already consistent", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "running";
  prisma.state.steps[1].status = "waiting";

  const result = await healInconsistentWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  assert.equal(result.healed, false);
  assert.equal(prisma.state.steps[0].status, "running");
  assert.equal(prisma.state.steps[1].status, "waiting");
});

test("healInconsistentWorkflow no-ops when a live active step exists", async () => {
  // If step 1 is running, there is already an active step — do not compete.
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "running"; // already active

  const result = await healInconsistentWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });

  assert.equal(result.healed, false);
});

// ---------------------------------------------------------------------------
// REGRESSION: three-step workflow stale repair
// ---------------------------------------------------------------------------

test("reconcile repairs three-step stale state: step1=completed, step2=waiting, step3=waiting", async () => {
  const prisma = buildPrisma();
  prisma.state.steps.push(
    step({ id: "step-3", orderIndex: 2, mode: "assist", dependsOnStepIds: ["step-2"], status: "waiting" }),
  );
  prisma.state.workflow.steps = prisma.state.steps;
  prisma.state.recommendation.workflows = [prisma.state.workflow];

  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting"; // stale — should be promoted
  prisma.state.steps[2].status = "waiting"; // correctly waiting on step 2

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  assert.equal(reconciled.completed, false);
  assert.equal(prisma.state.steps[0].status, "completed");
  assert.ok(
    ["ready", "needs_merchant"].includes(prisma.state.steps[1].status),
    `step 2 should be promoted, got ${prisma.state.steps[1].status}`,
  );
  assert.equal(prisma.state.steps[2].status, "waiting", "step 3 must still wait on step 2");
});

test("START_STEP self-heals three-step stale state without explicit reconcile call", async () => {
  const prisma = buildPrisma();
  // Override step 2 to be assist (Jefe-startable)
  prisma.state.steps[1].mode = "assist";
  prisma.state.steps[1].capabilityRef = "assist:replenishment_proposal";
  prisma.state.steps.push(
    step({ id: "step-3", orderIndex: 2, mode: "assist", dependsOnStepIds: ["step-2"], status: "waiting" }),
  );
  prisma.state.workflow.steps = prisma.state.steps;
  prisma.state.recommendation.workflows = [prisma.state.workflow];

  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting"; // stale — not explicitly reconciled first

  // Call START_STEP directly without any prior reconcile call
  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(started.ok, true, `START_STEP must self-heal and start: got reason ${started.reason}`);
  assert.equal(prisma.state.steps[1].status, "running");
  assert.equal(prisma.state.stepRuns.length, 1);
});

test("genuine waiting state (unsatisfied dep) stays waiting after reconcile", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  // step 1 is in needs_attention (not terminal) so step 2 must stay waiting
  prisma.state.steps[0].status = "needs_attention";
  prisma.state.steps[1].status = "waiting";

  const reconciled = await reconcileWorkflow(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    workflowId: "wf-1",
  });

  // Step 1 is the current step (needs_attention is active), step 2 must stay waiting
  assert.equal(reconciled.completed, false);
  assert.equal(prisma.state.steps[1].status, "waiting");
});

test("step run completion immediately promotes dependent step without separate reconcile call", async () => {
  const prisma = buildPrisma();
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  // Accept to get step 1 ready, then start
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });
  prisma.state.steps[0].status = "draft"; // reset to allow fresh start
  prisma.state.action.status = "accepted";

  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });
  const started = await startActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    logger: quietLogger,
  });
  assert.equal(started.ok, true);

  const completed = await completeActionStepRun(prisma, {
    stepRunId: started.stepRunId,
    result: { ok: true, appliedCount: 0 },
    logger: quietLogger,
  });

  // Step 1 completed → step 2 must immediately be promoted (no intermediate durable stale state)
  assert.equal(completed.ok, true);
  assert.equal(prisma.state.steps[0].status, "completed");
  assert.ok(
    ["ready", "needs_merchant"].includes(prisma.state.steps[1].status),
    `step 2 must be promoted immediately after step 1 completes, got ${prisma.state.steps[1].status}`,
  );
  assert.notEqual(prisma.state.steps[1].status, "waiting", "step 2 must not remain waiting");
});

const quietLogger = {
  info() {},
  warn() {},
  error() {},
};

function buildPrisma() {
  const state = {
    action: {
      id: "a1",
      merchantId: MERCHANT,
      shopId: SHOP,
      status: "proposed",
      sourceRecommendationId: "rec-1",
      currentActionRunId: "run-1",
      createdAt: NOW,
      updatedAt: NOW,
    },
    recommendation: {
      id: "rec-1",
      merchantId: MERCHANT,
      shopId: SHOP,
      reviewStatus: "proposed",
      acceptedAt: null,
      workflows: [],
    },
    workflow: {
      id: "wf-1",
      recommendationId: "rec-1",
      merchantId: MERCHANT,
      shopId: SHOP,
      status: "draft",
      version: 1,
      steps: [],
    },
    steps: [
      step({ id: "step-1", orderIndex: 0, mode: "execute", capabilityRef: "execute:listing_copy:product" }),
      step({ id: "step-2", orderIndex: 1, mode: "merchant_action", dependsOnStepIds: ["step-1"] }),
    ],
    executions: [
      {
        id: "exec-1",
        runId: "run-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        recommendationStepId: "step-1",
        actionType: "listing_copy",
        status: "proposed",
        resolvedMode: "approve",
        updatedAt: NOW,
      },
    ],
    stepRuns: [],
    events: [],
    nextStepRun: 1,
  };
  state.workflow.steps = state.steps;
  state.recommendation.workflows = [state.workflow];

  const prisma = {
    state,
    async $transaction(fn) {
      return fn(prisma);
    },
    merchantAction: {
      findFirst: async ({ where }) => {
        if (
          state.action.id !== where.id &&
          state.action.sourceRecommendationId !== where.sourceRecommendationId
        ) {
          return null;
        }
        if (state.action.merchantId !== where.merchantId || state.action.shopId !== where.shopId) {
          return null;
        }
        return actionWithRelations(state);
      },
      updateMany: async ({ where, data }) => updateMatching(state.action, where, data),
    },
    merchantPlanRecommendation: {
      updateMany: async ({ where, data }) => updateMatching(state.recommendation, where, data),
    },
    merchantRecommendationWorkflow: {
      updateMany: async ({ where, data }) => updateMatching(state.workflow, where, data),
    },
    merchantRecommendationStep: {
      findMany: async ({ where }) =>
        state.steps
          .filter((row) => row.workflowId === where.workflowId && row.merchantId === where.merchantId && row.shopId === where.shopId)
          .sort((left, right) => left.orderIndex - right.orderIndex),
      findFirst: async ({ where }) =>
        state.steps.find((row) => row.id === where.id && row.merchantId === where.merchantId && row.shopId === where.shopId) ?? null,
      updateMany: async ({ where, data }) => {
        const rows = state.steps.filter((row) => matches(row, where));
        for (const row of rows) applyData(row, data);
        return { count: rows.length };
      },
    },
    merchantRecommendationStepRun: {
      create: async ({ data }) => {
        const duplicate = state.stepRuns.find(
          (run) => run.stepId === data.stepId && run.idempotencyKey === data.idempotencyKey,
        );
        if (duplicate) {
          const error = new Error("duplicate");
          error.code = "P2002";
          throw error;
        }
        const run = {
          id: `sr-${state.nextStepRun++}`,
          result: {},
          error: {},
          queuedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        state.stepRuns.push(run);
        return run;
      },
      findFirst: async ({ where }) => {
        const run = state.stepRuns.find((row) => matches(row, where));
        if (!run) return null;
        return {
          ...run,
          step: { ...state.steps.find((stepRow) => stepRow.id === run.stepId), workflow: state.workflow },
        };
      },
      updateMany: async ({ where, data }) => {
        const rows = state.stepRuns.filter((row) => matches(row, where));
        for (const row of rows) applyData(row, data);
        return { count: rows.length };
      },
      count: async ({ where }) => state.stepRuns.filter((row) => matches(row, where)).length,
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return data;
      },
    },
  };
  return prisma;
}

function actionWithRelations(state) {
  return {
    ...state.action,
    sourceRecommendation: {
      ...state.recommendation,
      workflows: [
        {
          ...state.workflow,
          steps: state.steps.map((row) => ({
            ...row,
            actionExecutions: state.executions.filter((execution) => execution.recommendationStepId === row.id),
          })),
        },
      ],
    },
    currentExecution: state.executions[0],
    executions: state.executions,
  };
}

function step(overrides) {
  return {
    workflowId: "wf-1",
    recommendationId: "rec-1",
    merchantId: MERCHANT,
    shopId: SHOP,
    title: "Step",
    description: "Do the work.",
    completionCriteria: null,
    status: "draft",
    dependsOnStepIds: [],
    evidenceIds: [],
    progress: {},
    attention: {},
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function updateMatching(row, where, data) {
  if (!matches(row, where)) return { count: 0 };
  applyData(row, data);
  return { count: 1 };
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "in" in expected) {
      return expected.in.includes(row[key]);
    }
    return row[key] === expected;
  });
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value;
  }
}
