import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMerchantActionStatus,
  ensureMerchantActionForExecution,
  ensureMerchantActionForRecommendation,
  getMerchantActionFocus,
  listMerchantActions,
  updateMerchantActionForExecution,
  updateMerchantActionForRecommendation,
} from "../app/lib/actions/merchant-action.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const NOW = new Date("2026-08-13T10:00:00.000Z");

test("deriveMerchantActionStatus keeps the new lifecycle separate from source statuses", () => {
  assert.equal(deriveMerchantActionStatus({}), "proposed");
  assert.equal(
    deriveMerchantActionStatus({
      recommendation: { reviewStatus: "accepted" },
    }),
    "accepted",
  );
  assert.equal(
    deriveMerchantActionStatus({
      recommendation: { reviewStatus: "deferred" },
    }),
    "deferred",
  );
  assert.equal(
    deriveMerchantActionStatus({
      recommendation: { reviewStatus: "rejected" },
    }),
    "declined",
  );
  assert.equal(
    deriveMerchantActionStatus({
      recommendation: { reviewStatus: "superseded" },
    }),
    "superseded",
  );
  assert.equal(
    deriveMerchantActionStatus({ execution: { status: "approved" } }),
    "in_progress",
  );
  assert.equal(
    deriveMerchantActionStatus({
      execution: { status: "applied", outcomeStatus: "measured" },
    }),
    "completed",
  );
});

test("deriveMerchantActionStatus does not surface completed when workflow steps remain", () => {
  assert.equal(
    deriveMerchantActionStatus({
      action: { status: "completed" },
      recommendation: {
        reviewStatus: "accepted",
        workflows: [
          {
            steps: [
              { status: "completed" },
              { status: "waiting", mode: "assist" },
              { status: "waiting", mode: "merchant_action" },
            ],
          },
        ],
      },
    }),
    "in_progress",
  );
});

test("ensureMerchantActionForExecution upserts by source recommendation and links the execution", async () => {
  const calls = [];
  const prisma = {
    merchantAction: {
      upsert: async (args) => {
        calls.push(["upsert", args]);
        return { id: "ma-1" };
      },
    },
    actionExecution: {
      updateMany: async (args) => {
        calls.push(["updateMany", args]);
        return { count: 1 };
      },
    },
  };

  const action = await ensureMerchantActionForExecution(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionRunId: "run-1",
    sourceRecommendation: recommendationFixture(),
    execution: {
      runId: "run-1",
      actionType: "price_markdown",
      status: "proposed",
      resolvedMode: "approve",
    },
  });

  assert.deepEqual(action, { id: "ma-1" });
  assert.equal(calls[0][0], "upsert");
  assert.deepEqual(calls[0][1].where, { sourceRecommendationId: "rec-1" });
  assert.equal(calls[0][1].create.currentActionRunId, "run-1");
  assert.equal(calls[1][0], "updateMany");
  assert.deepEqual(calls[1][1].data, { merchantActionId: "ma-1" });
});

test("recommendation creation populates MerchantAction without a read-time repair", async () => {
  let upsert = null;
  const prisma = {
    merchantAction: {
      upsert: async (args) => {
        upsert = args;
        return { id: "ma-1" };
      },
    },
  };

  const action = await ensureMerchantActionForRecommendation(prisma, {
    recommendation: recommendationFixture(),
  });

  assert.deepEqual(action, { id: "ma-1" });
  assert.deepEqual(upsert.where, { sourceRecommendationId: "rec-1" });
  assert.equal(upsert.create.merchantId, MERCHANT);
  assert.equal(upsert.create.shopId, SHOP);
  assert.equal(upsert.create.status, "proposed");
});

test("listMerchantActions returns active actions by default and can include history", async () => {
  const rows = [
    actionRow({ id: "active", status: "proposed", title: "Next move" }),
    actionRow({ id: "done", status: "completed", title: "Done move" }),
  ];
  const calls = { readModel: 0, reconciliation: 0, writes: 0 };
  const prisma = {
    merchantPlanRecommendation: {
      findMany: async () => {
        calls.reconciliation += 1;
        return [];
      },
    },
    actionExecution: {
      findMany: async () => {
        calls.reconciliation += 1;
        return [];
      },
    },
    merchantAction: {
      upsert: async () => {
        calls.writes += 1;
        return { id: "unused" };
      },
      findMany: async ({ where }) => {
        calls.readModel += 1;
        return rows.filter((row) => {
          if (
            row.merchantId !== where.merchantId ||
            row.shopId !== where.shopId
          ) {
            return false;
          }
          if (where.status?.in) return where.status.in.includes(row.status);
          return true;
        });
      },
    },
  };

  const active = await listMerchantActions(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
  });
  const all = await listMerchantActions(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    includeInactive: true,
  });

  assert.deepEqual(
    active.map((action) => action.id),
    ["active"],
  );
  assert.deepEqual(
    all.map((action) => action.id),
    ["active", "done"],
  );
  assert.deepEqual(calls, { readModel: 2, reconciliation: 0, writes: 0 });
});

