import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_COMMAND, executeActionCommand } from "../app/lib/actions/action-command.server.js";
import { handleFocusedActionMessage } from "../app/lib/actions/action-interpreter.server.js";
import { createOracleActionProvider } from "./helpers/action-agent-oracle.mjs";

const MERCHANT = "m1";
const SHOP = "s1";
const ACTION_ID = "a-evidence";
const quietLogger = { info() {}, warn() {}, error() {} };

function buildEvidenceRequiredPrisma() {
  const state = {
    action: {
      id: ACTION_ID,
      merchantId: MERCHANT,
      shopId: SHOP,
      title: "Improve supplier cost accuracy",
      summary: "Validate supplier costs before recommending reorders.",
      status: "accepted",
      sourceRecommendationId: "rec-evidence",
      currentActionRunId: null,
      plan: {},
      progress: {},
      outcome: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    constraints: [],
    steps: [
      {
        id: "step-upload",
        workflowId: "wf-evidence",
        recommendationId: "rec-evidence",
        merchantId: MERCHANT,
        shopId: SHOP,
        orderIndex: 0,
        title: "Upload supplier invoice",
        mode: "evidence_required",
        capabilityRef: "merchant:supplier_invoice",
        status: "needs_merchant",
        dependsOnStepIds: [],
        progress: {},
      },
      {
        id: "step-analysis",
        workflowId: "wf-evidence",
        recommendationId: "rec-evidence",
        merchantId: MERCHANT,
        shopId: SHOP,
        orderIndex: 1,
        title: "Analyse supplier costs",
        mode: "assist",
        capabilityRef: "assist:cost_analysis",
        status: "waiting",
        dependsOnStepIds: ["step-upload"],
        progress: {},
      },
    ],
    stepRuns: [],
  };

  const prisma = {
    state,
    merchantAction: {
      findFirst: async ({ where }) => {
        if (where.id !== ACTION_ID) return null;
        return {
          ...state.action,
          sourceRecommendation: {
            id: "rec-evidence",
            reviewStatus: "accepted",
            workflows: [{ id: "wf-evidence", status: "active", steps: state.steps }],
          },
          constraints: state.constraints,
          changeSets: [],
          executions: [],
          currentExecution: null,
        };
      },
      update: async ({ data }) => {
        Object.assign(state.action, data);
        return state.action;
      },
    },
    merchantRecommendationStep: {
      findMany: async () => state.steps,
      updateMany: async ({ where, data }) => {
        const rows = state.steps.filter((row) => !where.id || row.id === where.id);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantRecommendationWorkflow: {
      updateMany: async () => ({ count: 1 }),
    },
    merchantRecommendationStepRun: {
      create: async ({ data }) => ({ id: "sr-1", ...data }),
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    merchantActionEvent: { create: async ({ data }) => data },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
  };
  return prisma;
}

test("merchant-input golden: blocks with actionable guidance, not step-navigation errors", async () => {
  const prisma = buildEvidenceRequiredPrisma();
  const result = await handleFocusedActionMessage(prisma, {
    message: "Just finish this for me.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    provider: createOracleActionProvider(),
    logger: quietLogger,
  });

  assert.match(
    result.reply,
    /invoice|price sheet|csv|upload|supplier cost|evidence/i,
  );
  assert.doesNotMatch(result.reply, /step 1 is waiting|hasn't started yet/i);
});

test("merchant-input golden: achieve_outcome stops at merchant-owned gate", async () => {
  const prisma = buildEvidenceRequiredPrisma();
  const achieved = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ACHIEVE_OUTCOME,
    params: { outcome: "cost_analysis" },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(achieved.ok, false);
  assert.match(achieved.reply, /invoice|price sheet|csv|supplier evidence|upload/i);
});
