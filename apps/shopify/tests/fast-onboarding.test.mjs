import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  approveOnboardingRecommendation,
  contextFromBelief,
  getFastOnboardingExperience,
  recordFastOnboardingMilestone,
  retryFastOnboarding,
  shapeFullLearning,
  shapeRecommendation,
} from "../app/lib/onboarding/fast-onboarding.server.js";
import {
  ensureRecommendationReviewQueued,
  FULL_BACKFILL_JOB_TYPES,
  retryFailedBackfillJobs,
} from "../app/services/shopify-backfill-status.server.js";
import { trackOnce } from "../app/services/analytics/event-log.server.js";

const componentSource = fs.readFileSync(
  new URL("../app/components/fast-value-onboarding.tsx", import.meta.url),
  "utf8",
);
const serviceSource = fs.readFileSync(
  new URL("../app/lib/onboarding/fast-onboarding.server.js", import.meta.url),
  "utf8",
);
const routeSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const cssSource = fs.readFileSync(
  new URL("../app/styles/jefe.css", import.meta.url),
  "utf8",
);

test("the UI keeps the exact beats, one dominant result and honest chrome", () => {
  assert.match(componentSource, /setTimeout\(\(\) => setAcknowledgementFinished\(true\), 1700\)/);
  assert.match(componentSource, /const handoffUrl = data\.handoffUrl;[\s\S]*setTimeout\(\(\) => navigate\(handoffUrl, \{ replace: true \}\), 450\)/);
  assert.match(componentSource, /type: "entered_app"[\s\S]*current\.searchParams\.delete\("handoff"\)[\s\S]*navigate\(appUrl, \{ replace: true \}\)/);
  assert.match(componentSource, /presentation\.evidence\.slice\(0, 3\)/);
  assert.match(componentSource, /recommendationInvestigationPending/);
  assert.match(componentSource, /Boolean\(experience\.context\)[\s\S]*!experience\.failure[\s\S]*learningPipelinePending/);
  assert.match(componentSource, /I won’t suggest something I can’t back up with your store data/);
  assert.match(serviceSource, /Work on this/);
  assert.match(componentSource, /Opening Action Chat/);
  assert.doesNotMatch(componentSource, /I’ll track this and tell you when the success signal is ready to review/);
  assert.doesNotMatch(routeSource, /agentic_execute/);
  assert.doesNotMatch(componentSource, /<Spinner|progress bar|Synchronising|Importing refunds|Processing/i);
  assert.doesNotMatch(componentSource, /\d+\s+of\s+\d+/i);
  assert.doesNotMatch(serviceSource, /\$\{[^}]+\}%/);
  const fastCss = cssSource.slice(cssSource.indexOf("Fast time-to-value onboarding"));
  assert.doesNotMatch(fastCss, /position:\s*fixed/);
  assert.match(fastCss, /prefers-reduced-motion/);
});

test("all fast onboarding intents are routed and the handoff is single-use", () => {
  for (const intent of [
    "onboarding.context.answer",
    "onboarding.insight.continue",
    "onboarding.insight.alternative",
    "onboarding.recommendation.approve",
    "onboarding.recommendation.defer",
    "onboarding.milestone",
    "onboarding.retry",
    "onboarding.skip",
  ]) {
    assert.match(routeSource, new RegExp(intent.replaceAll(".", "\\.")));
  }
  assert.match(serviceSource, /consumedAt: null/);
  assert.match(serviceSource, /consumedAt: new Date\(\)/);
  assert.match(serviceSource, /process\.env\.ENABLE_DEV_TOOLS === "true"/);
  assert.match(routeSource, /intent === "onboarding\.milestone"/);
  assert.match(routeSource, /intent === "onboarding\.recommendation\.approve"/);
});

test("trackOnce treats a duplicate dedupe key as success", async () => {
  const prisma = {
    activityEvent: {
      create: async () => { throw Object.assign(new Error("duplicate"), { code: "P2002" }); },
    },
  };
  assert.equal(await trackOnce(prisma, { type: "entered_app", dedupeKey: "entered_app:test" }), true);
});

test("recommendation review scheduling preserves the earliest due work", async () => {
  const earlier = new Date("2026-08-20T10:00:00.000Z");
  let update = null;
  const prisma = {
    backfillJob: {
      findUnique: async () => ({ id: "review-1", status: "queued", runAfter: earlier }),
      update: async (args) => { update = args; return args.data; },
    },
  };
  await ensureRecommendationReviewQueued(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    runAfter: new Date("2026-08-22T10:00:00.000Z"),
  });
  assert.equal(update.data.runAfter.toISOString(), earlier.toISOString());
  assert.equal(update.data.attemptCount, 0);
  assert.equal(update.data.startedAt, null);
});

