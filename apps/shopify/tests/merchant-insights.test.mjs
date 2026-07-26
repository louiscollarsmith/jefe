import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createMockLlmProvider } from "../app/lib/llm/provider.server.js";
import { buildMerchantInsightSnapshot } from "../app/lib/merchant-insights/candidates.server.js";
import { parseAndValidateMerchantInsightCorrection } from "../app/lib/merchant-insights/correction-processor.server.js";
import { parseAndValidateMerchantInsightsOutput } from "../app/lib/merchant-insights/schema.server.js";
import {
  confirmMerchantInsightFinding,
  correctMerchantInsightFinding,
  ensureMerchantInsightsQueued,
  generateMerchantInsights,
} from "../app/lib/merchant-insights/service.server.js";
import {
  INSIGHT_RUN_STATUS,
  MAX_ONBOARDING_INSIGHTS,
  MERCHANT_INSIGHTS_JOB_TYPE,
} from "../app/lib/merchant-insights/constants.server.js";
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

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("insight snapshot is bounded to Merchant Memory and excludes raw Shopify PII", async () => {
  const prisma = {
    merchantMemoryBelief: {
      async findMany() {
        return [
          beliefFixture({
            id: "belief-1",
            key: "orders.average_order_value.all_time",
            value: { amount: 64, currency: "GBP" },
            evidenceSummary:
              "Average order value calculated from stored orders.",
            metadata: {
              confidenceProvenance: {
                veryLargeInternalTrace: "x".repeat(20_000),
              },
              includedExcludedRules: {
                veryLargeInternalRules: "y".repeat(20_000),
              },
              sourceRecordCounts: { orders: 6 },
            },
          }),
          beliefFixture({
            id: "belief-2",
            key: "business.description",
            category: "business",
            value: { text: "Contact jane@example.com about VIP buyers" },
            status: "merchant_corrected",
            evidenceSummary:
              "Merchant supplied this business description from +44 7700 900123.",
            sourceType: "merchant_input",
          }),
        ];
      },
    },
    merchantMemoryRefreshRun: {
      async findFirst() {
        return { id: "run-1", completedAt: new Date("2026-07-25T09:00:00Z") };
      },
    },
  };

  const snapshot = await buildMerchantInsightSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  const serialized = JSON.stringify(snapshot.snapshot);

  assert.equal(snapshot.candidateCount, 2);
  assert.equal(snapshot.snapshot.privacy.excludesRawShopifyRecords, true);
  assert.equal(serialized.includes("jane@example.com"), false);
  assert.equal(serialized.includes("+44 7700 900123"), false);
  assert.equal(serialized.includes("rawPayload"), false);
  assert.equal(serialized.includes("veryLargeInternalTrace"), false);
  assert.equal(serialized.includes("veryLargeInternalRules"), false);
  assert.ok(serialized.length < 10_000);
});

test("insight snapshot includes every active Merchant Memory belief without a candidate cap", async () => {
  const beliefs = Array.from({ length: 45 }, (_, index) =>
    beliefFixture({
      id: `belief-${index + 1}`,
      key: `orders.synthetic_signal_${index + 1}`,
      value: { count: index + 1 },
      evidenceSummary: `Synthetic signal ${index + 1} came from stored evidence.`,
    }),
  );
  const prisma = {
    merchantMemoryBelief: {
      async findMany() {
        return beliefs;
      },
    },
    merchantMemoryRefreshRun: {
      async findFirst() {
        return { id: "run-1", completedAt: new Date("2026-07-25T09:00:00Z") };
      },
    },
  };

  const snapshot = await buildMerchantInsightSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });

  assert.equal(snapshot.candidateCount, 45);
  assert.equal(snapshot.snapshot.beliefCount, 45);
  assert.deepEqual(
    new Set(snapshot.beliefIds),
    new Set(beliefs.map((belief) => belief.id)),
  );
});

