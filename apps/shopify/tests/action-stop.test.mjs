import assert from "node:assert/strict";
import test from "node:test";

import { stopMerchantAction } from "../app/lib/actions/action-command.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const NOW = new Date("2026-08-26T12:00:00.000Z");
const quietLogger = { info() {}, warn() {}, error() {} };

test("stopMerchantAction (agentic runtime): sets a cooperative-cancellation flag, does not flip status itself", async () => {
  const prisma = buildAgenticPrisma();

  const result = await stopMerchantAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  // The running mutation loop honors the flag between turns and marks
  // "stopped" itself — the command only requests cancellation.
  assert.equal(prisma.state.action.status, "in_progress");
  assert.equal(prisma.state.action.progress.agentic.cancellationRequested, true);
  assert.ok(prisma.state.action.progress.agentic.cancellationRequestedAt);
  assert.equal(prisma.state.events.length, 1);
  assert.equal(prisma.state.events[0].eventType, "action_execution_stopped");
});

test("stopMerchantAction (legacy runtime): stops the running step and marks the action stopped immediately", async () => {
  const prisma = buildLegacyPrisma();

  const result = await stopMerchantAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    actor: MERCHANT,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  // stopActionStep's cancellation is synchronous, so the whole action can be
  // marked stopped right away — no async worker needs to honor anything.
  assert.equal(prisma.state.action.status, "stopped");
  assert.equal(prisma.state.steps[0].status, "ready");
  assert.equal(prisma.state.stepRuns[0].status, "cancelled");
  assert.equal(prisma.state.events.some((e) => e.eventType === "action_execution_stopped"), true);
});

test("stopMerchantAction: not_found is reported without throwing", async () => {
  const prisma = buildAgenticPrisma();
  const result = await stopMerchantAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "missing",
    logger: quietLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
});

function buildAgenticPrisma() {
  const state = {
    action: {
      id: "a1",
      merchantId: MERCHANT,
      shopId: SHOP,
      status: "in_progress",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "executing" },
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    events: [],
  };
  return {
    state,
    merchantAction: {
      findFirst: async ({ where }) =>
        state.action.id === where.id && state.action.merchantId === where.merchantId && state.action.shopId === where.shopId
          ? state.action
          : null,
      updateMany: async ({ where, data }) => {
        if (state.action.id !== where.id) return { count: 0 };
        Object.assign(state.action, data);
        return { count: 1 };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return data;
      },
    },
  };
}

function buildLegacyPrisma() {
  const state = {
    action: {
      id: "a1",
      merchantId: MERCHANT,
      shopId: SHOP,
      status: "in_progress",
      progress: {},
      createdAt: NOW,
      updatedAt: NOW,
    },
    recommendation: { id: "rec-1", merchantId: MERCHANT, shopId: SHOP, reviewStatus: "accepted", workflows: [] },
    workflow: { id: "wf-1", recommendationId: "rec-1", merchantId: MERCHANT, shopId: SHOP, status: "active", version: 1, steps: [] },
    steps: [
      {
        id: "step-1",
        workflowId: "wf-1",
        recommendationId: "rec-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        orderIndex: 0,
        title: "Do the thing",
        description: "",
        status: "running",
        mode: "execute",
        capabilityRef: "execute:listing_copy:product",
        dependsOnStepIds: [],
        evidenceIds: [],
        progress: {},
        attention: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    stepRuns: [
      {
        id: "sr-1",
        stepId: "step-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        actor: MERCHANT,
        status: "running",
        idempotencyKey: "k1",
        inputSnapshot: {},
        result: {},
        error: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    events: [],
  };
  state.workflow.steps = state.steps;
  state.recommendation.workflows = [state.workflow];

  return {
    state,
    async $transaction(fn) {
      return fn(this);
    },
    merchantAction: {
      findFirst: async ({ where }) =>
        state.action.id === where.id && state.action.merchantId === where.merchantId && state.action.shopId === where.shopId
          ? { ...state.action, sourceRecommendation: state.recommendation }
          : null,
      updateMany: async ({ where, data }) => {
        if (state.action.id !== where.id) return { count: 0 };
        Object.assign(state.action, data);
        return { count: 1 };
      },
    },
    merchantRecommendationStep: {
      findMany: async ({ where }) =>
        state.steps.filter((row) => row.workflowId === where.workflowId).sort((a, b) => a.orderIndex - b.orderIndex),
      findFirst: async ({ where }) => state.steps.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        const rows = state.steps.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantRecommendationStepRun: {
      findFirst: async ({ where }) => {
        const run = state.stepRuns.find((row) => matches(row, where));
        return run ? { ...run, step: { ...state.steps.find((s) => s.id === run.stepId), workflow: state.workflow } } : null;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.stepRuns.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
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
}

function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
}
