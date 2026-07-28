import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createMockLlmProvider } from "../app/lib/llm/provider.server.js";
import { buildMerchantGoalSnapshot } from "../app/lib/merchant-goals/candidates.server.js";
import { parseAndValidateMerchantGoalsOutput } from "../app/lib/merchant-goals/schema.server.js";
import {
  ensureMerchantGoalsQueued,
  generateMerchantGoals,
  getLatestMerchantGoals,
  getMerchantGoalsExperience,
  processMerchantGoalMessage,
} from "../app/lib/merchant-goals/service.server.js";
import {
  GOAL_HORIZONS,
  GOAL_RUN_STATUS,
  MERCHANT_GOALS_JOB_TYPE,
} from "../app/lib/merchant-goals/constants.server.js";
import { upsertDerivedBelief } from "../app/lib/merchant-memory/service.server.js";

const databaseUrl = process.env.DATABASE_URL;
const workerSource = fs.readFileSync(
  new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
  "utf8",
);
const routeSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const promptSource = fs.readFileSync(
  new URL("../app/lib/merchant-goals/prompt.server.js", import.meta.url),
  "utf8",
);

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("goal snapshot is bounded to Merchant Memory, Insights and goal coaching", async () => {
  const prisma = {
    merchantMemoryBelief: {
      async findMany() {
        return [
          beliefFixture({
            id: "belief-1",
            key: "business.description",
            value: { text: "Wine store for jane@example.com" },
            evidenceSummary: "Merchant said contact +44 7700 900123.",
            sourceType: "merchant_input",
          }),
          beliefFixture({
            id: "prior-goal-belief",
            key: "goals.generated.six_months",
            category: "goals",
            value: { title: "Old generated goal" },
            evidenceSummary: "Previous generated goal.",
            sourceType: "merchant_goals",
          }),
        ];
      },
    },
    merchantMemoryRefreshRun: {
      async findFirst() {
        return { id: "memory-run-1", completedAt: new Date("2026-07-26T09:00:00Z") };
      },
    },
    merchantInsightRun: {
      async findFirst() {
        return {
          id: "insight-run-1",
          findings: [
            {
              id: "finding-1",
              title: "Revenue has a stock dependency",
              finding: "A few products matter disproportionately.",
              whyItMatters: "Buying choices shape cash tied up in stock.",
              category: "inventory",
              confidence: "high",
              reviewStatus: "confirmed",
              supportingBeliefIds: ["belief-1", "stale-belief"],
            },
          ],
        };
      },
    },
    merchantMemoryEvidence: {
      async findMany() {
        return [
          {
            id: "evidence-1",
            sourceType: "merchant_goals",
            evidenceType: "merchant_goal_coaching",
            summary: "Merchant coached goals: prioritise profit.",
            observedAt: new Date("2026-07-26T10:00:00Z"),
          },
        ];
      },
    },
  };

  const snapshot = await buildMerchantGoalSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  const serialized = JSON.stringify(snapshot.snapshot);

  assert.equal(snapshot.candidateCount, 1);
  assert.equal(snapshot.snapshot.privacy.excludesRawShopifyRecords, true);
  assert.equal(snapshot.beliefIds.includes("prior-goal-belief"), false);
  assert.equal(snapshot.snapshot.insightCount, 1);
  assert.equal(snapshot.snapshot.goalCoaching.length, 1);
  assert.equal(snapshot.snapshot.insights[0].id, undefined);
  assert.deepEqual(snapshot.snapshot.insights[0].supportingBeliefIds, ["belief-1"]);
  assert.equal(serialized.includes("jane@example.com"), false);
  assert.equal(serialized.includes("+44 7700 900123"), false);
  assert.equal(serialized.includes("stale-belief"), false);
  assert.equal(serialized.includes("rawPayload"), false);
});

