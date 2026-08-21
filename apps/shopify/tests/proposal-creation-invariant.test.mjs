import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkProposedCreationAllowed,
  countProposedMerchantActions,
  merchantHasInitialProposal,
  merchantHasProposedAction,
  PROPOSAL_CREATION_TRIGGERS,
  resolveProposalTriggerForQueue,
  shouldDeferAutonomousProposalCreation,
  supersedeDuplicateProposedActions,
} from "../app/lib/merchant-plan/proposal-creation-invariant.server.js";
import { ensureMerchantPlanQueued } from "../app/lib/merchant-plan/service.server.js";

test("merchantHasInitialProposal ignores superseded recommendations", async () => {
  const prisma = {
    merchantPlanRecommendation: {
      count: async ({ where }) =>
        where.reviewStatus?.not === "superseded" ? 2 : 0,
    },
  };
  assert.equal(
    await merchantHasInitialProposal(/** @type {any} */ (prisma), {
      merchantId: "m1",
      shopId: "s1",
    }),
    true,
  );
});

test("checkProposedCreationAllowed blocks when a proposed action exists", async () => {
  const prisma = {
    merchantAction: {
      count: async () => 1,
    },
    merchantPlanRecommendation: {
      count: async () => 0,
    },
  };
  const gate = await checkProposedCreationAllowed(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    trigger: "background",
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "proposed_exists");
});

test("checkProposedCreationAllowed blocks background creation after initial proposal", async () => {
  const prisma = {
    merchantAction: {
      count: async () => 0,
    },
    merchantPlanRecommendation: {
      count: async () => 1,
    },
  };
  const gate = await checkProposedCreationAllowed(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    trigger: "background",
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "initial_proposal_exists");
});

test("checkProposedCreationAllowed allows merchant_home even after initial proposal", async () => {
  const prisma = {
    merchantAction: {
      count: async () => 0,
    },
    merchantPlanRecommendation: {
      count: async () => 3,
    },
  };
  const gate = await checkProposedCreationAllowed(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    trigger: "merchant_home",
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, null);
});

test("ensureMerchantPlanQueued defers autonomous queue after initial proposal", async () => {
  const prisma = {
    merchantPlanRecommendation: {
      count: async () => 1,
    },
  };
  const result = await ensureMerchantPlanQueued(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
  });
  assert.equal(result.status, "deferred_initial_proposal_exists");
});

test("ensureMerchantPlanQueued allows home sourceMode past autonomous defer gate", () => {
  const serviceSource = readFileSync(
    new URL("../app/lib/merchant-plan/service.server.js", import.meta.url),
    "utf8",
  );
  assert.match(serviceSource, /input\.sourceMode === "home"/);
  assert.match(serviceSource, /resolveProposalTriggerForQueue/);
  assert.doesNotMatch(serviceSource, /merchantTriggered/);
});

