import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_COMMAND,
  classifyActionCommand,
} from "../app/lib/actions/action-command.server.js";
import { handleFocusedActionMessage } from "../app/lib/actions/action-interpreter.server.js";
import {
  ACTION_STEP_STATUS,
  acceptMerchantActionPlan,
} from "../app/lib/actions/action-step-lifecycle.server.js";
import {
  advanceCurrentActionStep,
  isAdvanceStepCommand,
  parseGoBackCommand,
  resolveStepTarget,
} from "../app/lib/actions/action-workflow-navigation.server.js";
import { createOracleInterpreterProvider } from "./helpers/action-interpreter-oracle.mjs";

const MERCHANT = "m1";
const SHOP = "s1";
const ACTION_ID = "a-nav";
const quietLogger = { info() {}, warn() {}, error() {} };

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

function buildNavigationPrisma(initial = {}) {
  const state = {
    action: {
      id: ACTION_ID,
      merchantId: MERCHANT,
      shopId: SHOP,
      title: "Review At-Risk Inventory and Prepare Replenishment",
      summary: "Reorder at-risk wine lines.",
      status: initial.actionStatus ?? "accepted",
      sourceRecommendationId: "rec-1",
      plan: { coverDays: initial.coverDays ?? 120 },
      progress: {},
      outcome: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    constraints: initial.constraints ?? [],
    changeSets: [],
    stepRuns: [],
    steps: [
      stepRow({
        id: "step-1",
        orderIndex: 0,
        title: "Review low-cover inventory",
        capabilityRef: "assist:inventory_review",
        status: initial.step1Status ?? "ready",
      }),
      stepRow({
        id: "step-2",
        orderIndex: 1,
        title: "Build replenishment proposal",
        capabilityRef: "assist:replenishment_proposal",
        dependsOnStepIds: ["step-1"],
        status: initial.step2Status ?? "waiting",
      }),
      stepRow({
        id: "step-3",
        orderIndex: 2,
        title: "Draft supplier communication",
        capabilityRef: "assist:supplier_email_draft",
        dependsOnStepIds: ["step-2"],
        status: initial.step3Status ?? "waiting",
      }),
    ],
    beliefs: [
      {
        merchantId: MERCHANT,
        shopId: SHOP,
        key: "inventory.low_cover_products.trailing_30d",
        status: "active",
        value: {
          items: [
            { title: "Pear Skin Sipon", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
            { title: "Picnic Xinomavro", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
          ],
        },
        updatedAt: new Date(),
      },
    ],
    events: [],
  };

  const actionRow = () => ({
    ...state.action,
    sourceRecommendation: {
      id: "rec-1",
      title: state.action.title,
      workflows: [{ id: "wf-1", status: "active", version: 1, steps: state.steps }],
    },
    constraints: state.constraints.filter((row) => row.status === "active"),
    changeSets: [...state.changeSets],
    workflow: { id: "wf-1", steps: state.steps },
    displaySteps: state.steps,
    currentStep:
      state.steps.find((row) =>
        ["ready", "running", "needs_merchant", "needs_attention", "needs_updating"].includes(
          String(row.status),
        ),
      ) ?? state.steps[0],
  });

  const prisma = {
    state,
    $transaction: async (run) => run(prisma),
    merchantAction: {
      findFirst: async ({ where, select }) => {
        const row = actionRow();
        if (where.id && row.id !== where.id) return null;
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
      findMany: async () =>
        state.constraints.filter((row) => row.status === "active"),
      create: async ({ data }) => {
        const row = { id: `c-${state.constraints.length + 1}`, status: "active", ...data };
        state.constraints.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.constraints.filter((row) => !where.id || row.id === where.id);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    actionChangeSet: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const row = { id: `cs-${state.changeSets.length + 1}`, ...data };
        state.changeSets.push(row);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
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
    merchantPlanRecommendation: { updateMany: async () => ({ count: 1 }) },
    merchantRecommendationWorkflow: { updateMany: async () => ({ count: 1 }) },
    merchantRecommendationStep: {
      findMany: async () => [...state.steps],
      findFirst: async ({ where }) => state.steps.find((row) => row.id === where.id) ?? null,
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
        const row = { id: `sr-${state.stepRuns.length + 1}`, ...data };
        state.stepRuns.push(row);
        return row;
      },
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    merchantActionEvent: { create: async ({ data }) => data },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
  };
  return prisma;
}

async function runCommand(prisma, message, params = {}) {
  const handled = await handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    provider: createOracleInterpreterProvider(),
    logger: quietLogger,
  });
  if (handled.result) {
    return {
      ...handled.result,
      reply: handled.reply ?? handled.result.reply,
    };
  }
  return {
    ok: handled.ok,
    command: handled.command?.type,
    reply: handled.reply,
    reason: handled.command?.reason,
  };
}

function stepStatus(prisma, stepId) {
  return prisma.state.steps.find((row) => row.id === stepId)?.status;
}

test("demoted phrase matchers still exist as LLM-down aids, not the chat router", () => {
  assert.equal(isAdvanceStepCommand("Let's move on."), true);
  assert.equal(isAdvanceStepCommand("Carry on."), true);
  assert.equal(isAdvanceStepCommand("ok lets move to the next step"), true);
  assert.equal(
    classifyActionCommand("ok lets move to the next step").type,
    ACTION_COMMAND.ADVANCE_STEP,
  );
  assert.equal(classifyActionCommand("Let's move on.").type, ACTION_COMMAND.ADVANCE_STEP);
  assert.equal(classifyActionCommand("Go back.").type, ACTION_COMMAND.GO_BACK);
  assert.equal(classifyActionCommand("Go back two steps.").params.steps, 2);
  assert.equal(
    classifyActionCommand("Go back to the inventory review.").type,
    ACTION_COMMAND.GO_TO_STEP,
  );
  assert.equal(
    classifyActionCommand("Skip this — I'll message the supplier myself.").type,
    ACTION_COMMAND.SKIP_STEP,
  );
  assert.deepEqual(parseGoBackCommand("Go back again."), { steps: 1 });
});

test("TEST 2 advance on an unstarted ready step advises the merchant to start it", async () => {
  const prisma = buildNavigationPrisma();
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  await runCommand(prisma, "Use 60 days of cover.");
  const result = await runCommand(prisma, "ok lets move to the next step");
  assert.equal(result.command, ACTION_COMMAND.ADVANCE_STEP);
  assert.equal(result.reason, "step_not_started");
  assert.match(result.reply, /hasn't started yet/i);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.waiting);
});

test("TEST 2b leftover pending steps unlock then advise start instead of skipping", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "pending",
    step2Status: "pending",
    step3Status: "pending",
  });
  const result = await runCommand(prisma, "ok lets move to the next step");
  assert.equal(result.command, ACTION_COMMAND.ADVANCE_STEP);
  assert.equal(result.reason, "step_not_started");
  assert.match(result.reply, /hasn't started yet/i);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.waiting);
  assert.equal(stepStatus(prisma, "step-3"), ACTION_STEP_STATUS.waiting);
});

test("TEST 2c advance completes a merchant-owned current step and unlocks the next", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "needs_merchant",
    step2Status: "waiting",
    step3Status: "waiting",
  });
  prisma.state.steps[0].mode = "merchant_action";
  const result = await runCommand(prisma, "Let's move on.");
  assert.equal(result.command, ACTION_COMMAND.ADVANCE_STEP);
  assert.equal(result.ok, true);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.completed);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.ready);
  assert.equal(stepStatus(prisma, "step-3"), ACTION_STEP_STATUS.waiting);
});