test("structured insight validation rejects unsupported belief IDs and accepts grounded percentages", () => {
  const suppliedBeliefs = [
    {
      id: "belief-1",
      value: { percentage: 34 },
      evidence: [
        { summary: "Hero product contributes 34 percent of revenue." },
      ],
    },
  ];
  const valid = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Revenue is concentrated",
          finding: "One product contributes 34% of revenue.",
          whyItMatters: "That concentration can shape future recommendations.",
          supportingBeliefIds: ["belief-1"],
          confidence: "high",
          category: "revenue",
        },
      ],
    },
    { allowedBeliefIds: new Set(["belief-1"]), suppliedBeliefs },
  );
  const invalidId = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Unsupported",
          finding: "This cites the wrong belief.",
          whyItMatters: "It should fail validation.",
          supportingBeliefIds: ["belief-2"],
          confidence: "medium",
          category: "other",
        },
      ],
    },
    { allowedBeliefIds: new Set(["belief-1"]), suppliedBeliefs },
  );

  assert.equal(valid.ok, true);
  assert.equal(invalidId.ok, false);
  assert.match(invalidId.error, /not supplied/);
});

test("structured insight validation rejects generic or unsupported interpretation", () => {
  const suppliedBeliefs = [
    {
      id: "belief-1",
      value: { percentage: 56, count: 5 },
      evidence: [
        {
          summary:
            "The top five variants account for 56 percent of available inventory value.",
        },
      ],
    },
    {
      id: "belief-2",
      value: { count: 24, amount: 45.64, currency: "GBP" },
      evidence: [
        {
          summary:
            "The active catalogue contains 24 products with an average price of 45.64 GBP.",
        },
      ],
    },
  ];

  const unsupportedRisk = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Inventory concentration creates operational risk",
          finding:
            "The top five variants account for 56% of inventory value, creating risk if those products face supply chain disruptions or shifts in consumer demand.",
          whyItMatters:
            "That would make the business vulnerable to outside disruption.",
          supportingBeliefIds: ["belief-1"],
          confidence: "high",
          category: "inventory",
        },
      ],
    },
    { allowedBeliefIds: new Set(["belief-1", "belief-2"]), suppliedBeliefs },
  );
  const genericPositioning = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Specialized Wine Retail Model",
          finding:
            "The store has 24 active products and a relatively high average price of 45.64.",
          whyItMatters:
            "This suggests a strategy based on expertise and curation that likely influences the customer base and marketing approach.",
          supportingBeliefIds: ["belief-2"],
          confidence: "medium",
          category: "products",
        },
      ],
    },
    { allowedBeliefIds: new Set(["belief-1", "belief-2"]), suppliedBeliefs },
  );
  const grounded = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Five variants hold 56% of stock value",
          finding:
            "More than half of the retail value currently held in inventory sits in a very small part of the catalogue.",
          whyItMatters:
            "Buying, pricing and sell-through changes on those five products will disproportionately affect cash tied up in stock.",
          supportingBeliefIds: ["belief-1"],
          confidence: "high",
          category: "inventory",
        },
      ],
    },
    { allowedBeliefIds: new Set(["belief-1", "belief-2"]), suppliedBeliefs },
  );

  assert.equal(unsupportedRisk.ok, false);
  assert.match(unsupportedRisk.error, /generic or unsupported/);
  assert.equal(genericPositioning.ok, false);
  assert.match(genericPositioning.error, /generic or unsupported/);
  assert.equal(grounded.ok, true);
});