test("background callers cannot pass merchant_onboarding through goals service", () => {
  const goalsSource = readFileSync(
    new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(goalsSource, /proposalTrigger/);
  assert.doesNotMatch(goalsSource, /merchantTriggered/);
});

test("backfill worker dispatches canonical agentic recommendation jobs", () => {
  const workerSource = readFileSync(
    new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
    "utf8",
  );
  assert.match(workerSource, /AGENTIC_RECOMMENDATION_JOB_TYPE/);
  assert.match(workerSource, /runAgenticRecommendationInvestigation/);
  assert.match(workerSource, /Legacy merchant_plan_generate is retired/);
  assert.doesNotMatch(workerSource, /payload\.proposalTrigger === "merchant_onboarding"/);
  assert.doesNotMatch(workerSource, /merchantTriggered/);
});

test("resolveProposalTriggerForQueue maps explicit intents", () => {
  assert.equal(
    resolveProposalTriggerForQueue({ sourceMode: "home" }),
    PROPOSAL_CREATION_TRIGGERS.MERCHANT_HOME,
  );
  assert.equal(
    resolveProposalTriggerForQueue({ proposalTrigger: "merchant_onboarding" }),
    PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING,
  );
  assert.equal(
    resolveProposalTriggerForQueue({}),
    PROPOSAL_CREATION_TRIGGERS.BACKGROUND,
  );
});

test("daily home loader does not repair duplicate proposed actions", () => {
  const routeSource = readFileSync(
    new URL("../app/routes/app._index.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(routeSource, /supersedeDuplicateProposedActions/);
  assert.doesNotMatch(routeSource, /repairDuplicateProposedActions/);
  assert.match(routeSource, /const merchantActionsPromise = listMerchantActions\(prisma,/);
});

test("supersedeDuplicateProposedActions retains full over bootstrap", async () => {
  const updates = [];
  const prisma = {
    merchantAction: {
      findMany: async () => [
        {
          id: "bootstrap-action",
          sourceRecommendationId: "bootstrap-rec",
          updatedAt: new Date("2026-08-19T15:41:00.000Z"),
          sourceRecommendation: { id: "bootstrap-rec", sourceMode: "bootstrap" },
        },
        {
          id: "full-action",
          sourceRecommendationId: "full-rec",
          updatedAt: new Date("2026-08-19T15:29:00.000Z"),
          sourceRecommendation: { id: "full-rec", sourceMode: "full" },
        },
      ],
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    merchantPlanRecommendation: {
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const result = await supersedeDuplicateProposedActions(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
  });
  assert.equal(result.retained, 1);
  assert.equal(result.superseded, 1);
  assert.equal(
    updates.some((entry) => entry.where?.id === "bootstrap-action"),
    true,
  );
  assert.equal(
    updates.some((entry) => entry.where?.id === "full-action"),
    false,
  );
});

test("merchant goals service queues the canonical agentic recommendation path", () => {
  const goalsSource = readFileSync(
    new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
    "utf8",
  );
  assert.match(goalsSource, /ensureAgenticRecommendationQueued/);
  assert.doesNotMatch(goalsSource, /ensureMerchantPlanQueued/);
  assert.doesNotMatch(goalsSource, /MERCHANT_PLAN_JOB_TYPE/);
});

test("legacy generateMerchantPlan remains duplicate-guarded while retired from the worker path", () => {
  const serviceSource = readFileSync(
    new URL("../app/lib/merchant-plan/service.server.js", import.meta.url),
    "utf8",
  );
  assert.match(serviceSource, /deferred_initial_proposal_exists/);
  assert.match(serviceSource, /persistProposedRecommendationIfAllowed/);
});

test("bootstrap no longer creates background recommendation proposals", () => {
  const bootstrapSource = readFileSync(
    new URL("../app/lib/onboarding/bootstrap.server.js", import.meta.url),
    "utf8",
  );
  assert.match(bootstrapSource, /ready_for_agentic_recommendation/);
  assert.match(bootstrapSource, /retired_agentic_recommendation_only/);
  assert.doesNotMatch(bootstrapSource, /shouldDeferAutonomousProposalCreation/);
  assert.doesNotMatch(bootstrapSource, /checkProposedCreationAllowed/);
});

test("insights and goals services remain free to run after onboarding", () => {
  const workerSource = readFileSync(
    new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
    "utf8",
  );
  assert.match(workerSource, /ensureMerchantInsightsQueued/);
  const goalsSource = readFileSync(
    new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
    "utf8",
  );
  assert.match(goalsSource, /ensureAgenticRecommendationQueued/);
  assert.doesNotMatch(goalsSource, /ensureMerchantPlanQueued/);
});

test("countProposedMerchantActions and merchantHasProposedAction stay aligned", async () => {
  const prisma = {
    merchantAction: {
      count: async () => 2,
    },
  };
  assert.equal(
    await countProposedMerchantActions(/** @type {any} */ (prisma), {
      merchantId: "m1",
      shopId: "s1",
    }),
    2,
  );
  assert.equal(
    await merchantHasProposedAction(/** @type {any} */ (prisma), {
      merchantId: "m1",
      shopId: "s1",
    }),
    true,
  );
});

test("shouldDeferAutonomousProposalCreation mirrors merchantHasInitialProposal", async () => {
  const prisma = {
    merchantPlanRecommendation: {
      count: async () => 1,
    },
  };
  assert.equal(await shouldDeferAutonomousProposalCreation(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
  }), true);
});
