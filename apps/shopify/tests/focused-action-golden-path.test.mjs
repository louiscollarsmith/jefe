import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_COMMAND,
  executeActionCommand,
  isExplicitGeneralStoreQuestion,
} from "../app/lib/actions/action-command.server.js";
import { handleFocusedActionMessage } from "../app/lib/actions/action-interpreter.server.js";
import {
  expandScopeModificationToConstraints,
  parseScopeModificationFromMessage,
} from "../app/lib/actions/action-constraint.server.js";
import { recommendedPurchaseUnits } from "../app/lib/actions/action-capability.server.js";
import {
  acceptMerchantActionPlan,
} from "../app/lib/actions/action-step-lifecycle.server.js";
import { assertRunMatchesResolvedContext } from "../app/lib/actions/resolved-action-context.server.js";
import { createOracleActionProvider } from "./helpers/action-agent-oracle.mjs";

const MERCHANT = "m1";
const SHOP = "s1";
const ACTION_ID = "a-restock";
const quietLogger = { info() {}, warn() {}, error() {} };

const FIXTURE_PRODUCTS = [
  { title: "Pear Skin Sipon", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
  { title: "Picnic Xinomavro", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
];

function unitsForCover(coverDays) {
  return recommendedPurchaseUnits(
    { available: 0, dailyVelocity: 0.1 },
    coverDays,
  );
}

function buildGoldenPathPrisma() {
  const state = {
    action: {
      id: ACTION_ID,
      merchantId: MERCHANT,
      shopId: SHOP,
      title: "Review At-Risk Inventory and Prepare Replenishment",
      summary: "Reorder at-risk wine lines from the supplier.",
      status: "proposed",
      sourceRecommendationId: "rec-1",
      currentActionRunId: null,
      plan: { coverDays: 120 },
      progress: { preview: { changes: [] } },
      outcome: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    execution: null,
    constraints: [],
    changeSets: [],
    beliefs: [
      {
        merchantId: MERCHANT,
        shopId: SHOP,
        key: "inventory.low_cover_products.trailing_30d",
        status: "active",
        value: { items: FIXTURE_PRODUCTS.map((item) => ({ ...item })) },
        updatedAt: new Date(),
      },
    ],
    events: [],
    steps: [
      stepRow({
        id: "step-1",
        orderIndex: 0,
        title: "Review low-cover inventory",
        capabilityRef: "assist:inventory_review",
        status: "pending",
      }),
      stepRow({
        id: "step-2",
        orderIndex: 1,
        title: "Build replenishment proposal",
        capabilityRef: "assist:replenishment_proposal",
        dependsOnStepIds: ["step-1"],
        status: "waiting",
      }),
      stepRow({
        id: "step-3",
        orderIndex: 2,
        title: "Draft supplier communication",
        capabilityRef: "assist:supplier_email_draft",
        dependsOnStepIds: ["step-2"],
        status: "waiting",
      }),
    ],
    stepRuns: [],
  };

  const actionRow = () => ({
    ...state.action,
    sourceRecommendation: {
      id: "rec-1",
      title: state.action.title,
      summary: state.action.summary,
      reviewStatus: state.action.status,
      workflows: [{ id: "wf-1", status: "draft", version: 1, steps: state.steps }],
    },
    currentExecution: state.execution,
    executions: state.execution ? [state.execution] : [],
    constraints: state.constraints.filter((row) => row.status === "active"),
    changeSets: [...state.changeSets],
    workflow: { steps: state.steps },
    displaySteps: state.steps,
    currentStep: state.steps.find((row) =>
      ["ready", "running", "needs_merchant"].includes(String(row.status)),
    ) ?? state.steps[0],
  });

  const prisma = {
    state,
    $transaction: async (run) => run(prisma),
    merchantAction: {
      findFirst: async ({ where, select }) => {
        const row = actionRow();
        if (where.id && row.id !== where.id) return null;
        if (
          where.sourceRecommendationId &&
          row.sourceRecommendationId !== where.sourceRecommendationId
        ) {
          return null;
        }
        if (select) {
          /** @type {Record<string, any>} */
          const picked = {};
          for (const key of Object.keys(select)) {
            if (select[key]) picked[key] = row[key];
          }
          return picked;
        }
        return row;
      },
      update: async ({ data }) => {
        Object.assign(state.action, data);
        return state.action;
      },
      updateMany: async ({ data }) => {
        Object.assign(state.action, data);
        return { count: 1 };
      },
    },
    merchantActionConstraint: {
      findMany: async ({ where }) =>
        state.constraints.filter(
          (row) =>
            row.merchantActionId === where.merchantActionId &&
            row.status === where.status,
        ),
      create: async ({ data }) => {
        const row = {
          id: `c-${state.constraints.length + 1}`,
          status: "active",
          createdAt: new Date(),
          ...data,
        };
        state.constraints.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.constraints.filter((row) => {
          if (where.merchantActionId && row.merchantActionId !== where.merchantActionId) {
            return false;
          }
          if (where.status && row.status !== where.status) return false;
          if (where.id && row.id !== where.id) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    actionChangeSet: {
      findFirst: async ({ where }) => {
        const statuses = where.status?.in ?? (where.status ? [where.status] : null);
        return (
          [...state.changeSets]
            .reverse()
            .find(
              (row) =>
                row.merchantActionId === where.merchantActionId &&
                (!statuses || statuses.includes(row.status)),
            ) ?? null
        );
      },
      create: async ({ data }) => {
        const row = {
          id: `cs-${state.changeSets.length + 1}`,
          generatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.changeSets.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.changeSets.filter(
          (row) => row.merchantActionId === where.merchantActionId,
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      update: async ({ where, data }) => {
        const row = state.changeSets.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    merchantMemoryBelief: {
      findFirst: async ({ where }) =>
        state.beliefs.find(
          (row) =>
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId &&
            row.key === where.key,
        ) ?? null,
    },
    merchantPlanRecommendation: {
      updateMany: async ({ data }) => {
        Object.assign(state.action, { status: data.reviewStatus ?? state.action.status });
        return { count: 1 };
      },
    },
    merchantRecommendationWorkflow: {
      updateMany: async () => ({ count: 1 }),
    },
    merchantRecommendationStep: {
      findMany: async () => [...state.steps],
      findFirst: async ({ where }) =>
        state.steps.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        const rows = state.steps.filter((row) => {
          if (where.id && row.id !== where.id) return false;
          if (where.status && row.status !== where.status) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantRecommendationStepRun: {
      create: async ({ data }) => {
        const row = {
          id: `sr-${state.stepRuns.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.stepRuns.push(row);
        return row;
      },
      findFirst: async ({ where, include }) => {
        const row =
          state.stepRuns.find((item) => {
            if (where.id && item.id !== where.id) return false;
            if (where.idempotencyKey && item.idempotencyKey !== where.idempotencyKey) {
              return false;
            }
            if (where.status?.in && !where.status.in.includes(item.status)) return false;
            return true;
          }) ?? null;
        if (!row) return null;
        const step = state.steps.find((item) => item.id === row.stepId) ?? null;
        if (!include?.step) return row;
        const stepWithRelations = {
          ...step,
          recommendationId: step?.recommendationId ?? "rec-1",
          workflowId: step?.workflowId ?? "wf-1",
          workflow: { id: "wf-1", steps: state.steps },
        };
        return { ...row, step: stepWithRelations };
      },
      updateMany: async ({ where, data }) => {
        const rows = state.stepRuns.filter((row) => !where.id || row.id === where.id);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantActionEvent: { create: async ({ data }) => data },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
  };
  return prisma;
}

function stepRow(overrides) {
  return {
    workflowId: "wf-1",
    recommendationId: "rec-1",
    merchantId: MERCHANT,
    shopId: SHOP,
    mode: "assist",
    progress: {},
    attention: {},
    dependsOnStepIds: [],
    ...overrides,
  };
}

async function runCommand(prisma, message) {
  const handled = await handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    provider: createOracleActionProvider(),
    logger: quietLogger,
  });
  const payload = handled.result ?? null;
  const command =
    payload?.command ??
    payload?.result?.command ??
    handled.command?.type ??
    null;
  if (payload) {
    const inner = payload.result?.result ?? payload.result ?? payload;
    return {
      ...payload,
      command,
      reply: handled.reply ?? payload.reply,
      result: inner,
    };
  }
  return {
    ok: handled.ok,
    command,
    reply: handled.reply,
    reason: handled.command?.reason,
  };
}

test("golden path fixture quantities are deterministic", () => {
  assert.equal(unitsForCover(120), 12);
  assert.equal(unitsForCover(90), 9);
  assert.equal(unitsForCover(60), 6);
});

test("TEST 1 inspect proposal uses action state not generic store commentary", async () => {
  const prisma = buildGoldenPathPrisma();
  const result = await runCommand(prisma, "Show me what you're proposing right now.");
  assert.equal(result.command, ACTION_COMMAND.INSPECT_PROPOSAL);
  assert.match(result.reply, /Pear Skin Sipon/);
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /12|order 12/i);
  assert.doesNotMatch(result.reply, /You sell \d+ products/i);
});

test("TEST 2 only replenish Pear Skin Sipon persists Picnic exclusion", async () => {
  const prisma = buildGoldenPathPrisma();
  const result = await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  assert.equal(result.command, ACTION_COMMAND.ADD_CONSTRAINT);
  assert.match(result.reply, /Pear Skin Sipon/i);
  assert.match(result.reply, /Picnic Xinomavro/i);
  assert.doesNotMatch(result.reply, /three steps|The plan:/i);
  assert.equal(
    prisma.state.constraints.some((row) => /Picnic Xinomavro/i.test(row.label)),
    true,
  );
});

test("TEST 3-6 scope revision and combined state", async () => {
  const prisma = buildGoldenPathPrisma();
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  let inspect = await runCommand(prisma, "What are you proposing now?");
  assert.match(inspect.reply, /Pear Skin Sipon/);
  assert.match(inspect.reply, /12|order 12/i);
  assert.doesNotMatch(inspect.reply, /Picnic Xinomavro — on hand/i);

  const excluded = await runCommand(prisma, "What have I excluded?");
  assert.match(excluded.reply, /Picnic Xinomavro/i);

  const revised = await runCommand(prisma, "Use 90 days of cover instead of 120.");
  assert.equal(revised.command, ACTION_COMMAND.REVISE_PLAN);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.match(revised.reply, /90/i);

  inspect = await runCommand(prisma, "What are we replenishing now?");
  assert.match(inspect.reply, /Pear Skin Sipon/);
  assert.match(inspect.reply, /9|order 9/i);
  assert.doesNotMatch(inspect.reply, /Picnic Xinomavro — on hand/i);
});

test("TEST 8 general store question bypasses focused routing classifier", () => {
  assert.equal(isExplicitGeneralStoreQuestion("How many products do I sell overall?"), true);
  assert.equal(isExplicitGeneralStoreQuestion("What are we replenishing now?"), false);
});

test("TEST 10-13 accept plan and start step 1 with resolved 90-day Pear-only state", async () => {
  const prisma = buildGoldenPathPrisma();
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  await runCommand(prisma, "Use 90 days of cover instead of 120.");
  const accepted = await runCommand(prisma, "Looks good, let's do it.");
  assert.equal(accepted.command, ACTION_COMMAND.ACCEPT_PLAN);
  assert.equal(prisma.state.action.status, "accepted");
  assert.equal(prisma.state.action.plan.coverDays, 90);

  const recap = await runCommand(prisma, "Before you start, remind me exactly what we're doing.");
  assert.match(recap.reply, /Pear Skin Sipon|90|9/i);

  const started = await runCommand(prisma, "Go ahead.");
  assert.equal(started.command, ACTION_COMMAND.START_STEP);
  assert.equal(started.ok, true);
  const snapshot = prisma.state.stepRuns[0]?.inputSnapshot;
  assert.equal(snapshot.plan.coverDays, 90);
  assert.deepEqual(
    snapshot.scope.map((item) => item.title),
    ["Pear Skin Sipon"],
  );
  assertRunMatchesResolvedContext(snapshot, started.result.resolvedContext);
  assert.match(started.reply, /Pear Skin Sipon/);
  assert.match(started.reply, /9 units|9-unit|reordering 9/i);
  assert.doesNotMatch(started.reply, /Picnic Xinomavro —/i);
  assert.doesNotMatch(started.reply, /120-day|120 days/i);
  assert.doesNotMatch(started.reply, /12 units/i);
});

test("REGRESSION A constraint synonyms expand to Pear-only scope", () => {
  const candidates = FIXTURE_PRODUCTS;
  for (const message of [
    "Only replenish Pear Skin Sipon.",
    "Just do Pear Skin Sipon.",
    "Don't include Picnic Xinomavro.",
    "Leave Picnic Xinomavro out.",
    "Skip Picnic Xinomavro.",
    "Ignore Picnic Xinomavro for this one.",
  ]) {
    const mod = parseScopeModificationFromMessage(message);
    assert.ok(mod, message);
    const constraints = expandScopeModificationToConstraints(mod, candidates);
    assert.equal(constraints.length, 1, message);
    assert.match(constraints[0].label, /Picnic Xinomavro/i, message);
  }
});

test("REGRESSION F acceptance preserves Pear-only 90-day state", async () => {
  const prisma = buildGoldenPathPrisma();
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  await runCommand(prisma, "Use 90 days of cover instead of 120.");
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  const inspect = await runCommand(prisma, "What are you proposing now?");
  assert.match(inspect.reply, /Pear Skin Sipon/);
  assert.match(inspect.reply, /9|order 9/i);
  assert.doesNotMatch(inspect.reply, /Picnic Xinomavro — on hand/i);
});

test("REGRESSION D 60-day revision invalidates 90-day proposal", async () => {
  const prisma = buildGoldenPathPrisma();
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  await runCommand(prisma, "Use 90 days of cover instead of 120.");
  await runCommand(prisma, "Actually use 60 days.");
  assert.equal(prisma.state.action.plan.coverDays, 60);
  const inspect = await runCommand(prisma, "What's the proposal now?");
  assert.match(inspect.reply, /6|order 6/i);
  assert.doesNotMatch(inspect.reply, /order 9\b/i);
});

test("TEST 28 completed action rejects scope mutation", async () => {
  const prisma = buildGoldenPathPrisma();
  prisma.state.action.status = "completed";
  for (const step of prisma.state.steps) step.status = "completed";
  const result = await runCommand(prisma, "Actually include Picnic Xinomavro again.");
  assert.equal(result.ok, false);
  assert.match(result.reply, /complete/i);
});

test("Golden conversation 1: natural replenishment talk without canned phrases", async () => {
  const prisma = buildGoldenPathPrisma();
  prisma.state.action.status = "accepted";
  prisma.state.steps[0].status = "ready";

  const first = await runCommand(
    prisma,
    "120 feels like too much. Just replenish Pear, use 60 days instead, then let's move on.",
  );
  assert.equal(prisma.state.action.plan.coverDays, 60);
  assert.equal(
    prisma.state.constraints.some((row) => /Picnic Xinomavro/i.test(row.label) && row.status === "active"),
    true,
  );
  assert.match(first.reply, /hasn't started yet|start it|Review proposals/i);
  assert.equal(
    prisma.state.steps.find((row) => row.id === "step-1")?.status,
    "ready",
  );
  assert.notEqual(
    prisma.state.steps.find((row) => row.id === "step-1")?.status,
    "completed",
  );

  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "ready";

  const simulate = await runCommand(
    prisma,
    "Actually before you build it, what would 90 days look like?",
  );
  assert.match(simulate.reply, /Pear Skin Sipon/);
  assert.match(simulate.reply, /\b9\b/);
  assert.equal(prisma.state.action.plan.coverDays, 60);

  const revise = await runCommand(prisma, "Yeah, 90 is better. Use that.");
  assert.equal(revise.command, ACTION_COMMAND.REVISE_PLAN);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  const build = await runCommand(prisma, "Go ahead and build it.");
  assert.equal(build.ok, true);
  assert.match(build.reply, /Pear Skin Sipon/);
  assert.match(build.reply, /9 units|9-unit|reordering 9/i);
  assert.doesNotMatch(build.reply, /Picnic Xinomavro —/i);

  await runCommand(
    prisma,
    "Go back to where we chose which products, add Picnic back, and then rebuild this.",
  );
  assert.equal(
    prisma.state.constraints.some((row) => /Picnic Xinomavro/i.test(row.label) && row.status === "active"),
    false,
  );
  const inspect = await runCommand(prisma, "What are you proposing now?");
  assert.match(inspect.reply, /Pear Skin Sipon/);
  assert.match(inspect.reply, /Picnic Xinomavro/);
  assert.match(inspect.reply, /9|order 9/i);
});

// ---------------------------------------------------------------------------
// FAILURE 3 — Focused factual questions answered from structured state
// ---------------------------------------------------------------------------

test("FAILURE 3: cover period question answers from plan, not recap", async () => {
  const prisma = buildGoldenPathPrisma();
  // Simulate state after Step 1 completed: Pear=12, Picnic=12, 120d
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[0].progress = {
    artifactType: "inventory_review",
    items: [
      { title: "Pear Skin Sipon", recommended: 12 },
      { title: "Picnic Xinomavro", recommended: 12 },
    ],
  };
  prisma.state.steps[1].status = "ready";

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ANSWER,
    params: {},
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "what replenishment window is that, how many days cover?",
    logger: quietLogger,
  });

  assert.equal(result.command, ACTION_COMMAND.ANSWER);
  assert.match(result.reply, /120/);
  assert.doesNotMatch(result.reply, /The plan:|three steps|step 1|step 2|Step 1|Step 2/i);
});

test("FAILURE 3: cover period question via interpreter oracle does not fall back to recap", async () => {
  const prisma = buildGoldenPathPrisma();
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "ready";

  const result = await runCommand(prisma, "what replenishment window is that, how many days cover?");

  assert.match(result.reply, /120/);
  assert.doesNotMatch(result.reply, /The plan:|three steps|Step 1.*done.*Step 2.*waiting/i);
});

test("FAILURE 3: why question returns plan parameters, not generic recap", async () => {
  const prisma = buildGoldenPathPrisma();
  const result = await runCommand(prisma, "Why is Pear 12 units?");

  assert.match(result.reply, /120/);
  assert.doesNotMatch(result.reply, /The plan:|three steps/i);
});

test("FAILURE 3: 60-day revised plan answers with correct cover days", async () => {
  const prisma = buildGoldenPathPrisma();
  await runCommand(prisma, "Use 60 days of cover instead of 120.");

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ANSWER,
    params: {},
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "how many days cover is that?",
    logger: quietLogger,
  });

  assert.match(result.reply, /60/);
  assert.doesNotMatch(result.reply, /120/);
});

// ---------------------------------------------------------------------------
// END-TO-END 3-STEP GOLDEN PATH SCENARIO
// ---------------------------------------------------------------------------

test("END-TO-END golden path: accept → step 1 → step 2 → step 3 completes action", async () => {
  const prisma = buildGoldenPathPrisma();

  // Accept the plan
  const accepted = await runCommand(prisma, "Looks good, let's do it.");
  assert.equal(accepted.command, ACTION_COMMAND.ACCEPT_PLAN);
  assert.equal(prisma.state.action.status, "accepted");
  assert.equal(prisma.state.steps[0].status, "ready");
  assert.equal(prisma.state.steps[1].status, "waiting");
  assert.equal(prisma.state.steps[2].status, "waiting");

  // Start step 1
  const step1Started = await runCommand(prisma, "Go ahead.");
  assert.equal(step1Started.ok, true);
  assert.equal(step1Started.command, ACTION_COMMAND.START_STEP);
  // After assist step execution, step 1 should be completed and step 2 ready
  assert.equal(prisma.state.steps[0].status, "completed");
  assert.equal(prisma.state.steps[1].status, "ready", "step 2 must be ready after step 1 completes");
  assert.equal(prisma.state.steps[2].status, "waiting");
  assert.match(step1Started.reply, /Pear Skin Sipon/);

  // Ask about the result (FAILURE 3 scenario)
  const coverQ = await runCommand(prisma, "what replenishment window is that, how many days cover?");
  assert.match(coverQ.reply, /120/);
  assert.doesNotMatch(coverQ.reply, /The plan:|three steps/i);

  // Start step 2 (should work now that step 1 is done and step 2 is ready)
  const step2Started = await runCommand(prisma, "Go ahead.");
  assert.equal(step2Started.ok, true);
  assert.equal(step2Started.command, ACTION_COMMAND.START_STEP);
  assert.equal(prisma.state.steps[1].status, "completed", "step 2 must complete");
  assert.equal(prisma.state.steps[2].status, "ready", "step 3 must be ready after step 2");

  // Inspect current proposal
  const proposalQ = await runCommand(prisma, "What's the proposal now?");
  assert.match(proposalQ.reply, /Pear Skin Sipon|Picnic Xinomavro|12/i);
  assert.doesNotMatch(proposalQ.reply, /hasn.t been built yet/i);

  // Start step 3
  const step3Started = await runCommand(prisma, "Go ahead.");
  assert.equal(step3Started.ok, true);
  assert.equal(step3Started.command, ACTION_COMMAND.START_STEP);
  assert.equal(prisma.state.steps[2].status, "completed", "step 3 must complete");
  assert.equal(prisma.state.action.status, "completed", "action must be completed after all steps done");
});

test("END-TO-END: stale waiting state is healed when merchant says Go ahead", async () => {
  const prisma = buildGoldenPathPrisma();
  // Impossible persisted state: step 1 done, step 2 still waiting
  prisma.state.action.status = "in_progress";
  prisma.state.steps[0].status = "completed";
  prisma.state.steps[1].status = "waiting"; // should be ready

  // START_STEP on step 2 via chat should reconcile first
  const result = await runCommand(prisma, "Go ahead.");
  assert.equal(result.ok, true, `expected ok start, got: ${result.reason} — ${result.reply}`);
  assert.equal(result.command, ACTION_COMMAND.START_STEP);
  assert.equal(prisma.state.steps[1].status, "completed");
});

test("END-TO-END revised plan: Pear-only 60d propagates through all steps", async () => {
  const prisma = buildGoldenPathPrisma();

  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  await runCommand(prisma, "Use 60 days of cover instead of 120.");
  await runCommand(prisma, "Looks good, let's do it.");

  assert.equal(prisma.state.action.plan.coverDays, 60);
  assert.ok(
    prisma.state.constraints.some((row) => /Picnic Xinomavro/i.test(row.label) && row.status === "active"),
  );

  // Step 1
  const s1 = await runCommand(prisma, "Go ahead.");
  assert.equal(s1.ok, true);
  assert.equal(prisma.state.steps[0].status, "completed");
  // Snapshot must reflect Pear-only, 60d
  const snapshot = prisma.state.stepRuns[0]?.inputSnapshot;
  assert.equal(snapshot?.plan?.coverDays, 60);
  assert.ok(
    snapshot?.scope?.every((item) => /Pear/i.test(item.title ?? "")),
    "scope snapshot must be Pear-only",
  );
  assert.doesNotMatch(s1.reply, /Picnic Xinomavro.*suggest reorder|suggest reorder.*Picnic Xinomavro/i);
  assert.doesNotMatch(s1.reply, /120|12 units/i);
  assert.match(s1.reply, /6 units|reordering 6|6-unit/i);

  // Step 2
  assert.equal(prisma.state.steps[1].status, "ready");
  const s2 = await runCommand(prisma, "Go ahead.");
  assert.equal(s2.ok, true);
  assert.equal(prisma.state.steps[1].status, "completed");
  assert.equal(prisma.state.steps[2].status, "ready");

  // Step 3
  const s3 = await runCommand(prisma, "Go ahead.");
  assert.equal(s3.ok, true);
  assert.equal(prisma.state.steps[2].status, "completed");
  assert.equal(prisma.state.action.status, "completed");
});