test("a review scheduled during a running cycle records a durable earliest rescan", async () => {
  let update = null;
  const prisma = {
    backfillJob: {
      findUnique: async () => ({
        id: "review-1",
        status: "running",
        runAfter: new Date("2026-08-22T10:00:00.000Z"),
        payloadJson: {
          requestedRunAfter: "2026-08-24T10:00:00.000Z",
        },
      }),
      update: async (args) => { update = args; return args.data; },
    },
  };
  await ensureRecommendationReviewQueued(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    runAfter: new Date("2026-08-20T10:00:00.000Z"),
  });
  assert.equal(update.data.payloadJson.rescanRequested, true);
  assert.equal(
    update.data.payloadJson.requestedRunAfter,
    "2026-08-20T10:00:00.000Z",
  );
});

test("agentic recommendations render without MerchantInsightFinding", async () => {
  const supportingBeliefIds = ["belief-priority", "belief-white-wine"];
  let insightLookupCount = 0;
  const prisma = {
    shop: {
      findUniqueOrThrow: async () => ({
        onboardingCompletedAt: null,
        onboardingMetadata: {},
        backfillCompletedAt: new Date(),
      }),
    },
    shopBackfillStatus: {
      findUnique: async () => ({
        status: "complete",
        metadata: { phase: "ready_for_agentic_recommendation", onboardingEpoch: "epoch-1" },
        startedAt: new Date(),
      }),
      findMany: async () =>
        ["products", "inventory", "orders", "customers", "refunds"].map(
          (domain) => ({ domain, status: "complete", lastError: null }),
        ),
    },
    backfillJob: {
      findUnique: async () => ({
        id: "bootstrap-1",
        status: "succeeded",
        payloadJson: { onboardingEpoch: "epoch-1" },
        resultJson: { phase: "ready_for_agentic_recommendation" },
      }),
      findMany: async () => [{ jobType: "backfill_finalize", status: "succeeded" }],
    },
    merchantMemoryBelief: {
      findFirst: async () => ({
        value: {
          option: "revenue",
          label: "Grow revenue",
          echo: "revenue comes first",
        },
      }),
      findMany: async () => [
        {
          id: supportingBeliefIds[1],
          key: "products.bestseller_by_revenue.trailing_90d",
          value: { title: "House White" },
          evidence: [],
        },
      ],
    },
    merchantPlanRecommendation: {
      findMany: async () => [
        {
          id: "62242f04-30e6-4d57-b5c0-b090fcd35f32",
          merchantId: "merchant-1",
          shopId: "shop-1",
          runId: "ba9d3224-7a3c-4b91-8f7e-cf57fb288ea5",
          title: "Create a featured collection of proven, in-stock white wines",
          summary: "Make proven white wines easier to find.",
          whyThisAction: "In-stock white wines have enough evidence to deserve a storefront collection.",
          startToday: "Create the collection and add the qualifying products.",
          expectedBenefit: "Customers can browse a cleaner path to available white wines.",
          successSignal: { description: "A featured collection exists for proven, in-stock white wines." },
          confidence: "high",
          caveat: null,
          reviewStatus: "proposed",
          outcomeStatus: "pending",
          reviewAt: null,
          sourceMode: "agentic",
          supportingBeliefIds,
          supportingInsightIds: [],
          run: { insightRunId: "insight-run-not-required", result: { status: "RECOMMEND_ACTION" } },
          evidenceSnapshot: null,
          actionExecution: null,
        },
      ],
    },
    merchantPlanRun: {
      findFirst: async () => ({
        id: "ba9d3224-7a3c-4b91-8f7e-cf57fb288ea5",
        status: "completed",
        sourceMode: "agentic",
        result: { status: "RECOMMEND_ACTION" },
      }),
    },
    merchantInsightFinding: {
      findFirst: async () => {
        insightLookupCount += 1;
        throw new Error("agentic recommendation must not require a MerchantInsightFinding");
      },
    },
    activityEvent: { create: async ({ data }) => data },
  };

  const experience = await getFastOnboardingExperience(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
  });

  assert.equal(experience.stage, "insight");
  assert.equal(experience.failure, null);
  assert.equal(experience.insight, null);
  assert.equal(experience.recommendation.id, "62242f04-30e6-4d57-b5c0-b090fcd35f32");
  assert.equal(experience.presentation.source, "recommendation");
  assert.equal(experience.presentation.headline, "Create a featured collection of proven, in-stock white wines");
  assert.match(experience.presentation.explanation, /In-stock white wines/);
  assert.equal(experience.recommendationInvestigationPending, false);
  assert.equal(insightLookupCount, 0);
});

