import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptMerchantActionPlan } from "../app/lib/actions/action-step-lifecycle.server.js";
import { ensureMerchantPlanQueued } from "../app/lib/merchant-plan/service.server.js";
import {
  countProposedMerchantActions,
  merchantHasInitialProposal,
  persistProposedRecommendationIfAllowed,
} from "../app/lib/merchant-plan/proposal-creation-invariant.server.js";
import {
  getHomeProposalGenerationState,
  HOME_PROPOSAL_SOURCE_MODE,
  requestHomeProposalGeneration,
} from "../app/lib/merchant-plan/home-proposal-generation.server.js";
import { PLAN_RUN_STATUS } from "../app/lib/merchant-plan/constants.server.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function createRegressionStore() {
  /** @type {Array<any>} */
  const actions = [];
  /** @type {Array<any>} */
  const recommendations = [];
  /** @type {Array<any>} */
  const planRuns = [];
  /** @type {Array<any>} */
  const backfillJobs = [];
  /** @type {Array<{ type: string; data: Record<string, unknown> }>} */
  const mutations = [];

  const merchantId = "merchant-regression";
  const shopId = "shop-regression";

  const recordMutation = (type, data) => {
    mutations.push({ type, data });
  };

  const prisma = {
    $transaction: async (callback, _options) => callback(prisma),
    $queryRawUnsafe: async () => [{ locked: 1 }],
    merchantAction: {
      count: async ({ where }) =>
        actions.filter(
          (action) =>
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId &&
            action.status === where.status,
        ).length,
      findFirst: async ({ where }) =>
        actions.find(
          (action) =>
            action.id === where.id &&
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId,
        ) ?? null,
      findMany: async ({ where }) =>
        actions.filter(
          (action) =>
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId &&
            (!where.status || action.status === where.status),
        ),
      updateMany: async ({ where, data }) => {
        recordMutation("merchantAction.updateMany", { where, data });
        let count = 0;
        for (const action of actions) {
          if (
            action.id === where.id &&
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId &&
            (!where.status?.in || where.status.in.includes(action.status))
          ) {
            Object.assign(action, data);
            count += 1;
          }
        }
        return { count };
      },
      create: async ({ data }) => {
        recordMutation("merchantAction.create", data);
        const action = { ...data, id: data.id ?? `action-${actions.length + 1}` };
        actions.push(action);
        return action;
      },
    },
    merchantPlanRecommendation: {
      count: async ({ where }) =>
        recommendations.filter(
          (rec) =>
            rec.merchantId === where.merchantId &&
            rec.shopId === where.shopId &&
            (!where.reviewStatus?.not || rec.reviewStatus !== where.reviewStatus.not),
        ).length,
      updateMany: async ({ where, data }) => {
        recordMutation("merchantPlanRecommendation.updateMany", { where, data });
        let count = 0;
        for (const rec of recommendations) {
          if (
            rec.id === where.id &&
            rec.merchantId === where.merchantId &&
            rec.shopId === where.shopId &&
            (!where.reviewStatus?.in || where.reviewStatus.in.includes(rec.reviewStatus))
          ) {
            Object.assign(rec, data);
            count += 1;
          }
        }
        return { count };
      },
      upsert: async ({ where, create, update }) => {
        recordMutation("merchantPlanRecommendation.upsert", { where, create, update });
        let rec = recommendations.find((entry) => entry.runId === where.runId);
        if (rec) {
          Object.assign(rec, update);
        } else {
          rec = { ...create, id: `rec-${recommendations.length + 1}` };
          recommendations.push(rec);
        }
        return rec;
      },
    },
    merchantPlanRun: {
      count: async ({ where }) =>
        planRuns.filter((run) => {
          if (run.merchantId !== where.merchantId) return false;
          if (where.shopId && run.shopId !== where.shopId) return false;
          if (where.sourceMode && run.sourceMode !== where.sourceMode) return false;
          if (where.status && run.status !== where.status) return false;
          if (where.status?.in && !where.status.in.includes(run.status)) return false;
          if (where.completedAt?.gte && (!run.completedAt || run.completedAt < where.completedAt.gte)) {
            return false;
          }
          return true;
        }).length,
      findUnique: async ({ where }) => {
        if (where.id) return planRuns.find((run) => run.id === where.id) ?? null;
        const key = where.shopId_snapshotHash_promptVersion_schemaVersion;
        if (!key) return null;
        return (
          planRuns.find(
            (run) =>
              run.shopId === key.shopId &&
              run.snapshotHash === key.snapshotHash &&
              run.promptVersion === key.promptVersion &&
              run.schemaVersion === key.schemaVersion,
          ) ?? null
        );
      },
      findFirst: async ({ where }) =>
        planRuns.find((run) => {
          if (where.id && run.id !== where.id) return false;
          if (where.merchantId && run.merchantId !== where.merchantId) return false;
          if (where.shopId && run.shopId !== where.shopId) return false;
          return true;
        }) ?? null,
      upsert: async ({ where, create, update }) => {
        recordMutation("merchantPlanRun.upsert", { where, create, update });
        const key = where.shopId_snapshotHash_promptVersion_schemaVersion;
        let run = planRuns.find(
          (entry) =>
            entry.shopId === key.shopId &&
            entry.snapshotHash === key.snapshotHash &&
            entry.promptVersion === key.promptVersion &&
            entry.schemaVersion === key.schemaVersion,
        );
        if (run) {
          Object.assign(run, update);
        } else {
          run = {
            ...create,
            id: create.id ?? `run-${planRuns.length + 1}`,
            sourceMode: create.sourceMode ?? "full",
          };
          planRuns.push(run);
        }
        return run;
      },
      update: async ({ where, data }) => {
        recordMutation("merchantPlanRun.update", { where, data });
        const run = planRuns.find((entry) => entry.id === where.id);
        if (!run) throw new Error("run not found");
        Object.assign(run, data);
        return run;
      },
      updateMany: async ({ where, data }) => {
        recordMutation("merchantPlanRun.updateMany", { where, data });
        let count = 0;
        for (const run of planRuns) {
          if (run.merchantId === where.merchantId && run.shopId === where.shopId) {
            if (where.id?.not && run.id === where.id.not) continue;
            Object.assign(run, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    merchantRecommendationWorkflow: {
      updateMany: async ({ where, data }) => {
        recordMutation("merchantRecommendationWorkflow.updateMany", { where, data });
        return { count: 0 };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        recordMutation("merchantActionEvent.create", data);
        return data;
      },
    },
    backfillJob: {
      findUnique: async () => null,
    },
  };

  const snapshot = {
    snapshotHash: "snapshot-regression",
    candidateCount: 5,
    hasGoals: true,
    beliefIds: ["belief-1"],
    insightRunId: "insight-run-1",
    goalRunId: "goal-run-1",
  };

  return {
    merchantId,
    shopId,
    prisma,
    actions,
    recommendations,
    planRuns,
    backfillJobs,
    mutations,
    snapshot,
    seedInitialProposal() {
      const runId = "run-onboarding-a";
      planRuns.push({
        id: runId,
        merchantId,
        shopId,
        status: PLAN_RUN_STATUS.completed,
        sourceMode: "full",
        snapshotHash: snapshot.snapshotHash,
        completedAt: new Date("2026-08-19T14:56:58.000Z"),
      });
      recommendations.push({
        id: "rec-a",
        runId,
        merchantId,
        shopId,
        title: "Proposal A",
        reviewStatus: "proposed",
        sourceMode: "full",
      });
      actions.push({
        id: "action-a",
        merchantId,
        shopId,
        status: "proposed",
        sourceRecommendationId: "rec-a",
        sourceRecommendation: {
          id: "rec-a",
          reviewStatus: "proposed",
          acceptedAt: null,
        },
        workflows: [],
      });
    },
    countProposed() {
      return actions.filter((action) => action.status === "proposed").length;
    },
    homePlanRunsBeforeExplicitGenerate() {
      return planRuns.filter((run) => run.sourceMode === HOME_PROPOSAL_SOURCE_MODE).length;
    },
  };
}

test("post-onboarding background chain cannot manufacture proposal #2 (original bug regression)", async () => {
  const store = createRegressionStore();
  store.seedInitialProposal();

  assert.equal(store.countProposed(), 1);
  assert.equal(await merchantHasInitialProposal(store.prisma, store), true);

  const backgroundQueue = await ensureMerchantPlanQueued(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    resetAttempts: true,
  });
  assert.equal(backgroundQueue.status, "deferred_initial_proposal_exists");
  assert.equal(store.countProposed(), 1);
  assert.equal(store.homePlanRunsBeforeExplicitGenerate(), 0);

  const postGoalsChainQueue = await ensureMerchantPlanQueued(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    resetAttempts: true,
  });
  assert.equal(postGoalsChainQueue.status, "deferred_initial_proposal_exists");
  assert.equal(store.countProposed(), 1);

  store.mutations.length = 0;
  const homeStateBeforeGenerate = await getHomeProposalGenerationState(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    now: new Date("2026-08-19T15:45:00.000Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => store.countProposed() > 0,
      inFlight: async () => false,
    },
  });
  assert.equal(homeStateBeforeGenerate?.canGenerate, false);
  assert.equal(homeStateBeforeGenerate?.reason, "proposed_exists");
  assert.equal(store.mutations.length, 0);

  const accepted = await acceptMerchantActionPlan(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    actionId: "action-a",
    logger: silentLogger,
  });
  assert.equal(accepted.ok, true);
  assert.equal(store.actions.find((action) => action.id === "action-a")?.status, "accepted");
  assert.equal(store.countProposed(), 0);

  const postAcceptBackgroundQueue = await ensureMerchantPlanQueued(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    resetAttempts: true,
  });
  assert.equal(postAcceptBackgroundQueue.status, "deferred_initial_proposal_exists");
  assert.equal(store.countProposed(), 0);

  store.mutations.length = 0;
  const homeStateAfterAccept = await getHomeProposalGenerationState(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    now: new Date("2026-08-19T15:46:00.000Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => store.countProposed() > 0,
      inFlight: async () => false,
    },
  });
  assert.equal(homeStateAfterAccept?.canGenerate, true);
  assert.equal(homeStateAfterAccept?.reason, null);
  assert.equal(store.countProposed(), 0);
  assert.equal(store.homePlanRunsBeforeExplicitGenerate(), 0);
  assert.equal(store.mutations.length, 0);

  const queuedHome = await requestHomeProposalGeneration(store.prisma, {
    merchantId: store.merchantId,
    shopId: store.shopId,
    now: new Date("2026-08-19T15:47:00.000Z"),
    ensureQueued: async (_client, queueInput) => {
      assert.equal(queueInput.sourceMode, HOME_PROPOSAL_SOURCE_MODE);
      store.planRuns.push({
        id: "run-home-b",
        merchantId: store.merchantId,
        shopId: store.shopId,
        sourceMode: HOME_PROPOSAL_SOURCE_MODE,
        status: PLAN_RUN_STATUS.queued,
      });
      return { status: "queued" };
    },
    deps: {
      count: async () => 0,
      hasProposed: async () => store.countProposed() > 0,
      inFlight: async () => false,
    },
  });
  assert.equal(queuedHome.ok, true);
  assert.equal(store.homePlanRunsBeforeExplicitGenerate(), 1);
  assert.equal(store.countProposed(), 0);

  const homeRun = store.planRuns.find((run) => run.sourceMode === HOME_PROPOSAL_SOURCE_MODE);
  assert.ok(homeRun);

  const persisted = await persistProposedRecommendationIfAllowed(
    store.prisma,
    {
      merchantId: store.merchantId,
      shopId: store.shopId,
      trigger: "merchant_home",
    },
    async (tx) => {
      const recommendation = {
        id: "rec-b",
        runId: homeRun.id,
        merchantId: store.merchantId,
        shopId: store.shopId,
        title: "Proposal B",
        reviewStatus: "proposed",
        sourceMode: HOME_PROPOSAL_SOURCE_MODE,
      };
      store.recommendations.push(recommendation);
      await tx.merchantPlanRecommendation.upsert({
        where: { runId: homeRun.id },
        create: recommendation,
        update: recommendation,
      });
      await tx.merchantAction.create({
        data: {
          id: "action-b",
          merchantId: store.merchantId,
          shopId: store.shopId,
          status: "proposed",
          sourceRecommendationId: recommendation.id,
        },
      });
      return recommendation;
    },
  );
  assert.equal(persisted.ok, true);
  assert.equal(await countProposedMerchantActions(store.prisma, store), 1);
  assert.equal(store.actions.find((action) => action.id === "action-a")?.status, "accepted");
  assert.equal(store.actions.find((action) => action.id === "action-b")?.status, "proposed");
});

test("home loader source is read-only for proposal state", () => {
  const routeSource = readFileSync(
    new URL("../app/routes/app._index.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(routeSource, /supersedeDuplicateProposedActions/);
  assert.doesNotMatch(routeSource, /repairDuplicateProposedActions/);
  assert.match(
    routeSource,
    /const merchantActionsPromise = listMerchantActions\(prisma, \{/,
  );
});