test("correction processor validation rejects deterministic overwrites", () => {
  const result = parseAndValidateMerchantInsightCorrection(
    {
      correctionType: "fact_dispute",
      affectedBeliefIds: ["belief-1"],
      merchantContext: "The last order date is wrong.",
      confidenceAdjustments: [
        {
          beliefId: "belief-1",
          direction: "needs_review",
          reason: "Merchant disputes the source data.",
        },
      ],
      followUpQuestion: "Which system has the correct last order date?",
      proposedMemoryChanges: [
        {
          key: "orders.average_order_value.all_time",
          category: "orders",
          valueType: "currency_amount",
          value: { amount: 12, currency: "GBP" },
          summary: "Unsafe deterministic overwrite.",
        },
      ],
      regenerateInsights: true,
      rebuildMerchantMemory: true,
    },
    { supportingBeliefIds: new Set(["belief-1"]) },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /non-merchant context/);
});

test("insight generation is wired to the async worker and not browser page load", () => {
  assert.equal(MERCHANT_INSIGHTS_JOB_TYPE, "merchant_insights_generate");
  assert.match(workerSource, /MERCHANT_INSIGHTS_JOB_TYPE/);
  assert.match(workerSource, /ensureMerchantInsightsQueued/);
  assert.match(workerSource, /generateMerchantInsights/);
  assert.match(routeSource, /ensureMerchantInsightsQueued/);
  assert.doesNotMatch(routeSource, /generateMerchantInsights\(/);
});

test("onboarding reveal is capped to the strongest five insights", () => {
  assert.equal(MAX_ONBOARDING_INSIGHTS, 5);
  assert.match(routeSource, /MAX_ONBOARDING_INSIGHTS/);
  assert.match(routeSource, /selectedRun\?\.findings \?\? \[\]\)\.slice/);
});

test("insight correction UI uses natural language instead of belief selection", () => {
  assert.match(routeSource, /Help me understand what I got wrong\./);
  assert.match(routeSource, /Tell me what I&apos;ve misunderstood/);
  assert.match(routeSource, /name="insightText"/);
  assert.match(routeSource, /name="supportingBeliefIds"/);
  assert.match(routeSource, /value={correctionText}/);
  assert.match(routeSource, /onChange={setCorrectionText}/);
  assert.match(routeSource, /Submit correction/);
  assert.doesNotMatch(routeSource, /name="beliefId"/);
  assert.doesNotMatch(routeSource, /setSelectedBeliefId/);
});