test("legacy recommendations keep rendering through supporting MerchantInsightFinding", async () => {
  const supportingBeliefIds = ["belief-1"];
  const supportingInsightIds = ["finding-1"];
  let insightLookupCount = 0;
  const prisma = {
    shop: {
      findUniqueOrThrow: async () => ({
        onboardingCompletedAt: null,
        onboardingMetadata: {},
        backfillCompletedAt: new Date(),
      }),
    },
    shopBackfillStatus: {
      findUnique: async () => ({
        status: "complete",
        metadata: { phase: "ready", onboardingEpoch: "epoch-1" },
        startedAt: new Date(),
      }),
      findMany: async () =>
        ["products", "inventory", "orders", "customers", "refunds"].map(
          (domain) => ({ domain, status: "complete", lastError: null }),
        ),
    },
    backfillJob: {
      findUnique: async () => ({
        id: "bootstrap-1",
        status: "succeeded",
        payloadJson: { onboardingEpoch: "epoch-1" },
        resultJson: { phase: "ready" },
      }),
      findMany: async () => [{ jobType: "backfill_finalize", status: "succeeded" }],
    },
    merchantMemoryBelief: {
      findFirst: async () => ({
        value: {
          option: "profit",
          label: "Improve margin",
          echo: "margin comes first",
        },
      }),
      findMany: async () => [],
    },
    merchantPlanRecommendation: {
      findMany: async () => [
        {
          id: "legacy-recommendation-1",
          merchantId: "merchant-1",
          shopId: "shop-1",
          runId: "legacy-plan-1",
          title: "Protect Bestseller Stock Levels",
          summary: "Protect stock levels.",
          whyThisAction: "Two products are at risk of stocking out.",
          startToday: "I’ll track the stock signal.",
          expectedBenefit: "Fewer avoidable stockouts.",
          successSignal: { description: "The products stay available while demand continues." },
          reviewStatus: "proposed",
          outcomeStatus: "pending",
          reviewAt: null,
          sourceMode: "bootstrap",
          supportingBeliefIds,
          supportingInsightIds,
          run: { insightRunId: "insight-run-1", result: {} },
          evidenceSnapshot: null,
          actionExecution: null,
        },
      ],
    },
    merchantPlanRun: {
      findFirst: async () => null,
    },
    merchantInsightFinding: {
      findFirst: async () => {
        insightLookupCount += 1;
        return {
          id: supportingInsightIds[0],
          runId: "insight-run-1",
          title: "Stockouts threaten 2 products in the trailing 30 days",
          finding: "Two products have low cover.",
          whyItMatters: "Running out would interrupt current demand.",
          confidence: "medium",
          caveat: null,
        };
      },
    },
    activityEvent: { create: async ({ data }) => data },
  };

  const experience = await getFastOnboardingExperience(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
  });

  assert.equal(experience.stage, "insight");
  assert.equal(experience.recommendation.id, "legacy-recommendation-1");
  assert.equal(experience.insight.headline, "Stockouts threaten 2 products in the trailing 30 days");
  assert.equal(experience.presentation.source, "insight");
  assert.equal(experience.presentation.headline, experience.insight.headline);
  assert.equal(insightLookupCount, 1);
});

