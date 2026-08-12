import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildEvidenceContracts,
  reconcileBootstrapIfFullMemoryReady,
  resolveBootstrapGenerationPhase,
} from "../app/lib/onboarding/bootstrap.server.js";
import { parseBootstrapOutput } from "../app/lib/onboarding/bootstrap-schema.server.js";
import { reviewDueRecommendations } from "../app/lib/onboarding/recommendation-review.server.js";
import { reconcileBootstrapRecommendationsAfterFullRefresh } from "../app/lib/onboarding/reconciliation.server.js";
import { upsertDerivedBelief } from "../app/lib/merchant-memory/service.server.js";
import {
  classifyFailure,
  contextFromBelief,
  getFastOnboardingExperience,
  recordFastOnboardingMilestone,
  shapeFullLearning,
  shapeRecommendation,
} from "../app/lib/onboarding/fast-onboarding.server.js";
import {
  ensureMerchantBootstrapQueued,
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
const bootstrapSource = fs.readFileSync(
  new URL("../app/lib/onboarding/bootstrap.server.js", import.meta.url),
  "utf8",
);
const workerSource = fs.readFileSync(
  new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
  "utf8",
);
const querySource = fs.readFileSync(
  new URL("../app/lib/shopify/queries.server.js", import.meta.url),
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

function belief(id, key, value) {
  return { id, key, value, confidence: "0.8", updatedAt: new Date(0), evidence: [] };
}

const baseBeliefs = [
  belief("low", "inventory.low_cover_products.trailing_30d", { items: [{ title: "Kettle", daysOfCoverUpperBound: 8 }] }),
  belief("risk", "inventory.at_risk_stockout_count.trailing_30d", { count: 1 }),
  belief("inventory", "data.inventory_variant_coverage", { ratio: 0.9 }),
  belief("fresh", "data.inventory_freshness_hours_p90", { number: 12 }),
  belief("linked", "data.line_item_product_link_coverage", { ratio: 0.98 }),
  belief("variant-linked", "data.line_item_variant_link_coverage", { ratio: 0.97 }),
  belief("priced", "data.priced_order_coverage", { ratio: 1 }),
  belief("currency", "data.currency_consistency", { currencyCount: 1, dominantShare: 1 }),
  belief("share", "products.top_product_revenue_share.trailing_90d", { percentage: 42 }),
  belief("seller", "products.bestseller_by_revenue.trailing_90d", { title: "Kettle" }),
  belief("discount", "business.discount_depth.trailing_90d", { percentage: 12 }),
];

test("bootstrap contracts reject period-wide claims on an incomplete window", () => {
  const contracts = buildEvidenceContracts(baseBeliefs, { completeRequestedWindow: false, inventoryComplete: true, lineItemsComplete: true });
  assert.deepEqual(contracts.map((contract) => contract.key), ["stockout_protection"]);
});

test("complete pricing, currency and linkage unlock only supported recent-window contracts", () => {
  const contracts = buildEvidenceContracts(baseBeliefs, { completeRequestedWindow: true, inventoryComplete: true, lineItemsComplete: true });
  assert.deepEqual(
    contracts.map((contract) => contract.key),
    ["stockout_protection", "sales_concentration", "discount_review"],
  );
  assert.equal(contracts.some((contract) => contract.key.includes("dead_stock")), false);
});

test("stockout contract requires fresh linked inventory", () => {
  const stale = baseBeliefs.map((row) =>
    row.key === "data.inventory_freshness_hours_p90"
      ? belief("fresh", row.key, { number: 96 })
      : row,
  );
  const contracts = buildEvidenceContracts(stale, { completeRequestedWindow: false, inventoryComplete: true, lineItemsComplete: true });
  assert.equal(contracts.some((contract) => contract.key === "stockout_protection"), false);
});

test("stockout contract rejects a truncated inventory-level connection", () => {
  const contracts = buildEvidenceContracts(baseBeliefs, {
    completeRequestedWindow: false,
    inventoryComplete: false,
    lineItemsComplete: true,
  });
  assert.equal(contracts.some((contract) => contract.key === "stockout_protection"), false);
});

test("all contracts reject a truncated nested line-item connection", () => {
  const contracts = buildEvidenceContracts(baseBeliefs, {
    completeRequestedWindow: true,
    inventoryComplete: true,
    lineItemsComplete: false,
  });
  assert.deepEqual(contracts, []);
});

test("bootstrap reads an honest 90-day window and completeness-gates sibling inventory", () => {
  assert.match(bootstrapSource, /BOOTSTRAP_LOOKBACK_DAYS = 90/);
  assert.match(querySource, /\.\.\. on Product[\s\S]*variants\(first: 250\)[\s\S]*pageInfo \{ hasNextPage \}/);
  assert.match(bootstrapSource, /product\.variants\?\.pageInfo\?\.hasNextPage !== true/);
  assert.match(bootstrapSource, /variant\.inventoryItem\?\.inventoryLevels\?\.pageInfo\?\.hasNextPage !== true/);
});

test("live worker has an independent bootstrap lane", () => {
  assert.match(workerSource, /const bootstrapPrisma = createWorkerPrismaClient\(\) \?\? prisma/);
  assert.match(workerSource, /jobTypes: \[[\s\S]*MERCHANT_BOOTSTRAP_JOB_TYPE[\s\S]*BOOTSTRAP_ALTERNATIVE_JOB_TYPE/);
  assert.match(workerSource, /excludeJobTypes: \[[\s\S]*MERCHANT_BOOTSTRAP_JOB_TYPE[\s\S]*BOOTSTRAP_ALTERNATIVE_JOB_TYPE/);
  assert.match(workerSource, /void generalTick\(\);[\s\S]*void bootstrapTick\(\);/);
});

test("bootstrap generation accepts one cited track-only opportunity", () => {
  const contract = { key: "stockout_protection", beliefIds: ["low"], beliefKeys: ["inventory.low_cover_products.trailing_30d"] };
  const parsed = parseBootstrapOutput(
    {
      opportunities: [
        {
          contractKey: contract.key,
          headline: "One product needs attention",
          explanation: "The recent evidence points to a stock risk.",
          supportingBeliefIds: ["low"],
          recommendationHeadline: "Watch the stock signal",
          whyItMatters: "Running out would interrupt current demand.",
          whatIllDo: "I’ll monitor the stock signal and flag a decision.",
          howWellKnow: "The product remains available while demand continues.",
          expectedBenefit: "A better-timed replenishment decision.",
          confidence: "medium",
          caveat: "This uses the recent window.",
        },
      ],
    },
    { contracts: [contract], beliefs: [belief("low", contract.beliefKeys[0], {})] },
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.opportunities.length, 1);
});

test("bootstrap generation rejects a fake external-write capability", () => {
  const contract = { key: "stockout_protection", beliefIds: ["low"], beliefKeys: [] };
  const parsed = parseBootstrapOutput(
    {
      opportunities: [{
        contractKey: contract.key,
        headline: "Stock needs attention",
        explanation: "Recent evidence points to a risk.",
        supportingBeliefIds: ["low"],
        recommendationHeadline: "Replenish now",
        whyItMatters: "Availability matters.",
        whatIllDo: "I’ll raise a purchase order and pause the promotion.",
        howWellKnow: "The product stays available.",
        expectedBenefit: "Continuity.",
        confidence: "medium",
      }],
    },
    { contracts: [contract], beliefs: [belief("low", "inventory.low_cover_products.trailing_30d", {})] },
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /capability/i);
});

test("bootstrap generation rejects merchant-facing percentage figures", () => {
  const contract = { key: "sales_concentration", beliefIds: ["share"], beliefKeys: [] };
  const parsed = parseBootstrapOutput(
    {
      opportunities: [{
        contractKey: contract.key,
        headline: "One product drives 42% of revenue",
        explanation: "The recent evidence is concentrated.",
        supportingBeliefIds: ["share"],
        recommendationHeadline: "Track concentration",
        whyItMatters: "A narrow sales mix creates exposure.",
        whatIllDo: "I’ll monitor the product mix.",
        howWellKnow: "The sales mix broadens.",
        expectedBenefit: "A more resilient revenue mix.",
        confidence: "medium",
      }],
    },
    { contracts: [contract], beliefs: [belief("share", "products.top_product_revenue_share.trailing_90d", { percentage: 42 })] },
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /percentage/i);
});

test("bootstrap generation applies the shared semantic safe-copy guard", () => {
  const contract = { key: "stockout_protection", beliefIds: ["low"], beliefKeys: [] };
  const parsed = parseBootstrapOutput(
    {
      opportunities: [{
        contractKey: contract.key,
        headline: "Stock needs attention",
        explanation: "Recent evidence points to low cover.",
        supportingBeliefIds: ["low"],
        recommendationHeadline: "Track the risk",
        whyItMatters: "This creates supply chain and customer-base risk.",
        whatIllDo: "I’ll monitor the stock signal.",
        howWellKnow: "Availability remains stable.",
        expectedBenefit: "A better-timed stock decision.",
        confidence: "medium",
      }],
    },
    { contracts: [contract], beliefs: [belief("low", "inventory.low_cover_products.trailing_30d", {})] },
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unsupported/i);
});

test("the UI keeps the exact beats, one dominant result and honest chrome", () => {
  assert.match(componentSource, /setTimeout\(\(\) => setAcknowledgementFinished\(true\), 1700\)/);
  assert.match(componentSource, /const handoffUrl = data\.handoffUrl;[\s\S]*setTimeout\(\(\) => navigate\(handoffUrl\), 1300\)/);
  assert.match(componentSource, /insight\.evidence\.slice\(0, 3\)/);
  assert.match(componentSource, /Boolean\(experience\.context\)[\s\S]*!experience\.failure/);
  assert.match(componentSource, /I won’t force a recommendation the evidence can’t support/);
  assert.match(serviceSource, /Track this for me/);
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

test("loader safety enqueue preserves a completed bootstrap job", async () => {
  const existing = {
    id: "job-1",
    status: "succeeded",
    payloadJson: { onboardingEpoch: "epoch-1" },
    resultJson: { phase: "ready" },
  };
  const prisma = {
    backfillJob: { findUnique: async () => existing },
    shopBackfillStatus: { upsert: async () => assert.fail("completed bootstrap must not be reset") },
  };
  const result = await ensureMerchantBootstrapQueued(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
  });
  assert.equal(result, existing);
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

test("tracked review never claims a measured outcome without a typed evaluator", async () => {
  const updates = [];
  const due = [
    { id: "rec-supported", supportingBeliefIds: ["belief-1"] },
    { id: "rec-thin", supportingBeliefIds: ["belief-2"] },
  ];
  const prisma = {
    merchantPlanRecommendation: {
      findMany: async () => due,
      update: async (args) => { updates.push(args); return args.data; },
      findFirst: async () => null,
    },
  };
  const result = await reviewDueRecommendations(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  assert.equal(result.reviewed, 2);
  assert.deepEqual(updates.map((row) => row.data.outcomeStatus), ["insufficient", "insufficient"]);
  assert.equal(updates.every((row) => row.data.outcome.result === "success_signal_not_yet_measurable"), true);
  assert.equal(updates.every((row) => row.data.reviewAt > row.data.outcomeMeasuredAt), true);
});

test("bootstrap failure does not downgrade completed full learning", () => {
  const statuses = [
    ...["products", "inventory", "orders", "customers", "refunds"].map((domain) => ({ domain, status: "complete", lastError: null })),
    { domain: "bootstrap", status: "failed", lastError: "model output invalid" },
  ];
  assert.equal(shapeFullLearning(statuses, [{ jobType: "backfill_finalize", status: "succeeded" }]).state, "complete");
});

test("ready bootstrap with only a superseded recommendation is a terminal view-model fallback", async () => {
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
      findMany: async () => [],
    },
    backfillJob: {
      findUnique: async () => ({
        id: "bootstrap-1",
        status: "succeeded",
        payloadJson: { onboardingEpoch: "epoch-1" },
        resultJson: { phase: "ready" },
      }),
      findMany: async () => [],
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
          id: "superseded-1",
          reviewStatus: "superseded",
          sourceMode: "bootstrap",
          supportingInsightIds: [],
          supportingBeliefIds: [],
          run: { insightRunId: "insight-1", result: {} },
          evidenceSnapshot: null,
          actionExecution: null,
        },
      ],
    },
    activityEvent: { create: async ({ data }) => data },
  };

  const experience = await getFastOnboardingExperience(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
  });

  assert.equal(experience.stage, "context");
  assert.equal(experience.recommendation, null);
  assert.equal(experience.failure.type, "insufficient");
  assert.match(experience.failure.message, /no longer supports/i);
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

test("bootstrap cannot overwrite a stronger full-memory inference", async () => {
  const existing = {
    id: "belief-full",
    merchantId: "merchant-1",
    shopId: "shop-1",
    key: "data.currency_consistency",
    category: "data",
    value: { currencyCount: 1 },
    valueType: "object",
    status: "inferred",
    confidence: "1",
    precedence: 20,
    derivationVersion: "v1",
    derivationSourceMode: "full",
  };
  let beliefWrites = 0;
  const prisma = {
    merchantMemoryBelief: {
      findFirst: async () => existing,
      update: async () => { beliefWrites += 1; },
      updateMany: async () => { beliefWrites += 1; return { count: 1 }; },
    },
    merchantMemoryBeliefHistory: { create: async ({ data }) => data },
  };
  const result = await upsertDerivedBelief(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    category: "data",
    key: existing.key,
    value: { currencyCount: 2 },
    valueType: "object",
    confidence: 0.7,
    confidenceReason: "bounded read",
    derivationVersion: "v1",
    evidence: {
      sourceType: "canonical",
      evidenceType: "derived",
      summary: "Bootstrap evidence",
      metadata: { sourceMode: "bootstrap" },
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.belief.value.currencyCount, 1);
  assert.equal(beliefWrites, 0);
});

test("parallel derivation lanes serialize first belief publication", async () => {
  let storedBelief = null;
  let createCount = 0;
  let lockCount = 0;
  let transactionTail = Promise.resolve();
  const tx = {
    $queryRawUnsafe: async () => {
      lockCount += 1;
      return [{ pg_advisory_xact_lock: null }];
    },
    merchantMemoryBelief: {
      findFirst: async () => storedBelief,
      create: async ({ data }) => {
        createCount += 1;
        storedBelief = {
          id: "belief-1",
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return storedBelief;
      },
      update: async ({ data }) => {
        storedBelief = { ...storedBelief, ...data, updatedAt: new Date() };
        return storedBelief;
      },
    },
    merchantMemoryBeliefHistory: { create: async ({ data }) => data },
    merchantMemoryEvidence: { create: async ({ data }) => data },
  };
  const prisma = {
    $transaction(callback) {
      const transaction = transactionTail.then(() => callback(tx));
      transactionTail = transaction.catch(() => undefined);
      return transaction;
    },
  };
  const input = {
    merchantId: "merchant-1",
    shopId: "shop-1",
    category: "data",
    key: "data.currency_consistency",
    value: { currencyCount: 1 },
    valueType: "object",
    confidence: 0.8,
    confidenceReason: "canonical order evidence",
    evidence: {
      sourceType: "canonical",
      evidenceType: "derived",
      summary: "Currency evidence",
      metadata: { sourceMode: "full" },
    },
  };

  await Promise.all([
    upsertDerivedBelief(prisma, input),
    upsertDerivedBelief(prisma, input),
  ]);

  assert.equal(lockCount, 2);
  assert.equal(createCount, 1);
  assert.equal(storedBelief.id, "belief-1");
});

test("a late bootstrap publication reconciles after full memory is complete", async () => {
  const updates = [];
  const prisma = {
    shopBackfillStatus: {
      findUnique: async () => ({ status: "complete" }),
    },
    merchantPlanRecommendation: {
      findMany: async () => [
        {
          id: "late-bootstrap-recommendation",
          reviewStatus: "proposed",
          run: { result: { contractKey: "discount_review" } },
          actionExecution: null,
        },
      ],
      update: async (args) => {
        updates.push(args);
        return args.data;
      },
    },
    merchantMemoryBelief: { findMany: async () => [] },
  };

  const result = await reconcileBootstrapIfFullMemoryReady(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.superseded, 1);
  assert.deepEqual(updates, [
    {
      where: { id: "late-bootstrap-recommendation" },
      data: { reviewStatus: "superseded" },
    },
  ]);
});

test("an unsupported late bootstrap result becomes a terminal honest fallback", async () => {
  const prisma = {
    shopBackfillStatus: {
      findUnique: async () => ({ status: "complete" }),
    },
    merchantPlanRecommendation: {
      findMany: async () => [
        {
          id: "unsupported-recommendation",
          reviewStatus: "proposed",
          run: { result: { contractKey: "discount_review" } },
          actionExecution: null,
        },
      ],
      update: async ({ data }) => data,
      findFirst: async () => null,
    },
    merchantMemoryBelief: { findMany: async () => [] },
  };

  assert.equal(
    await resolveBootstrapGenerationPhase(
      prisma,
      { merchantId: "merchant-1", shopId: "shop-1" },
      "completed",
      ["unsupported-recommendation"],
    ),
    "insufficient_evidence",
  );
});

test("a supported current finding cannot make a superseded alternative look ready", async () => {
  const recommendations = [
    {
      id: "supported-a",
      reviewStatus: "proposed",
      run: { result: { contractKey: "stockout_protection" } },
      actionExecution: null,
    },
    {
      id: "unsupported-b",
      reviewStatus: "proposed",
      run: { result: { contractKey: "discount_review" } },
      actionExecution: null,
    },
  ];
  const prisma = {
    shopBackfillStatus: { findUnique: async () => ({ status: "complete" }) },
    merchantPlanRecommendation: {
      findMany: async () => recommendations,
      update: async ({ where, data }) => {
        Object.assign(
          recommendations.find((row) => row.id === where.id),
          data,
        );
        return data;
      },
      findFirst: async ({ where }) =>
        recommendations.find(
          (row) =>
            where.id.in.includes(row.id) &&
            row.reviewStatus === where.reviewStatus,
        ) ?? null,
    },
    merchantMemoryBelief: {
      findMany: async () =>
        baseBeliefs
          .filter(
            (row) =>
              ![
                "products.top_product_revenue_share.trailing_90d",
                "products.bestseller_by_revenue.trailing_90d",
                "business.discount_depth.trailing_90d",
              ].includes(row.key),
          )
          .map((row) => ({ ...row, status: "inferred" })),
    },
  };

  const phase = await resolveBootstrapGenerationPhase(
    prisma,
    { merchantId: "merchant-1", shopId: "shop-1" },
    "completed",
    ["unsupported-b"],
  );

  assert.equal(phase, "insufficient_evidence");
  assert.equal(recommendations[0].reviewStatus, "proposed");
  assert.equal(recommendations[1].reviewStatus, "superseded");
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

test("a reinstall reset creates a new onboarding epoch", async () => {
  const payloads = [];
  const prisma = {
    backfillJob: {
      findUnique: async () => ({ id: "bootstrap", payloadJson: { onboardingEpoch: "old" } }),
      update: async ({ data }) => { payloads.push(data.payloadJson); return data; },
    },
    shopBackfillStatus: { upsert: async ({ data }) => data },
  };
  const input = { merchantId: "merchant-1", shopId: "shop-1", shopDomain: "test.myshopify.com", reset: true };
  await ensureMerchantBootstrapQueued(prisma, input);
  await ensureMerchantBootstrapQueued(prisma, input);
  assert.notEqual(payloads[0].onboardingEpoch, "old");
  assert.notEqual(payloads[0].onboardingEpoch, payloads[1].onboardingEpoch);
});

test("reinstall epochs emit distinct milestone events even when a run is reused", async () => {
  let epoch = "epoch-1";
  const dedupeKeys = [];
  const prisma = {
    backfillJob: {
      findUnique: async () => ({ payloadJson: { onboardingEpoch: epoch } }),
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

test("invalid model output is a retryable generation failure", () => {
  const failure = classifyFailure(
    { status: "complete", metadata: { phase: "generation_failed" } },
    { status: "succeeded" },
  );
  assert.equal(failure.type, "retryable");
  assert.match(failure.message, /retry/i);
  assert.match(bootstrapSource, /invalid_model_output/);
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
      actionExecution: {
        merchantId: "merchant-1",
        shopId: "shop-1",
        sourceRecommendationId: `rec-${status}`,
        actionType: "price_markdown",
        resolvedMode: "approve",
        status,
        runId: "action-1",
      },
    });
    assert.equal(recommendation.executable, false);
    assert.equal(recommendation.approvalLabel, "Track this for me");
  }
});

test("full-memory reconciliation re-runs contracts and preserves applied action history", async () => {
  const updates = [];
  const currentBeliefs = baseBeliefs
    .filter((row) => row.key !== "business.discount_depth.trailing_90d")
    .map((row) => ({ ...row, status: "inferred" }));
  const prisma = {
    merchantPlanRecommendation: {
      findMany: async () => [
        { id: "supported", reviewStatus: "proposed", supportingBeliefIds: [], run: { result: { contractKey: "stockout_protection" } }, actionExecution: null },
        { id: "proposed", reviewStatus: "proposed", supportingBeliefIds: [], run: { result: { contractKey: "discount_review" } }, actionExecution: null },
        { id: "accepted", reviewStatus: "accepted", supportingBeliefIds: [], run: { result: { contractKey: "discount_review" } }, actionExecution: null },
        { id: "applied", reviewStatus: "accepted", supportingBeliefIds: [], run: { result: { contractKey: "discount_review" } }, actionExecution: { status: "applied" } },
      ],
      update: async (args) => { updates.push(args); return args.data; },
    },
    merchantMemoryBelief: { findMany: async () => currentBeliefs },
  };
  const result = await reconcileBootstrapRecommendationsAfterFullRefresh(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  assert.deepEqual(result, { recommendations: 4, superseded: 1, needsReview: 1 });
  assert.deepEqual(updates.map((row) => [row.where.id, row.data.reviewStatus]), [
    ["proposed", "superseded"],
    ["accepted", "needs_review"],
  ]);
});
