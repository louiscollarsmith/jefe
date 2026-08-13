import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMerchantActionStatus,
  ensureMerchantActionForExecution,
  listMerchantActions,
} from "../app/lib/actions/merchant-action.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const NOW = new Date("2026-08-13T10:00:00.000Z");

test("deriveMerchantActionStatus keeps the new lifecycle separate from source statuses", () => {
  assert.equal(deriveMerchantActionStatus({}), "proposed");
  assert.equal(
    deriveMerchantActionStatus({ recommendation: { reviewStatus: "accepted" } }),
    "accepted",
  );
  assert.equal(
    deriveMerchantActionStatus({ recommendation: { reviewStatus: "deferred" } }),
    "deferred",
  );
  assert.equal(
    deriveMerchantActionStatus({ recommendation: { reviewStatus: "rejected" } }),
    "declined",
  );
  assert.equal(
    deriveMerchantActionStatus({ recommendation: { reviewStatus: "superseded" } }),
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

test("ensureMerchantActionForExecution upserts by source recommendation and links the execution", async () => {
  const calls = [];
  const prisma = {
    merchantPlanRecommendation: {
      findFirst: async () => ({
        id: "rec-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        title: "Clear slow stock",
        summary: "Markdown slow-moving products.",
        reviewStatus: "proposed",
        executionSteps: [{ title: "Preview changes" }],
        successSignal: { description: "Recover trapped capital" },
      }),
    },
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
    sourceRecommendationId: "rec-1",
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

test("listMerchantActions returns active actions by default and can include history", async () => {
  const rows = [
    actionRow({ id: "active", status: "proposed", title: "Next move" }),
    actionRow({ id: "done", status: "completed", title: "Done move" }),
  ];
  const prisma = {
    merchantPlanRecommendation: { findMany: async () => [] },
    actionExecution: { findMany: async () => [] },
    merchantAction: {
      upsert: async () => ({ id: "unused" }),
      findMany: async ({ where }) =>
        rows.filter((row) => {
          if (row.merchantId !== where.merchantId || row.shopId !== where.shopId) {
            return false;
          }
          if (where.status?.in) return where.status.in.includes(row.status);
          return true;
        }),
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

  assert.deepEqual(active.map((action) => action.id), ["active"]);
  assert.deepEqual(all.map((action) => action.id), ["active", "done"]);
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
    progress: { executionSteps: [{ title: "Preview changes" }] },
    outcome: {},
    createdAt: NOW,
    updatedAt: NOW,
    sourceRecommendation: {
      id: "rec-1",
      title: "Clear slow stock",
      summary: "Markdown slow-moving products.",
      reviewStatus: "proposed",
      executionSteps: [{ title: "Preview changes" }],
      successSignal: {},
    },
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