test("first-run onboarding surfaces a full-memory recommendation", async () => {
  const supportingBeliefIds = ["belief-1"];
  const supportingInsightIds = ["finding-1"];
  const prisma = {
    shop: {
      findUniqueOrThrow: async () => ({
        onboardingCompletedAt: null,
        onboardingMetadata: {},
        backfillCompletedAt: new Date(),
      }),
    },
    shopBackfillStatus: {
      findUnique: async () => ({
        status: "complete",
        metadata: { phase: "insufficient_evidence", onboardingEpoch: "epoch-1" },
        startedAt: new Date(),
      }),
      findMany: async () =>
        ["products", "inventory", "orders", "customers", "refunds"].map(
          (domain) => ({ domain, status: "complete", lastError: null }),
        ),
    },
    backfillJob: {
      findUnique: async () => ({
        id: "bootstrap-1",
        status: "succeeded",
        payloadJson: { onboardingEpoch: "epoch-1" },
        resultJson: { phase: "insufficient_evidence" },
      }),
      findMany: async () => [{ jobType: "backfill_finalize", status: "succeeded" }],
    },
    merchantMemoryBelief: {
      findFirst: async () => ({
        value: {
          option: "profit",
          label: "Improve margin",
          echo: "margin comes first",
        },
      }),
      findMany: async () => [
        {
          id: supportingBeliefIds[0],
          key: "inventory.low_cover_products.trailing_30d",
          value: {
            topAtRiskProduct: { title: "Pear Skin Sipon", daysOfCover: 0 },
          },
          evidence: [],
        },
      ],
    },
    merchantPlanRecommendation: {
      findMany: async () => [
        {
          id: "recommendation-1",
          merchantId: "merchant-1",
          shopId: "shop-1",
          runId: "plan-1",
          title: "Protect Bestseller Stock Levels",
          summary: "Protect stock levels.",
          whyThisAction: "Two products are at risk of stocking out.",
          startToday: "I’ll track the stock signal.",
          expectedBenefit: "Fewer avoidable stockouts.",
          successSignal: { description: "The products stay available while demand continues." },
          reviewStatus: "proposed",
          outcomeStatus: "pending",
          reviewAt: null,
          sourceMode: "full",
          supportingBeliefIds,
          supportingInsightIds,
          run: { insightRunId: "insight-run-1", result: {} },
          evidenceSnapshot: null,
          actionExecution: null,
        },
      ],
    },
    merchantInsightFinding: {
      findFirst: async () => ({
        id: supportingInsightIds[0],
        runId: "insight-run-1",
        title: "Stockouts threaten 2 products in the trailing 30 days",
        finding: "Two products have low cover.",
        whyItMatters: "Running out would interrupt current demand.",
        confidence: "medium",
        caveat: null,
      }),
    },
    activityEvent: { create: async ({ data }) => data },
  };

  const experience = await getFastOnboardingExperience(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
  });

  assert.equal(experience.stage, "insight");
  assert.equal(experience.failure, null);
  assert.equal(experience.recommendation.title, "Protect Bestseller Stock Levels");
  assert.equal(experience.recommendation.sourceMode, "full");
  assert.equal(experience.insight.headline, "Stockouts threaten 2 products in the trailing 30 days");
});

test("a middle full-domain failure is visible and retry targets only full jobs", async () => {
  const statuses = [
    { domain: "products", status: "failed", lastError: "temporary network error" },
    ...["inventory", "orders", "customers", "refunds"].map((domain) => ({ domain, status: "complete", lastError: null })),
  ];
  assert.equal(shapeFullLearning(statuses, []).state, "failed");
  let where = null;
  const prisma = {
    backfillJob: {
      updateMany: async (args) => { where = args.where; return { count: 1 }; },
    },
  };
  await retryFailedBackfillJobs(prisma, {
    shopId: "shop-1",
    jobTypes: FULL_BACKFILL_JOB_TYPES,
  });
  assert.deepEqual(where.jobType.in, FULL_BACKFILL_JOB_TYPES);
  assert.equal(where.jobType.in.includes("merchant_memory_bootstrap"), false);
});

test("legacy and current priority shapes retain the exact merchant echo", () => {
  const current = { value: { option: "slow_inventory", label: "Move slow inventory", echo: "custom echo" } };
  const legacy = { value: { value: "jefe_read_first", label: "Read first", echo: "legacy echo" } };
  assert.deepEqual(contextFromBelief(current), {
    value: "slow_inventory",
    label: "Move slow inventory",
    echo: "custom echo",
  });
  assert.deepEqual(contextFromBelief(legacy), {
    value: "jefe_read_first",
    label: "Read first",
    echo: "legacy echo",
  });
});

test("reinstall epochs emit distinct milestone events even when a run is reused", async () => {
  let epoch = "epoch-1";
  const dedupeKeys = [];
  const prisma = {
    backfillJob: {
      findUnique: async () => ({ payloadJson: { fullBackfillEpoch: epoch } }),
    },
    activityEvent: {
      create: async ({ data }) => { dedupeKeys.push(data.dedupeKey); return data; },
    },
  };
  const input = {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
    type: "first_insight_shown",
    entityId: "reused-run-1",
  };
  await recordFastOnboardingMilestone(prisma, input);
  epoch = "epoch-2";
  await recordFastOnboardingMilestone(prisma, input);
  assert.deepEqual(dedupeKeys, [
    "first_insight_shown:epoch-1:reused-run-1",
    "first_insight_shown:epoch-2:reused-run-1",
  ]);
});