test("merchant insight generation persists validated findings and review confirmation", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Insight persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createInsightFixture(prisma, suffix);
    const queued = await ensureMerchantInsightsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const averageOrderValueBelief = queued.snapshot.snapshot.beliefs.find(
      (belief) => belief.key === "orders.average_order_value.all_time",
    );
    assert.ok(averageOrderValueBelief);
    const result = await generateMerchantInsights(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: {
          insights: [
            {
              title: "Orders have a clear value shape",
              finding: "Average order value is 64.",
              whyItMatters:
                "That gives Jefe a grounded baseline for future recommendations.",
              supportingBeliefIds: [averageOrderValueBelief.id],
              confidence: "high",
              category: "revenue",
            },
          ],
        },
      }),
      logger: silentLogger,
    });
    const run = await prisma.merchantInsightRun.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
      include: { findings: true },
    });
    await confirmMerchantInsightFinding(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      findingId: run.findings[0].id,
    });
    const reviewed = await prisma.merchantInsightFinding.findUniqueOrThrow({
      where: { id: run.findings[0].id },
    });

    assert.equal(result.status, INSIGHT_RUN_STATUS.completed);
    assert.equal(run.findings.length, 1);
    assert.equal(reviewed.reviewStatus, "confirmed");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Insights Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("natural language insight correction stores merchant context without overwriting deterministic facts", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Insight persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createInsightFixture(prisma, suffix);
    const { run, averageOrderValueBelief } = await createCompletedInsightRun(
      prisma,
      merchant.id,
      shop.id,
    );
    const finding = run.findings[0];

    const result = await correctMerchantInsightFinding(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      findingId: finding.id,
      insightText: `${finding.title}\n${finding.finding}`,
      supportingBeliefIds: finding.supportingBeliefIds,
      correction:
        "Most of our sales actually happen through wholesale rather than Shopify.",
      llmProvider: createMockLlmProvider({
        operation: {
          correctionType: "missing_context",
          affectedBeliefIds: [averageOrderValueBelief.id],
          merchantContext:
            "Most revenue happens through wholesale rather than Shopify.",
          confidenceAdjustments: [
            {
              beliefId: averageOrderValueBelief.id,
              direction: "needs_review",
              reason:
                "Shopify order value does not represent the whole business.",
            },
          ],
          followUpQuestion: null,
          proposedMemoryChanges: [
            {
              key: "business.primary_sales_channel",
              category: "business",
              valueType: "string",
              value: { text: "Wholesale" },
              summary:
                "Merchant says most revenue happens through wholesale rather than Shopify.",
            },
          ],
          regenerateInsights: true,
          rebuildMerchantMemory: false,
        },
      }),
      logger: silentLogger,
    });

    const deterministicBelief =
      await prisma.merchantMemoryBelief.findUniqueOrThrow({
        where: { id: averageOrderValueBelief.id },
      });
    const merchantContext = await prisma.merchantMemoryBelief.findFirstOrThrow({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        key: "business.primary_sales_channel",
      },
    });
    const correctionEvidence =
      await prisma.merchantMemoryEvidence.findFirstOrThrow({
        where: {
          merchantId: merchant.id,
          shopId: shop.id,
          evidenceType: "merchant_insight_correction",
        },
      });
    const reloadedFinding =
      await prisma.merchantInsightFinding.findUniqueOrThrow({
        where: { id: finding.id },
      });
    const regenerationJob = await prisma.backfillJob.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_INSIGHTS_JOB_TYPE,
        status: "queued",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(reloadedFinding.reviewStatus, "corrected");
    assert.equal(deterministicBelief.status, "inferred");
    assert.deepEqual(deterministicBelief.value, {
      amount: 64,
      currency: "GBP",
    });
    assert.equal(merchantContext.status, "merchant_confirmed");
    assert.deepEqual(merchantContext.value, { text: "Wholesale" });
    assert.equal(
      correctionEvidence.metadata.originalCorrection,
      "Most of our sales actually happen through wholesale rather than Shopify.",
    );
    assert.deepEqual(
      correctionEvidence.metadata.submittedSupportingBeliefIds,
      finding.supportingBeliefIds,
    );
    assert.ok(regenerationJob);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Insights Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("invalid natural language correction processor output is rejected safely", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Insight persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createInsightFixture(prisma, suffix);
    const { run } = await createCompletedInsightRun(
      prisma,
      merchant.id,
      shop.id,
    );
    const finding = run.findings[0];

    const result = await correctMerchantInsightFinding(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      findingId: finding.id,
      correction: "The last order date is wrong.",
      llmProvider: createMockLlmProvider({
        operation: {
          correctionType: "fact_dispute",
          affectedBeliefIds: ["not-a-supporting-belief"],
          merchantContext: "The last order date is wrong.",
          confidenceAdjustments: [],
          followUpQuestion: null,
          proposedMemoryChanges: [],
          regenerateInsights: true,
          rebuildMerchantMemory: true,
        },
      }),
      logger: silentLogger,
    });
    const reloadedFinding =
      await prisma.merchantInsightFinding.findUniqueOrThrow({
        where: { id: finding.id },
      });
    const correctionEvidence = await prisma.merchantMemoryEvidence.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        evidenceType: "merchant_insight_correction",
      },
    });

    assert.equal(result.ok, false);
    assert.equal(reloadedFinding.reviewStatus, "unreviewed");
    assert.equal(correctionEvidence, null);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Insights Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function beliefFixture({
  id,
  key,
  category = "orders",
  value,
  status = "inferred",
  evidenceSummary,
  sourceType = "system_derivation",
  metadata = { sourceRecordCounts: { orders: 6 } },
}) {
  return {
    id,
    merchantId: "merchant-1",
    shopId: "shop-1",
    category,
    key,
    value,
    valueType: "number",
    status,
    confidence: "0.9000",
    confidenceReason: "Supported by stored evidence.",
    precedence: sourceType === "system_derivation" ? 40 : 80,
    derivationVersion: `${key}@v1`,
    firstObservedAt: new Date("2026-07-25T09:00:00Z"),
    lastObservedAt: new Date("2026-07-25T09:00:00Z"),
    lastEvaluatedAt: new Date("2026-07-25T09:00:00Z"),
    lastConfirmedAt:
      status === "merchant_corrected" ? new Date("2026-07-25T09:00:00Z") : null,
    evidence: [
      {
        sourceType,
        evidenceType:
          sourceType === "system_derivation"
            ? "deterministic_calculation"
            : "merchant_correction",
        summary: evidenceSummary,
        metadata,
        observedAt: new Date("2026-07-25T09:00:00Z"),
        createdAt: new Date("2026-07-25T09:00:00Z"),
      },
    ],
  };
}