test("getMerchantActionFocus is tenant-scoped and selects only focused-chat fields", async () => {
  let query = null;
  const prisma = {
    merchantAction: {
      findFirst: async (args) => {
        query = args;
        return actionRow();
      },
    },
  };

  const action = await getMerchantActionFocus(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "ma-1",
  });

  assert.equal(action.id, "ma-1");
  assert.deepEqual(query.where, {
    id: "ma-1",
    merchantId: MERCHANT,
    shopId: SHOP,
  });
  assert.equal(query.include, undefined);
  assert.deepEqual(Object.keys(query.select).sort(), [
    "createdAt",
    "currentActionRunId",
    "id",
    "sourceRecommendationId",
    "status",
    "summary",
    "title",
    "updatedAt",
  ]);
});

test("execution lifecycle writes through to the linked MerchantAction", async () => {
  let update = null;
  const prisma = {
    merchantAction: {
      updateMany: async (args) => {
        update = args;
        return { count: 1 };
      },
    },
  };

  const result = await updateMerchantActionForExecution(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionRunId: "run-1",
    execution: {
      merchantActionId: "ma-1",
      status: "applied",
      outcomeStatus: "measured",
      outcome: { result: "complete" },
    },
  });

  assert.deepEqual(result, { updated: true, count: 1 });
  assert.deepEqual(update.where, {
    merchantId: MERCHANT,
    shopId: SHOP,
    OR: [{ currentActionRunId: "run-1" }, { id: "ma-1" }],
  });
  assert.equal(update.data.status, "completed");
  assert.deepEqual(update.data.outcome, { result: "complete" });
});

test("recommendation lifecycle write-through preserves a stronger execution state", async () => {
  let update = null;
  const prisma = {
    merchantAction: {
      findFirst: async () => ({
        id: "ma-1",
        currentExecution: { status: "applied", outcomeStatus: "pending" },
      }),
      update: async (args) => {
        update = args;
        return { id: "ma-1" };
      },
    },
  };

  const result = await updateMerchantActionForRecommendation(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    recommendationId: "rec-1",
    recommendation: { reviewStatus: "deferred" },
  });

  assert.deepEqual(result, { updated: true });
  assert.equal(update.data.status, "in_progress");
});

function actionRow(overrides = {}) {
  return {
    id: "ma-1",
    merchantId: MERCHANT,
    shopId: SHOP,
    title: "Clear slow stock",
    summary: "Markdown slow-moving products.",
    status: "proposed",
    sourceRecommendationId: "rec-1",
    currentActionRunId: "run-1",
    progress: { workflow: workflowFixture() },
    outcome: {},
    createdAt: NOW,
    updatedAt: NOW,
    sourceRecommendation: recommendationFixture(),
    currentExecution: {
      runId: "run-1",
      actionType: "price_markdown",
      actionKind: "dead_stock_clearance",
      status: "proposed",
      resolvedMode: "approve",
      preview: {},
      proposalSummary: {},
    },
    executions: [],
    ...overrides,
  };
}

function recommendationFixture() {
  return {
    id: "rec-1",
    merchantId: MERCHANT,
    shopId: SHOP,
    title: "Clear slow stock",
    summary: "Markdown slow-moving products.",
    reviewStatus: "proposed",
    successSignal: {},
    workflows: [workflowFixture()],
  };
}

function workflowFixture() {
  return {
    id: "workflow-1",
    version: 1,
    status: "active",
    source: "plan_generation",
    steps: [
      {
        id: "step-1",
        orderIndex: 0,
        title: "Preview changes",
        description: "Review the markdown preview.",
        completionCriteria: "The preview is ready.",
        status: "pending",
        mode: "execute",
        capabilityRef: "execute:price_markdown:dead_stock",
        dependsOnStepIds: [],
        evidenceIds: [],
        actionExecutions: [],
      },
    ],
  };
}
