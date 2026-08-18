import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptMerchantActionPlan,
  advanceActionWorkflow,
  completeActionStepRun,
  completeCurrentActionStep,
  skipCurrentActionStep,
  startActionStep,
  stopActionStep,
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