async function createInsightFixture(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Merchant Insights Test ${suffix}`,
      shops: {
        create: {
          shopDomain: `merchant-insights-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  for (const belief of [
    {
      category: "orders",
      key: "orders.average_order_value.all_time",
      value: { amount: 64, currency: "GBP" },
      valueType: "currency_amount",
      summary: "Average order value is 64 from stored orders.",
    },
    {
      category: "customers",
      key: "customers.repeat_customer_rate.all_time",
      value: { percentage: 50 },
      valueType: "percentage",
      summary: "Repeat customer rate is 50 from stored customers.",
    },
    {
      category: "catalog",
      key: "catalog.active_product_count",
      value: { count: 12 },
      valueType: "number",
      summary: "Active product count is 12 from stored products.",
    },
  ]) {
    await upsertDerivedBelief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      category: belief.category,
      key: belief.key,
      value: belief.value,
      valueType: belief.valueType,
      confidence: 0.9,
      confidenceReason: "Calculated from stored evidence.",
      precedence: 40,
      derivationVersion: `${belief.key}@v1`,
      observedAt: new Date("2026-07-25T09:00:00Z"),
      evidence: {
        sourceType: "system_derivation",
        sourceReference: "test",
        evidenceType: "deterministic_calculation",
        summary: belief.summary,
        metadata: { sourceRecordCounts: { orders: 6 } },
        observedAt: new Date("2026-07-25T09:00:00Z"),
      },
    });
  }
  await prisma.merchantMemoryRefreshRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      refreshType: "full_rebuild",
      status: "completed",
      requestedCategories: [],
      result: { createdOrUpdated: 1 },
      completedAt: new Date("2026-07-25T09:00:00Z"),
    },
  });
  return { merchant, shop };
}

async function createCompletedInsightRun(prisma, merchantId, shopId) {
  const queued = await ensureMerchantInsightsQueued(prisma, {
    merchantId,
    shopId,
  });
  const averageOrderValueBelief = queued.snapshot.snapshot.beliefs.find(
    (belief) => belief.key === "orders.average_order_value.all_time",
  );
  assert.ok(averageOrderValueBelief);
  await generateMerchantInsights(prisma, {
    merchantId,
    shopId,
    runId: queued.run.id,
    llmProvider: createMockLlmProvider({
      operation: {
        insights: [
          {
            title: "Shopify order value has a clear baseline",
            finding: "Average order value is 64.",
            whyItMatters:
              "That gives Jefe a grounded baseline for future recommendations.",
            supportingBeliefIds: [averageOrderValueBelief.id],
            confidence: "high",
            category: "revenue",
          },
        ],
      },
    }),
    logger: silentLogger,
  });
  const run = await prisma.merchantInsightRun.findFirstOrThrow({
    where: { merchantId, shopId },
    include: { findings: true },
  });
  return { run, averageOrderValueBelief };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}