test("structured goal validation rejects unsupported belief IDs and generic goals", () => {
  const valid = parseAndValidateMerchantGoalsOutput(
    {
      threeMonths: {
        title: "Grow revenue from proven sellers",
        description: "Focus buying and merchandising around the products already carrying demand.",
        supportingBeliefIds: ["belief-1"],
      },
      sixMonths: {
        title: "Increase repeat revenue",
        description: "Use the catalogue shape to create a clearer replenishment path.",
        supportingBeliefIds: ["belief-1"],
      },
      twelveMonths: {
        title: "Expand specialist range growth",
        description: "Use confirmed demand patterns to expand without diluting the store's focus.",
        supportingBeliefIds: ["belief-1"],
      },
    },
    { allowedBeliefIds: new Set(["belief-1"]) },
  );
  const unsupported = parseAndValidateMerchantGoalsOutput(
    {
      threeMonths: {
        title: "Grow revenue from proven sellers",
        description: "Focus buying and merchandising around supported demand.",
        supportingBeliefIds: ["belief-2"],
      },
      sixMonths: {
        title: "Increase repeat revenue",
        description: "Use the catalogue shape to create a clearer replenishment path.",
        supportingBeliefIds: ["belief-1"],
      },
      twelveMonths: {
        title: "Expand specialist range growth",
        description: "Use confirmed demand patterns to expand without diluting focus.",
        supportingBeliefIds: ["belief-1"],
      },
    },
    { allowedBeliefIds: new Set(["belief-1"]) },
  );
  const strategy = parseAndValidateMerchantGoalsOutput(
    {
      threeMonths: {
        title: "Inventory visibility alignment",
        description: "Connect stock visibility across locations so customers can buy available products.",
        supportingBeliefIds: ["belief-1"],
      },
      sixMonths: {
        title: "Inventory value diversification",
        description: "Rebalance the stock mix around proven demand in the catalogue.",
        supportingBeliefIds: ["belief-1"],
      },
      twelveMonths: {
        title: "Tiered assortment optimization",
        description: "Use price tiers to structure the range around customer budgets.",
        supportingBeliefIds: ["belief-1"],
      },
    },
    { allowedBeliefIds: new Set(["belief-1"]) },
  );
  const generic = parseAndValidateMerchantGoalsOutput(
    {
      threeMonths: {
        title: "Increase revenue",
        description: "Increase revenue across the business.",
        supportingBeliefIds: ["belief-1"],
      },
      sixMonths: {
        title: "Grow customers",
        description: "Grow customers through better marketing.",
        supportingBeliefIds: ["belief-1"],
      },
      twelveMonths: {
        title: "Reduce refunds",
        description: "Reduce refunds over the next year.",
        supportingBeliefIds: ["belief-1"],
      },
    },
    { allowedBeliefIds: new Set(["belief-1"]) },
  );

  assert.equal(valid.ok, true);
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /not supplied/);
  assert.equal(strategy.ok, false);
  assert.match(strategy.error, /commercial outcome/);
  assert.equal(generic.ok, false);
  assert.match(generic.error, /generic/);
});

test("getLatestMerchantGoals reads the latest completed run without a snapshot or queueing", async () => {
  const calls = [];
  // Mock prisma implements ONLY merchantGoalRun.findFirst. If the reader tried
  // to rebuild the belief snapshot or queue generation it would touch other
  // models/methods absent here and throw, proving this path is read-only.
  const prisma = {
    merchantGoalRun: {
      async findFirst(args) {
        calls.push(args);
        return {
          id: "goal-run-1",
          status: GOAL_RUN_STATUS.completed,
          beliefSnapshotHash: "hash-1",
          safeErrorCode: null,
          lastError: null,
          completedAt: new Date("2026-07-27T09:00:00Z"),
          failedAt: null,
          supersededAt: null,
          horizons: [
            {
              id: "horizon-1",
              horizon: "threeMonths",
              orderIndex: 1,
              title: "Grow repeat revenue",
              description: "Use supported customer behaviour to build repeat sales.",
              supportingBeliefIds: ["belief-1"],
              memoryBeliefId: "belief-1",
            },
          ],
        };
      },
    },
  };

  const result = await getLatestMerchantGoals(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.status, GOAL_RUN_STATUS.completed);
  assert.equal(calls[0].where.merchantId, "merchant-1");
  assert.equal(calls[0].where.shopId, "shop-1");
  assert.equal("beliefSnapshotHash" in calls[0].where, false);
  assert.deepEqual(calls[0].include, {
    horizons: { orderBy: { orderIndex: "asc" } },
  });
  assert.deepEqual(calls[0].orderBy, { completedAt: "desc" });
  assert.equal(result.selectedRun.horizons.length, 1);
  assert.equal(result.selectedRun.horizons[0].horizon, "threeMonths");

  const empty = await getLatestMerchantGoals(
    { merchantGoalRun: { async findFirst() { return null; } } },
    { merchantId: "merchant-1", shopId: "shop-1" },
  );
  assert.deepEqual(empty, { selectedRun: null });
});