test("retrying a failed agentic recommendation creates a fresh run and requeues the worker with provenance", async () => {
  const calls = [];
  const baseSnapshotHash = "base-snapshot-hash";
  const failedRun = {
    id: "run-failed",
    merchantId: "merchant-1",
    shopId: "shop-1",
    status: "failed",
    sourceMode: "agentic",
    snapshotHash: baseSnapshotHash,
    promptVersion: "agentic-recommendation-snapshot-v1",
    schemaVersion: "agentic-recommendation-schema-v1",
    safeErrorCode: "agentic_recommendation_validation_failed",
    lastError: "Recommendation cited an unsupported belief id.",
    result: {
      runtime: "agentic_shopify",
      status: "VALIDATION_FAILED",
      blocker: "Recommendation cited an unsupported belief id.",
      diagnostics: {
        retrievedOperations: ["collectionCreate", "collectionAddProducts"],
        shopifyReads: [{ operation: "products", ok: true, status: "OK" }],
        feasibleInterventions: ["Create a collection"],
      },
      trace: {
        turns: [{ status: "RECOMMEND_ACTION", toolCallCount: 0 }],
        toolResults: [
          {
            tool: "recommendation_validation",
            ok: false,
            message: "Recommendation cited an unsupported belief id.",
            error: { code: "INVALID_RECOMMENDATION" },
          },
        ],
      },
    },
    updatedAt: new Date("2026-08-21T13:47:29.905Z"),
  };
  const runs = [failedRun];
  const prisma = {
    merchantGoalRun: {
      findFirst: async () => ({
        id: "goal-run-1",
        status: "completed",
        _count: { horizons: 3 },
        horizons: [
          { id: "goal-1", horizon: "threeMonths", title: "Grow revenue", description: "Revenue", supportingBeliefIds: ["belief-1"] },
          { id: "goal-2", horizon: "sixMonths", title: "Improve repeat purchase", description: "Repeat", supportingBeliefIds: ["belief-1"] },
          { id: "goal-3", horizon: "twelveMonths", title: "Improve merchandising", description: "Merchandising", supportingBeliefIds: ["belief-1"] },
        ],
      }),
    },
    merchantInsightRun: {
      findFirst: async () => ({
        id: "insight-run-1",
        status: "completed",
        findings: [],
      }),
    },
    storeUnderstandingRun: {
      findFirst: async () => ({
        id: "understanding-1",
        status: "completed",
      }),
    },
    merchantMemoryBelief: {
      findFirst: async () => ({
        id: "priority-1",
        key: "preferences.optimisation_priority",
        value: { option: "revenue", label: "Grow revenue", echo: "revenue comes first" },
      }),
      findMany: async () => [
        {
          id: "belief-1",
          key: "merchant.repeat_purchase_goal",
          category: "goals",
          label: "Repeat purchase matters",
          value: { text: "Repeat purchase matters." },
          valueType: "structured",
          status: "inferred",
          precedence: 40,
          confidence: "0.9000",
          evidence: [],
        },
      ],
    },
    merchantPlanRecommendation: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    merchantPlanRun: {
      count: async () => runs.length,
      findFirst: async ({ where }) => {
        if (where.id) return runs.find((run) => run.id === where.id) ?? null;
        return runs.find((run) => {
          if (where.merchantId && run.merchantId !== where.merchantId) return false;
          if (where.shopId && run.shopId !== where.shopId) return false;
          if (where.sourceMode && run.sourceMode !== where.sourceMode) return false;
          if (where.status?.in && !where.status.in.includes(run.status)) return false;
          return true;
        }) ?? null;
      },
      create: async ({ data }) => {
        const row = {
          ...data,
          id: "run-retry",
          createdAt: new Date("2026-08-21T14:50:00.000Z"),
          updatedAt: new Date("2026-08-21T14:50:00.000Z"),
        };
        runs.unshift(row);
        calls.push(["merchantPlanRun.create", row]);
        return row;
      },
      update: async ({ where, data }) => {
        const row = runs.find((run) => run.id === where.id);
        Object.assign(row, data);
        calls.push(["merchantPlanRun.update", { where, data }]);
        return row;
      },
    },
    backfillJob: {
      findUnique: async () => ({
        payloadJson: { onboardingEpoch: "epoch-1" },
        status: "succeeded",
        jobType: "merchant_memory_bootstrap",
      }),
      findMany: async () => [],
      upsert: async (args) => {
        calls.push(["backfillJob.upsert", args]);
        return { id: "job-1", ...args.create, ...args.update };
      },
    },
    shop: {
      findUnique: async () => ({ onboardingMetadata: { fastOnboardingStage: "context" } }),
      update: async (args) => {
        calls.push(["shop.update", args]);
        return args.data;
      },
    },
  };

  const result = await retryFastOnboarding(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "jefe-local-store.myshopify.com",
    target: "merchant_plan",
  });

  const createdRun = calls.find(([name]) => name === "merchantPlanRun.create")?.[1];
  const queuedJob = calls.find(([name]) => name === "backfillJob.upsert")?.[1];

  assert.equal(result.ok, true);
  assert.equal(createdRun.id, "run-retry");
  assert.notEqual(createdRun.snapshotHash, failedRun.snapshotHash);
  assert.equal(createdRun.result.retryOfRunId, "run-failed");
  assert.equal(createdRun.result.onboardingEpoch, "epoch-1");
  assert.equal(createdRun.result.attemptNumber, 2);
  assert.equal(createdRun.result.baseSnapshotHash.length, 64);
  assert.equal(queuedJob.create.payloadJson.runId, "run-retry");
  assert.equal(queuedJob.create.payloadJson.retryOfRunId, "run-failed");
  assert.equal(queuedJob.create.payloadJson.onboardingEpoch, "epoch-1");
  assert.equal(queuedJob.create.payloadJson.attemptNumber, 2);
  assert.equal(queuedJob.create.payloadJson.reason, "merchant_plan_retry");
});