test("TEST 4-5 go back moves focus without invalidating completed work", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "completed",
    step2Status: "completed",
    step3Status: "ready",
  });
  const backOne = await runCommand(prisma, "Go back.");
  assert.equal(backOne.command, ACTION_COMMAND.GO_BACK);
  assert.equal(backOne.ok, true);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.ready);
  assert.equal(stepStatus(prisma, "step-3"), ACTION_STEP_STATUS.waiting);

  const backAgain = await runCommand(prisma, "Go back again.");
  assert.equal(backAgain.ok, true);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);
});

test("TEST 6 plan revision on reopened step invalidates downstream", async () => {
  const prisma = buildNavigationPrisma({
    coverDays: 60,
    step1Status: "ready",
    step2Status: "completed",
    step3Status: "waiting",
  });
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  const revised = await runCommand(prisma, "Use 90 days instead.");
  assert.equal(revised.command, ACTION_COMMAND.REVISE_PLAN);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.needsUpdating);
});

test("TEST 9 go back two steps from step 3 lands on step 1", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "completed",
    step2Status: "completed",
    step3Status: "ready",
  });
  const result = await runCommand(prisma, "Go back two steps.");
  assert.equal(result.command, ACTION_COMMAND.GO_BACK);
  assert.equal(result.ok, true);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.completed);
});