test("goal generation is wired to the async worker and not browser page load", () => {
  assert.equal(MERCHANT_GOALS_JOB_TYPE, "merchant_goals_generate");
  assert.match(workerSource, /MERCHANT_GOALS_JOB_TYPE/);
  assert.match(workerSource, /generateMerchantGoals/);
  assert.match(routeSource, /ensureMerchantGoalsQueued/);
  assert.doesNotMatch(routeSource, /generateMerchantGoals\(/);
});

test("goal prompt asks for commercial outcomes before strategy", () => {
  assert.match(promptSource, /business outcome, not the operating method/);
  assert.match(promptSource, /revenue, growth, repeat purchase, margin, cash/);
  assert.match(promptSource, /Every title must include at least one commercial outcome term/);
  assert.match(promptSource, /short commercial outcome title/);
  assert.match(promptSource, /strategy behind the outcome/);
  assert.match(promptSource, /goalCoaching is present/);
  assert.match(promptSource, /explicit 3, 6 or 12 month objectives/);
  assert.match(promptSource, /supplied KPIs/);
  assert.match(promptSource, /merchant_goal_document_context comes from an uploaded planning document/);
});

test("goals onboarding asks merchants to review generated goals", () => {
  assert.match(
    routeSource,
    /Happy with these goals\? Reply to guide or update them\./,
  );
  assert.match(routeSource, /Tell me what to change about this direction/);
  assert.doesNotMatch(routeSource, /Still thinking/);
});

test("goals onboarding accepts planning document uploads for supported formats", () => {
  assert.match(routeSource, /name="goalsFile"/);
  assert.match(routeSource, /\.pdf,\.docx,\.md,\.markdown,\.txt/);
  assert.match(routeSource, /intent" value="goals\.upload"/);
  assert.match(routeSource, /processMerchantGoalsDocument/);
  assert.match(routeSource, /Already have a business plan\?/);
  assert.match(routeSource, /Upload a document/);
  assert.match(routeSource, /JefeGoalDocumentInput/);
  assert.match(routeSource, /onDrop=\{handleDrop\}/);
  assert.doesNotMatch(routeSource, /Upload goals file/);
  assert.doesNotMatch(routeSource, /Choose file/);
  assert.match(
    fs.readFileSync(
      new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
      "utf8",
    ),
    /pdf-parse[\s\S]*mammoth|mammoth[\s\S]*pdf-parse/,
  );
  assert.match(
    fs.readFileSync(
      new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
      "utf8",
    ),
    /PDFParse[\s\S]*getText[\s\S]*destroy/,
  );
  assert.match(
    fs.readFileSync(
      new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
      "utf8",
    ),
    /goals_document_context/,
  );
  assert.match(routeSource, /success=\{goalsNotice === "file_saved" && !goalUploadError\}/);
  assert.match(routeSource, /regenerating=\{documentUploadRegenerating\}/);
  assert.match(routeSource, /I've updated the proposed goals with this context\./);
  assert.match(
    fs.readFileSync(
      new URL("../app/lib/merchant-goals/service.server.js", import.meta.url),
      "utf8",
    ),
    /goalDirection/,
  );
});

test("merchant goal generation persists horizons and Merchant Memory goals", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Goal persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createGoalFixture(prisma, suffix);
    const queued = await ensureMerchantGoalsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const beliefIds = queued.snapshot.beliefIds;
    const result = await generateMerchantGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: {
          threeMonths: {
            title: "Grow revenue from proven demand",
            description: "Use the strongest product signals to reduce cash tied up in weaker stock.",
            supportingBeliefIds: [beliefIds[0]],
          },
          sixMonths: {
            title: "Increase repeat revenue",
            description: "Make replenishment clearer around products customers already understand.",
            supportingBeliefIds: [beliefIds[1]],
          },
          twelveMonths: {
            title: "Grow the specialist range with discipline",
            description: "Expand from the confirmed catalogue strengths instead of broadening blindly.",
            supportingBeliefIds: [beliefIds[2]],
          },
        },
      }),
      logger: silentLogger,
    });
    const run = await prisma.merchantGoalRun.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
      include: { horizons: true },
    });
    const memoryGoals = await prisma.merchantMemoryBelief.findMany({
      where: { merchantId: merchant.id, shopId: shop.id, category: "goals" },
    });

    assert.equal(result.status, GOAL_RUN_STATUS.completed);
    assert.equal(run.horizons.length, 3);
    assert.equal(memoryGoals.length, 3);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Goals Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("goal generation retries once when model cites unsupported belief IDs", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Goal persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  let calls = 0;
  try {
    const { merchant, shop } = await createGoalFixture(prisma, suffix);
    const queued = await ensureMerchantGoalsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const beliefIds = queued.snapshot.beliefIds;
    const result = await generateMerchantGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: {
        provider: "mock",
        model: "mock-retry",
        enabled: true,
        async generateStructuredJson() {
          calls += 1;
          return {
            json:
              calls === 1
                ? {
                    threeMonths: {
                      title: "Grow revenue from proven demand",
                      description:
                        "Use the strongest product signals to reduce cash tied up in weaker stock.",
                      supportingBeliefIds: ["unsupported-belief"],
                    },
                    sixMonths: {
                      title: "Increase repeat revenue",
                      description:
                        "Make replenishment clearer around products customers already understand.",
                      supportingBeliefIds: [beliefIds[1]],
                    },
                    twelveMonths: {
                      title: "Grow the specialist range with discipline",
                      description:
                        "Expand from the confirmed catalogue strengths instead of broadening blindly.",
                      supportingBeliefIds: [beliefIds[2]],
                    },
                  }
                : {
                    threeMonths: {
                      title: "Grow revenue from proven demand",
                      description:
                        "Use the strongest product signals to reduce cash tied up in weaker stock.",
                      supportingBeliefIds: [beliefIds[0]],
                    },
                    sixMonths: {
                      title: "Increase repeat revenue",
                      description:
                        "Make replenishment clearer around products customers already understand.",
                      supportingBeliefIds: [beliefIds[1]],
                    },
                    twelveMonths: {
                      title: "Grow the specialist range with discipline",
                      description:
                        "Expand from the confirmed catalogue strengths instead of broadening blindly.",
                      supportingBeliefIds: [beliefIds[2]],
                    },
                  },
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
              estimatedInputTokens: 10,
            },
            attempts: 1,
            durationMs: 0,
          };
        },
      },
      logger: silentLogger,
    });

    assert.equal(result.status, GOAL_RUN_STATUS.completed);
    assert.equal(calls, 2);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Goals Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("completed goal runs can be explicitly requeued for document regeneration", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Goal persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createGoalFixture(prisma, suffix);
    const queued = await ensureMerchantGoalsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const beliefIds = queued.snapshot.beliefIds;
    await prisma.merchantGoalRun.update({
      where: { id: queued.run.id },
      data: {
        status: GOAL_RUN_STATUS.completed,
        completedAt: new Date(),
      },
    });
    await prisma.merchantGoalHorizon.createMany({
      data: GOAL_HORIZONS.map((horizon) => ({
        runId: queued.run.id,
        merchantId: merchant.id,
        shopId: shop.id,
        horizon: horizon.key,
        orderIndex: horizon.orderIndex,
        title: `${horizon.months}-month revenue growth`,
        description: "Keep the current goals visible while regeneration is queued.",
        supportingBeliefIds: [beliefIds[horizon.orderIndex - 1]],
      })),
    });
    await prisma.backfillJob.deleteMany({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_GOALS_JOB_TYPE,
      },
    });

    const requeued = await ensureMerchantGoalsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      resetAttempts: true,
    });
    const run = await prisma.merchantGoalRun.findUniqueOrThrow({
      where: { id: queued.run.id },
    });
    const experience = await getMerchantGoalsExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const job = await prisma.backfillJob.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_GOALS_JOB_TYPE,
        status: "queued",
      },
    });

    assert.equal(requeued.status, "queued");
    assert.equal(requeued.run.status, GOAL_RUN_STATUS.queued);
    assert.equal(run.status, GOAL_RUN_STATUS.queued);
    assert.equal(experience.currentRun.status, GOAL_RUN_STATUS.queued);
    assert.equal(experience.selectedRun.status, GOAL_RUN_STATUS.queued);
    assert.equal(experience.selectedRun.horizons.length, 3);
    assert.ok(job);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Goals Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("failed current goal runs are not selected as displayable goals", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Goal persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createGoalFixture(prisma, suffix);
    const queued = await ensureMerchantGoalsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    await prisma.backfillJob.deleteMany({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_GOALS_JOB_TYPE,
      },
    });
    await prisma.merchantGoalRun.update({
      where: { id: queued.run.id },
      data: {
        status: GOAL_RUN_STATUS.failed,
        failedAt: new Date(),
        safeErrorCode: "invalid_model_output",
        lastError: "Goal cited a belief that was not supplied to the model.",
      },
    });

    const experience = await getMerchantGoalsExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });

    assert.equal(experience.currentRun.status, GOAL_RUN_STATUS.failed);
    assert.equal(experience.selectedRun, null);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Goals Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("goal coaching records evidence and queues regeneration", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Goal persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createGoalFixture(prisma, suffix);
    const result = await processMerchantGoalMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      message: "Profitability matters more than international expansion.",
      llmProvider: createMockLlmProvider({
        operation: {
          operationType: "create_merchant_belief",
          targetBeliefKey: "preferences.optimisation_priority",
          targetBeliefId: null,
          category: "preferences",
          proposedValue: { option: "profit" },
          valueType: "enum",
          reason: "Merchant stated a planning priority.",
          merchantStatement: "Profitability matters more than international expansion.",
          confidence: 0.9,
          requiresConfirmation: false,
        },
      }),
      logger: silentLogger,
    });
    const evidence = await prisma.merchantMemoryEvidence.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        evidenceType: "merchant_goal_coaching",
      },
    });
    const job = await prisma.backfillJob.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_GOALS_JOB_TYPE,
        status: "queued",
      },
    });

    assert.equal(result.ok, true);
    assert.ok(evidence);
    assert.ok(job);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Goals Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function beliefFixture({
  id,
  key,
  category = "business",
  value,
  status = "inferred",
  evidenceSummary,
  sourceType = "system_derivation",
}) {
  return {
    id,
    merchantId: "merchant-1",
    shopId: "shop-1",
    category,
    key,
    value,
    valueType: "string",
    status,
    confidence: "0.9000",
    confidenceReason: "Supported by stored evidence.",
    precedence: sourceType === "system_derivation" ? 40 : 80,
    derivationVersion: `${key}@v1`,
    firstObservedAt: new Date("2026-07-26T09:00:00Z"),
    lastObservedAt: new Date("2026-07-26T09:00:00Z"),
    lastEvaluatedAt: new Date("2026-07-26T09:00:00Z"),
    lastConfirmedAt:
      status === "merchant_corrected" ? new Date("2026-07-26T09:00:00Z") : null,
    evidence: [
      {
        sourceType,
        evidenceType:
          sourceType === "system_derivation"
            ? "deterministic_calculation"
            : "merchant_correction",
        summary: evidenceSummary,
        metadata: {},
        observedAt: new Date("2026-07-26T09:00:00Z"),
        createdAt: new Date("2026-07-26T09:00:00Z"),
      },
    ],
  };
}

async function createGoalFixture(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Merchant Goals Test ${suffix}`,
      shops: {
        create: {
          shopDomain: `merchant-goals-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  for (const belief of [
    {
      key: "business.description",
      category: "business",
      value: { text: "Specialist wine merchant" },
    },
    {
      key: "business.business_model",
      category: "business",
      value: { text: "DTC retail with selective wholesale" },
    },
    {
      key: "orders.average_order_value.all_time",
      category: "orders",
      value: { amount: 64, currency: "GBP" },
      valueType: "currency_amount",
    },
  ]) {
    await upsertDerivedBelief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      category: belief.category,
      key: belief.key,
      value: belief.value,
      valueType: belief.valueType ?? "string",
      confidence: 0.9,
      confidenceReason: "Test fixture.",
      observedAt: new Date("2026-07-26T09:00:00Z"),
      evidence: {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: `Fixture belief for ${belief.key}.`,
        observedAt: new Date("2026-07-26T09:00:00Z"),
      },
    });
  }
  return { merchant, shop };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