test("applied or rejected execution rows never render executable approval wording", () => {
  for (const status of ["applied", "rejected", "failed"]) {
    const recommendation = shapeRecommendation({
      id: `rec-${status}`,
      merchantId: "merchant-1",
      shopId: "shop-1",
      runId: "run-1",
      title: "Recommendation",
      summary: "Summary",
      whyThisAction: "Why",
      startToday: "Track it",
      expectedBenefit: "Benefit",
      successSignal: {},
      reviewStatus: "accepted",
      outcomeStatus: "pending",
      workflows: [
        {
          steps: [
            {
              actionExecutions: [
                {
                  merchantId: "merchant-1",
                  shopId: "shop-1",
                  recommendationStepId: `step-${status}`,
                  actionType: "price_markdown",
                  resolvedMode: "approve",
                  status,
                  runId: "action-1",
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(recommendation.executable, false);
    assert.equal(recommendation.approvalLabel, "Track this for me");
  }
});

test("agentic onboarding CTA opens one unaccepted Action Chat without legacy review or Shopify writes", async () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const recommendation = {
    id: "rec-agentic",
    merchantId: "merchant-1",
    shopId: "shop-1",
    sourceMode: "agentic",
    reviewStatus: "proposed",
    acceptedAt: null,
    reviewAt: null,
    title: "Create an Available Proven Wines storefront collection",
    summary: "Make proven wines easier to browse.",
    whyThisAction: "Available proven wines are hard to find.",
    startToday: "Open the editable Action.",
    expectedBenefit: "A clearer buying path.",
    successSignal: { description: "A storefront collection exists for available proven wines." },
    workflows: [],
  };
  const action = {
    id: "action-agentic",
    merchantId: "merchant-1",
    shopId: "shop-1",
    title: recommendation.title,
    summary: recommendation.summary,
    status: "proposed",
    sourceRecommendationId: recommendation.id,
    currentActionRunId: null,
    progress: {
      agentic: {
        currentActionRevision: {
          outcome: "Create the collection.",
          scope: { recommendationId: recommendation.id },
          expectedEffects: ["Customers can browse available proven wines."],
        },
      },
    },
    createdAt: now,
    updatedAt: now,
  };
  let actionRow = null;
  const state = {
    conversations: [],
    messages: [],
    events: [],
    activityEvents: [],
    jobs: [],
    handoffs: [],
    operationCalls: [],
    recommendationUpdates: [],
    actionCreates: 0,
    actionUpdates: [],
    actionReads: 0,
    nextConversation: 1,
    nextMessage: 1,
  };
  const prisma = {
    async $transaction(run) {
      return run({ ...prisma, $transaction: undefined });
    },
    merchantPlanRecommendation: {
      findFirst: async () => recommendation,
      updateMany: async (args) => {
        state.recommendationUpdates.push(args);
        throw new Error("agentic onboarding CTA must not accept the recommendation");
      },
      update: async () => {
        throw new Error("agentic onboarding CTA must not update recommendation status");
      },
    },
    merchantAction: {
      findFirst: async ({ where }) => {
        state.actionReads += 1;
        if (where.sourceRecommendationId) {
          return where.sourceRecommendationId === recommendation.id ? actionRow : null;
        }
        return actionRow &&
          where.id === actionRow.id &&
          where.merchantId === actionRow.merchantId &&
          where.shopId === actionRow.shopId
          ? actionRow
          : null;
      },
      create: async ({ data }) => {
        if (actionRow) {
          throw new Error("agentic onboarding CTA must not create a duplicate Action");
        }
        state.actionCreates += 1;
        actionRow = {
          ...action,
          ...data,
          id: action.id,
          currentActionRunId: null,
          createdAt: now,
          updatedAt: now,
        };
        return { id: action.id };
      },
      update: async ({ where, data }) => {
        assert.equal(where.id, action.id);
        state.actionUpdates.push(data);
        actionRow = { ...actionRow, ...data, updatedAt: now };
        return actionRow;
      },
    },
    merchantMemoryConversation: {
      findMany: async ({ where }) =>
        state.conversations.filter(
          (conversation) =>
            conversation.merchantId === where.merchantId &&
            conversation.shopId === where.shopId &&
            conversation.surface === where.surface &&
            conversation.status === where.status &&
            conversation.focusedActionId === where.focusedActionId,
        ),
      findFirst: async ({ where }) =>
        state.conversations.find(
          (conversation) =>
            conversation.id === where.id &&
            conversation.merchantId === where.merchantId &&
            conversation.shopId === where.shopId,
        ) ?? null,
      create: async ({ data }) => {
        const conversation = {
          id: `conversation-${state.nextConversation++}`,
          status: "active",
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        state.conversations.push(conversation);
        return conversation;
      },
      update: async ({ where, data }) => {
        const conversation = state.conversations.find((row) => row.id === where.id);
        Object.assign(conversation, data, { updatedAt: now });
        return conversation;
      },
    },
    merchantMemoryConversationMessage: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const message = {
          id: `message-${state.nextMessage++}`,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        state.messages.push(message);
        return message;
      },
    },
    merchantMemoryEpisode: {
      upsert: async () => ({ id: "episode-1" }),
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return { id: `event-${state.events.length}`, ...data };
      },
    },
    backfillJob: {
      findUnique: async ({ where }) =>
        state.jobs.find(
          (job) =>
            job.shopId === where.shopId_jobType.shopId &&
            job.jobType === where.shopId_jobType.jobType,
        ) ?? null,
      create: async ({ data }) => {
        if (data.jobType === "recommendation_review") {
          throw new Error("agentic onboarding CTA must not queue legacy review");
        }
        const job = { id: `job-${state.jobs.length + 1}`, ...data };
        state.jobs.push(job);
        return job;
      },
      update: async ({ where, data }) => {
        const job = state.jobs.find((row) => row.id === where.id);
        Object.assign(job, data);
        return job;
      },
    },
    shop: {
      findUnique: async () => ({ onboardingMetadata: {} }),
      update: async ({ data }) => data,
    },
    onboardingHandoff: {
      create: async ({ data }) => {
        const handoff = { id: `handoff-${state.handoffs.length + 1}`, ...data };
        state.handoffs.push(handoff);
        return handoff;
      },
    },
    shopifyOperationCall: {
      create: async ({ data }) => {
        state.operationCalls.push(data);
        throw new Error("agentic onboarding CTA must not write through Shopify");
      },
    },
    activityEvent: {
      create: async ({ data }) => {
        state.activityEvents.push(data);
        return { id: `activity-${data.dedupeKey}`, ...data };
      },
    },
  };

  const input = {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "jefe-local-store.myshopify.com",
    recommendationId: recommendation.id,
  };
  const first = await approveOnboardingRecommendation(prisma, input);
  const second = await approveOnboardingRecommendation(prisma, input);

  assert.equal(first.ok, true);
  assert.equal(first.mode, "agentic_open");
  assert.equal(first.actionId, action.id);
  assert.equal(first.recommendationId, recommendation.id);
  assert.equal(first.conversationId, "conversation-1");
  assert.equal(second.ok, true);
  assert.equal(second.conversationId, "conversation-1");
  assert.equal(state.actionCreates, 1);
  assert.equal(state.actionUpdates.length, 1);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].focusedActionId, action.id);
  assert.equal(state.conversations[0].context.recommendationId, recommendation.id);
  assert.equal(state.messages.some((message) => message.recommendationId === recommendation.id), true);
  assert.equal(actionRow.status, "proposed");
  assert.equal(actionRow.progress.agentic.runtime, "shopify_admin_api");
  assert.equal(typeof actionRow.progress.agentic.currentActionRevision, "string");
  assert.equal(actionRow.progress.agentic.semanticAction.whyThisAction, recommendation.whyThisAction);
  assert.equal(actionRow.plan.agentic.semanticAction.materialExpectedEffects.length, 0);
  assert.equal(actionRow.progress.agentic.acceptedActionRevision, undefined);
  assert.equal(state.recommendationUpdates.length, 0);
  assert.equal(state.operationCalls.length, 0);
  assert.equal(
    state.jobs.some((job) => job.jobType === "recommendation_review"),
    false,
  );
  assert.equal(
    state.activityEvents.some((event) => event.type === "recommendation_action_opened"),
    true,
  );
  assert.equal(
    state.activityEvents.some((event) => event.type === "recommendation_approved"),
    false,
  );
});

test("approving a tracked onboarding recommendation unlocks the first workflow step", async () => {
  const calls = [];
  const steps = [
    {
      id: "s1",
      orderIndex: 0,
      title: "Review",
      mode: "assist",
      status: "draft",
      dependsOnStepIds: [],
      merchantId: "merchant-1",
      shopId: "shop-1",
      workflowId: "wf-1",
    },
    {
      id: "s2",
      orderIndex: 1,
      title: "Next",
      mode: "assist",
      status: "draft",
      dependsOnStepIds: ["s1"],
      merchantId: "merchant-1",
      shopId: "shop-1",
      workflowId: "wf-1",
    },
  ];
  const recommendation = {
    id: "rec-1",
    merchantId: "merchant-1",
    shopId: "shop-1",
    sourceMode: "full",
    reviewStatus: "proposed",
    acceptedAt: null,
    reviewAt: new Date("2026-08-20T10:00:00.000Z"),
    workflows: [{ id: "wf-1", steps }],
  };
  const tx = {
    merchantPlanRecommendation: {
      updateMany: async (args) => {
        calls.push(["recommendation.updateMany", args]);
        return { count: 1 };
      },
    },
    merchantRecommendationWorkflow: {
      updateMany: async (args) => {
        calls.push(["workflow.updateMany", args]);
        return { count: 1 };
      },
      findFirst: async () => ({ id: "wf-1" }),
    },
    merchantRecommendationStep: {
      findMany: async () => steps,
      updateMany: async ({ where, data }) => {
        calls.push(["step.updateMany", { where, data }]);
        const rows = steps.filter((row) => !where.id || row.id === where.id);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantAction: {
      findFirst: async () => ({ id: "a1" }),
    },
    shop: {
      findUnique: async () => ({ onboardingMetadata: {} }),
      update: async (args) => {
        calls.push(["shop.update", args]);
        return args.data;
      },
    },
    onboardingHandoff: {
      create: async (args) => ({ id: "handoff-1", ...args.data }),
    },
  };
  const prisma = {
    merchantPlanRecommendation: {
      findFirst: async () => recommendation,
    },
    backfillJob: {
      findUnique: async () => ({
        id: "review-job",
        status: "queued",
        runAfter: new Date("2026-08-21T10:00:00.000Z"),
        payloadJson: {},
      }),
      update: async (args) => {
        calls.push(["backfillJob.update", args]);
        return args.data;
      },
    },
    activityEvent: {
      upsert: async () => ({ id: "activity-1" }),
      create: async () => ({ id: "activity-1" }),
    },
    $transaction: async (callback) => callback(tx),
  };

  const result = await approveOnboardingRecommendation(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "wine-test.myshopify.com",
    recommendationId: "rec-1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.find(([name]) => name === "workflow.updateMany")?.[1], {
    where: {
      recommendationId: "rec-1",
      merchantId: "merchant-1",
      shopId: "shop-1",
      status: "draft",
    },
    data: { status: "active" },
  });
  assert.equal(steps[0].status, "ready");
  assert.equal(steps[1].status, "waiting");
  assert.equal(
    calls.some(([name, args]) => name === "step.updateMany" && args?.data?.status === "pending"),
    false,
  );
});