test("TEST 11 jump forward explains prerequisite rebuild", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "ready",
    step2Status: "needs_updating",
    step3Status: "waiting",
  });
  const result = await runCommand(prisma, "Go straight to the supplier message.");
  assert.equal(result.command, ACTION_COMMAND.GO_TO_STEP);
  assert.equal(result.ok, false);
  assert.match(result.reply, /rebuild|proposal|first/i);
});

test("TEST 14 ambiguous back navigation asks a targeted question", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "completed",
    step2Status: "completed",
    step3Status: "ready",
  });
  const result = await runCommand(prisma, "Go back to the quantities.");
  assert.equal(result.command, ACTION_COMMAND.NEEDS_CLARIFICATION);
  assert.match(result.reply, /calculated|proposal/i);
  assert.equal(prisma.state.action.progress?.pendingNavigation?.candidates?.length, 2);
});

test("TEST 15 clarification resolution navigates to calculation step", async () => {
  const prisma = buildNavigationPrisma({
    step1Status: "completed",
    step2Status: "completed",
    step3Status: "ready",
  });
  await runCommand(prisma, "Go back to the quantities.");
  const resolved = await runCommand(prisma, "I mean how they're calculated.");
  assert.equal(resolved.command, ACTION_COMMAND.GO_TO_STEP);
  assert.equal(resolved.ok, true);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);
});

test("semantic step resolution finds inventory and supplier steps", () => {
  const steps = [
    stepRow({ id: "step-1", orderIndex: 0, title: "Review low-cover inventory" }),
    stepRow({ id: "step-2", orderIndex: 1, title: "Build replenishment proposal" }),
    stepRow({ id: "step-3", orderIndex: 2, title: "Draft supplier communication" }),
  ];
  assert.equal(resolveStepTarget(steps, "inventory review")?.id, "step-1");
  assert.equal(resolveStepTarget(steps, "supplier message")?.id, "step-3");
  assert.equal(resolveStepTarget(steps, "proposal")?.id, "step-2");
});

test("end-to-end forward back revise skip scenario", async () => {
  const prisma = buildNavigationPrisma();
  await runCommand(prisma, "Only replenish Pear Skin Sipon.");
  await runCommand(prisma, "Use 60 days.");
  await acceptMerchantActionPlan(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  const advised = await runCommand(prisma, "Let's move on.");
  assert.match(advised.reply, /hasn't started yet/i);
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);

  prisma.state.steps[0].mode = "merchant_action";
  prisma.state.steps[0].status = ACTION_STEP_STATUS.needsMerchant;
  await runCommand(prisma, "Let's move on.");
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.completed);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.ready);

  prisma.state.steps[1].mode = "merchant_action";
  prisma.state.steps[1].status = ACTION_STEP_STATUS.needsMerchant;
  await advanceCurrentActionStep(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.completed);
  assert.equal(stepStatus(prisma, "step-3"), ACTION_STEP_STATUS.ready);

  prisma.state.steps[0].mode = "assist";
  prisma.state.steps[1].mode = "assist";
  prisma.state.steps[2].mode = "assist";
  await runCommand(prisma, "Go back two steps.");
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.ready);

  await runCommand(prisma, "Actually use 90 days.");
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.needsUpdating);

  const jump = await runCommand(prisma, "Go straight to the supplier message.");
  assert.match(jump.reply, /rebuild|proposal|first/i);

  prisma.state.steps[0].mode = "merchant_action";
  prisma.state.steps[0].status = ACTION_STEP_STATUS.needsMerchant;
  await runCommand(prisma, "Carry on.");
  assert.equal(stepStatus(prisma, "step-1"), ACTION_STEP_STATUS.completed);
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.ready);

  prisma.state.steps[1].mode = "merchant_action";
  prisma.state.steps[1].status = ACTION_STEP_STATUS.needsMerchant;
  await runCommand(prisma, "Let's move on.");
  assert.equal(stepStatus(prisma, "step-2"), ACTION_STEP_STATUS.completed);
  assert.equal(stepStatus(prisma, "step-3"), ACTION_STEP_STATUS.ready);

  const skip = await runCommand(prisma, "Skip this — I'll message the supplier myself.");
  assert.equal(skip.command, ACTION_COMMAND.SKIP_STEP);
  assert.equal(stepStatus(prisma, "step-3"), ACTION_STEP_STATUS.skipped);
});
