import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createMockLlmProvider } from "../app/lib/llm/provider.server.js";
import { buildMerchantPlanSnapshot } from "../app/lib/merchant-plan/candidates.server.js";
import { parseAndValidateMerchantPlanOutput } from "../app/lib/merchant-plan/schema.server.js";
import {
  ensureMerchantPlanQueued,
  generateMerchantPlan,
  getLatestMerchantPlan,
  getMerchantPlanExperience,
  processMerchantPlanMessage,
} from "../app/lib/merchant-plan/service.server.js";
import {
  MERCHANT_PLAN_JOB_TYPE,
  PLAN_REVIEW_STATUS,
  PLAN_RUN_STATUS,
} from "../app/lib/merchant-plan/constants.server.js";
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

test("Plan snapshot is bounded to safe memory, goals, insights, context and prior recommendations", async () => {
  const beliefs = Array.from({ length: 45 }, (_, index) =>
    beliefFixture({
      id: `belief-${index + 1}`,
      key:
        index === 0
          ? "business.description"
          : `orders.metric_${index + 1}`,
      value: { text: `Useful signal ${index + 1} for jane@example.com` },
      evidenceSummary: `Evidence included +44 7700 90012${index % 10}.`,
    }),
  );
  const prisma = {
    merchantGoalRun: {
      async findFirst() {
        return {
          id: "goal-run-1",
          horizons: [
            goalFixture("goal-3", "threeMonths", 1, ["belief-1"]),
            goalFixture("goal-6", "sixMonths", 2, ["belief-2"]),
            goalFixture("goal-12", "twelveMonths", 3, ["belief-3"]),
          ],
        };
      },
    },
    merchantInsightRun: {
      async findFirst() {
        return {
          id: "insight-run-1",
          findings: [
            {
              id: "insight-1",
              title: "Revenue depends on a focused product set",
              finding: "A few products carry the clearest demand signal.",
              whyItMatters: "That can shape the first action.",
              category: "products",
              confidence: "high",
              reviewStatus: "confirmed",
              supportingBeliefIds: ["belief-1", "missing-belief"],
            },
          ],
        };
      },
    },
    merchantMemoryBelief: {
      async findMany() {
        return beliefs;
      },
    },
    merchantMemoryEvidence: {
      async findMany() {
        return [
          {
            id: "context-1",
            sourceType: "merchant_goals",
            evidenceType: "merchant_goal_document_context",
            summary: "Planning document said avoid discount-led growth.",
            observedAt: new Date("2026-07-26T10:00:00Z"),
          },
          {
            id: "context-2",
            sourceType: "merchant_plan",
            evidenceType: "merchant_plan_refinement",
            summary: "Merchant refined Jefe's Plan: keep it lightweight.",
            observedAt: new Date("2026-07-26T11:00:00Z"),
          },
        ];
      },
    },
    merchantPlanRecommendation: {
      async findMany() {
        return [
          {
            id: "prior-plan-1",
            title: "Test an email reorder nudge",
            summary: "Prior plan summary.",
            reviewStatus: PLAN_REVIEW_STATUS.rejected,
            acceptedAt: null,
            rejectedAt: new Date("2026-07-26T11:30:00Z"),
            completedAt: null,
            createdAt: new Date("2026-07-26T11:00:00Z"),
            run: { supersededAt: null },
          },
        ];
      },
    },
  };

  const snapshot = await buildMerchantPlanSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  const serialized = JSON.stringify(snapshot.snapshot);

  assert.equal(snapshot.hasGoals, true);
  assert.equal(snapshot.snapshot.privacy.excludesRawShopifyRecords, true);
  assert.equal(snapshot.snapshot.privacy.excludesFullUploadedDocuments, true);
  assert.equal(snapshot.snapshot.beliefs.length <= 40, true);
  assert.equal(snapshot.snapshot.goals.length, 3);
  assert.equal(snapshot.snapshot.insights.length, 1);
  assert.equal(snapshot.snapshot.previousRecommendations.length, 1);
  assert.equal(serialized.includes("jane@example.com"), false);
  assert.equal(serialized.includes("+44 7700"), false);
  assert.equal(serialized.includes("missing-belief"), false);
  assert.equal(serialized.includes("rawPayload"), false);
});

test("Plan structured validation rejects unsupported IDs, generic plans and missing success signals", () => {
  const validOutput = planOutputFixture();
  const valid = parseAndValidateMerchantPlanOutput(validOutput, validationContext());
  const unsupported = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        supportingBeliefIds: ["unknown-belief"],
      },
    },
    validationContext(),
  );
  const generic = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        title: "Improve retention",
        summary: "Improve retention through better marketing.",
      },
    },
    validationContext(),
  );
  const missingSignal = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        successSignal: {},
      },
    },
    validationContext(),
  );
  const duplicate = parseAndValidateMerchantPlanOutput(
    validOutput,
    {
      ...validationContext(),
      previousRecommendations: [
        {
          title: validOutput.selectedRecommendation.title,
          summary: validOutput.selectedRecommendation.summary,
          reviewStatus: PLAN_REVIEW_STATUS.rejected,
        },
      ],
    },
  );
  const goalGroundedNumber = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        whyThisAction:
          "This supports the agreed 98% stock accuracy target before larger retention work.",
        successSignal: {
          description: "Stock accuracy is visibly closer to the agreed goal.",
          timeframe: "within 14 days",
          target: "98% stock accuracy",
        },
      },
    },
    validationContext(),
  );

  assert.equal(valid.ok, true);
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /belief that was not supplied/);
  assert.equal(generic.ok, false);
  assert.match(generic.error, /generic/);
  assert.equal(missingSignal.ok, false);
  assert.match(missingSignal.error, /success signal/);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /duplicates/);
  assert.equal(goalGroundedNumber.ok, true);
});

test("Plan validation attaches a registry-valid actionIntent, drops unknown, tolerates none", () => {
  const base = planOutputFixture();
  // Registry-valid intent → normalized onto the recommendation (magnitude → params).
  const withIntent = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: {
        ...base.selectedRecommendation,
        actionIntent: {
          actionType: "price_markdown",
          targetKind: "dead_stock",
          markdownPercent: 30,
          rationale: "Free the trapped cash",
        },
      },
    },
    validationContext(),
  );
  assert.equal(withIntent.ok, true);
  assert.equal(withIntent.recommendation.actionIntent.actionType, "price_markdown");
  assert.equal(withIntent.recommendation.actionIntent.targetKind, "dead_stock");
  assert.deepEqual(withIntent.recommendation.actionIntent.params, { markdownPercent: 30 });

  // Unknown capability → dropped to null; the plan itself still validates (advisory).
  const bogus = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: {
        ...base.selectedRecommendation,
        actionIntent: { actionType: "wire_money", targetKind: "bank" },
      },
    },
    validationContext(),
  );
  assert.equal(bogus.ok, true);
  assert.equal(bogus.recommendation.actionIntent, null);

  // Absent → null; the plan validates.
  const none = parseAndValidateMerchantPlanOutput(base, validationContext());
  assert.equal(none.ok, true);
  assert.equal(none.recommendation.actionIntent, null);
});

test("getLatestMerchantPlan reads the latest completed run without a snapshot or queueing", async () => {
  const calls = [];
  // Mock prisma implements ONLY merchantPlanRun.findFirst. If the reader tried
  // to rebuild the belief snapshot or queue generation it would touch other
  // models/methods absent here and throw, proving this path is read-only.
  const prisma = {
    merchantPlanRun: {
      async findFirst(args) {
        calls.push(args);
        return {
          id: "plan-run-1",
          status: PLAN_RUN_STATUS.completed,
          snapshotHash: "hash-1",
          safeErrorCode: null,
          lastError: null,
          completedAt: new Date("2026-07-27T09:00:00Z"),
          failedAt: null,
          supersededAt: null,
          recommendation: {
            id: "rec-1",
            title: "Send a focused reorder nudge",
            summary: "One small reorder message.",
            primaryGoalId: "goal-3",
            supportingGoalIds: ["goal-6"],
            whyThisAction: "Repeat-purchase opportunity.",
            whyNow: "Small enough to start today.",
            startToday: "Draft the first message.",
            executionSteps: [{ title: "Choose", description: "Pick a segment." }],
            successSignal: { description: "Replies or purchases.", timeframe: "two weeks" },
            expectedBenefit: "Short feedback loop.",
            supportingBeliefIds: ["belief-1"],
            supportingInsightIds: ["insight-1"],
            confidence: "reasonable",
            assumption: null,
            caveat: null,
            reviewStatus: PLAN_REVIEW_STATUS.proposed,
            acceptedAt: null,
            rejectedAt: null,
          },
        };
      },
    },
  };

  const result = await getLatestMerchantPlan(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.status, PLAN_RUN_STATUS.completed);
  assert.equal(calls[0].where.merchantId, "merchant-1");
  assert.equal(calls[0].where.shopId, "shop-1");
  assert.equal("snapshotHash" in calls[0].where, false);
  assert.deepEqual(calls[0].include, { recommendation: true });
  assert.deepEqual(calls[0].orderBy, { completedAt: "desc" });
  assert.equal(result.selectedRun.id, "plan-run-1");
  assert.equal(
    result.selectedRun.recommendation.title,
    "Send a focused reorder nudge",
  );

  const empty = await getLatestMerchantPlan(
    { merchantPlanRun: { async findFirst() { return null; } } },
    { merchantId: "merchant-1", shopId: "shop-1" },
  );
  assert.deepEqual(empty, { selectedRun: null });
});

test("Plan generation is wired to the async worker and not browser page load", () => {
  assert.equal(MERCHANT_PLAN_JOB_TYPE, "merchant_plan_generate");
  assert.match(workerSource, /MERCHANT_PLAN_JOB_TYPE/);
  assert.match(workerSource, /generateMerchantPlan/);
  assert.match(routeSource, /ensureMerchantPlanQueued/);
  assert.doesNotMatch(routeSource, /generateMerchantPlan\(/);
});

test("Plan onboarding uses the shared topic-scoped chat composer", () => {
  assert.match(routeSource, /Update your Plan by chatting with Jefe/);
  assert.match(routeSource, /OnboardingChat/);
  assert.match(routeSource, /CONVERSATION_TOPICS\.onboardingPlan/);
  assert.match(routeSource, /isPlanConversationAssistantMessage/);
  assert.match(routeSource, /JefePlanApprovalPill/);
  assert.match(routeSource, /Action 1 of 1 · Ready to review/);
  assert.match(routeSource, /JefePlanStartIcon/);
  assert.match(routeSource, /Why Jefe suggests this/);
  assert.doesNotMatch(routeSource, /JefePlanRefinement/);
  assert.doesNotMatch(routeSource, /Why this action/);
  assert.doesNotMatch(
    routeSource,
    /I&apos;ll use that context to choose a better first move/,
  );
});

test("merchant Plan generation persists exactly one recommendation", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Plan persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createPlanFixture(prisma, suffix);
    const queued = await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const snapshot = queued.snapshot.snapshot;
    const result = await generateMerchantPlan(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: planOutputFixture({
          beliefId: snapshot.beliefs[0].id,
          insightId: snapshot.insights[0].id,
          goalId: snapshot.goals[0].id,
          supportingGoalId: snapshot.goals[1].id,
        }),
      }),
      logger: silentLogger,
    });
    const run = await prisma.merchantPlanRun.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
      include: { recommendation: true },
    });
    const recommendations = await prisma.merchantPlanRecommendation.findMany({
      where: { merchantId: merchant.id, shopId: shop.id },
    });
    const experience = await getMerchantPlanExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });

    assert.equal(result.status, PLAN_RUN_STATUS.completed);
    assert.equal(recommendations.length, 1);
    assert.equal(run.recommendation.title, "Send a focused reorder nudge");
    assert.equal(experience.currentRun.id, run.id);
    assert.equal(experience.stale, false);
    assert.equal(Array.isArray(run.result.candidateSummaries), true);
    assert.equal(JSON.stringify(run.result).includes("chain-of-thought"), false);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Plan generation emits the plan-rec actionIntent → a proposed clearance row (no store write)", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Plan persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createPlanFixture(prisma, suffix);
    // Seed one dead-stock variant: ACTIVE product, stock on hand, a known unit cost,
    // and NO sales in the window → a real, safe clearance opportunity for the emit.
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `deadprod-${suffix}`,
        title: "Dusty Parka",
        status: "ACTIVE",
        variants: {
          create: [
            { merchantId: merchant.id, shopId: shop.id, externalId: `deadvar-${suffix}`, sku: "DEAD", price: "200.00", unitCost: "80.00" },
          ],
        },
      },
      include: { variants: true },
    });
    await prisma.inventoryLevel.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: product.variants[0].id,
        inventoryItemExternalId: `ii-dead-${suffix}`,
        locationExternalId: "loc-1",
        available: 10,
      },
    });

    const queued = await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const snapshot = queued.snapshot.snapshot;
    await generateMerchantPlan(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: planOutputFixture({
          beliefId: snapshot.beliefs[0].id,
          insightId: snapshot.insights[0].id,
          goalId: snapshot.goals[0].id,
          supportingGoalId: snapshot.goals[1].id,
          // Jefe (the LLM) decides to recommend clearance from memory — the emit.
          actionIntent: { actionType: "price_markdown", targetKind: "dead_stock", markdownPercent: 30 },
        }),
      }),
      logger: silentLogger,
    });

    const proposed = await prisma.actionExecution.findFirst({
      where: { merchantId: merchant.id, shopId: shop.id, status: "proposed" },
    });
    assert.ok(proposed, "the emit created a proposed action row");
    assert.equal(proposed.actionType, "price_markdown");
    assert.equal(proposed.actionKind, "dead_stock_clearance");
    assert.equal(proposed.resolvedMode, "approve"); // default dial → propose-first, never auto
    assert.equal(proposed.proposalSummary.variantCount, 1);
    assert.equal(Number(proposed.proposalSummary.markdownPercent), 30); // the emit's advisory % round-tripped
    assert.equal(Number(proposed.proposalSummary.totalTrappedCapital), 800); // 10 units × £80 cost
  } finally {
    // ActionExecution has no merchant FK cascade → clean it up explicitly first.
    const leftover = await prisma.merchant.findFirst({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    if (leftover) {
      await prisma.actionExecution.deleteMany({ where: { merchantId: leftover.id } });
    }
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Plan refinement records evidence, marks the current Plan and queues regeneration", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Plan persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createPlanFixture(prisma, suffix);
    const queued = await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const snapshot = queued.snapshot.snapshot;
    await generateMerchantPlan(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: planOutputFixture({
          beliefId: snapshot.beliefs[0].id,
          insightId: snapshot.insights[0].id,
          goalId: snapshot.goals[0].id,
          supportingGoalId: snapshot.goals[1].id,
        }),
      }),
      logger: silentLogger,
    });
    const recommendation = await prisma.merchantPlanRecommendation.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
    });
    const result = await processMerchantPlanMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      recommendationId: recommendation.id,
      message: "Avoid email for now; start with stock cleanup.",
      runAfter: new Date("2999-01-01T00:00:00Z"),
    });
    const updatedRecommendation =
      await prisma.merchantPlanRecommendation.findUniqueOrThrow({
        where: { id: recommendation.id },
      });
    const evidence = await prisma.merchantMemoryEvidence.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        evidenceType: "merchant_plan_refinement",
      },
    });
    const job = await prisma.backfillJob.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_PLAN_JOB_TYPE,
        status: "queued",
      },
    });
    const conversation = await prisma.merchantMemoryConversation.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        topic: "onboarding_plan",
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    assert.equal(result.ok, true);
    assert.equal(
      updatedRecommendation.reviewStatus,
      PLAN_REVIEW_STATUS.refinementRequested,
    );
    assert.ok(evidence);
    assert.match(evidence.summary, /stock-focused/);
    assert.ok(job);
    assert.ok(conversation);
    assert.equal(conversation.messages.at(-2).role, "merchant");
    assert.equal(conversation.messages.at(-1).role, "assistant");
    assert.match(
      conversation.messages.at(-1).content,
      /I interpreted your guidance as:/,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function planOutputFixture({
  beliefId = "belief-1",
  insightId = "insight-1",
  goalId = "goal-3",
  supportingGoalId = "goal-6",
  actionIntent,
} = {}) {
  return {
    candidates: [
      candidateFixture("candidate_1", "Send a focused reorder nudge", beliefId, insightId),
      candidateFixture("candidate_2", "Review the top sellers page", beliefId, insightId),
      candidateFixture("candidate_3", "Check stock for proven products", beliefId, insightId),
    ],
    selectedRecommendation: {
      ...(actionIntent ? { actionIntent } : {}),
      candidateId: "candidate_1",
      title: "Send a focused reorder nudge",
      summary:
        "Create one small reorder message for customers whose previous purchase suggests they may be ready to buy again.",
      primaryGoalId: goalId,
      supportingGoalIds: [supportingGoalId],
      whyThisAction:
        "The supplied memory and insight point to a focused repeat-purchase opportunity.",
      whyNow:
        "It is small enough to begin today and gives useful feedback before larger retention work.",
      startToday:
        "Choose one product group with clear repeat-purchase potential and draft the first customer message.",
      executionSteps: [
        {
          title: "Choose the audience",
          description: "Use the most relevant repeat-purchase segment already implied by Merchant Memory.",
        },
        {
          title: "Send one message",
          description: "Write a practical replenishment note with the product group named clearly.",
        },
      ],
      successSignal: {
        description: "Look for replies, clicks or purchases from the selected group.",
        timeframe: "within two weeks",
      },
      expectedBenefit:
        "This creates a short feedback loop around repeat revenue without committing to a larger programme.",
      supportingBeliefIds: [beliefId],
      supportingInsightIds: [insightId],
      confidence: "reasonable",
    },
  };
}

function candidateFixture(id, action, beliefId, insightId) {
  return {
    id,
    action,
    goalAlignment: "Primarily advances the three-month goal.",
    whyRelevant: "It is supported by the current Merchant Memory and onboarding insight.",
    supportingBeliefIds: [beliefId],
    supportingInsightIds: [insightId],
    expectedEffort: "small",
    timeToUsefulSignal: "within two weeks",
    respectedConstraints: ["keeps scope narrow"],
  };
}

function validationContext() {
  return {
    allowedBeliefIds: new Set(["belief-1"]),
    allowedInsightIds: new Set(["insight-1"]),
    allowedGoalIds: new Set(["goal-3", "goal-6", "goal-12"]),
    suppliedBeliefs: [
      {
        id: "belief-1",
        label: "Repeat purchase signal",
        val: { text: "repeat purchase signal" },
      },
    ],
    suppliedInsights: [
      {
        id: "insight-1",
        title: "Stock accuracy is the immediate dependency",
        finding: "Stock accuracy affects the current three-month goal.",
      },
    ],
    suppliedGoals: [
      {
        id: "goal-3",
        title: "Restore operational confidence",
        description: "Reach 98% stock accuracy within the three-month goal.",
      },
      {
        id: "goal-6",
        title: "Increase repeat revenue",
        description: "Build from the stock accuracy foundation after 6 months.",
      },
      {
        id: "goal-12",
        title: "Grow disciplined revenue",
        description: "Keep the 12-month direction aligned with profitable growth.",
      },
    ],
    previousRecommendations: [],
  };
}

function beliefFixture({
  id,
  key,
  category = "orders",
  value,
  status = "inferred",
  evidenceSummary,
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
    precedence: 40,
    evidence: [
      {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: evidenceSummary,
        metadata: {},
        observedAt: new Date("2026-07-26T09:00:00Z"),
        createdAt: new Date("2026-07-26T09:00:00Z"),
      },
    ],
  };
}

function goalFixture(id, horizon, orderIndex, supportingBeliefIds) {
  return {
    id,
    horizon,
    orderIndex,
    title: `${horizon} revenue goal`,
    description: "Grow revenue from supported evidence.",
    supportingBeliefIds,
  };
}

async function createPlanFixture(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Merchant Plan Test ${suffix}`,
      shops: {
        create: {
          shopDomain: `merchant-plan-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const beliefs = [];
  for (const belief of [
    {
      key: "business.description",
      category: "business",
      value: { text: "Specialist wine merchant" },
    },
    {
      key: "customers.repeat_purchase_rate",
      category: "customers",
      value: { percentage: 24, period: "stored history" },
      valueType: "percentage",
    },
    {
      key: "orders.average_order_value.all_time",
      category: "orders",
      value: { amount: 64, currency: "GBP" },
      valueType: "currency_amount",
    },
  ]) {
    const result = await upsertDerivedBelief(prisma, {
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
    beliefs.push(result.belief);
  }

  const insightRun = await prisma.merchantInsightRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      status: "completed",
      beliefSnapshotVersion: "test",
      beliefSnapshotHash: `insight-${suffix}`,
      relevantBeliefIds: beliefs.map((belief) => belief.id),
      promptVersion: "test",
      schemaVersion: "test",
      completedAt: new Date("2026-07-26T09:05:00Z"),
      findings: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          orderIndex: 1,
          title: "Repeat purchase has room to grow",
          finding: "A repeat-purchase signal is present in Merchant Memory.",
          whyItMatters: "It can shape the first practical action.",
          confidence: "medium",
          category: "retention",
          supportingBeliefIds: [beliefs[1].id],
          reviewStatus: "confirmed",
        },
      },
    },
    include: { findings: true },
  });

  await prisma.merchantGoalRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      status: "completed",
      beliefSnapshotVersion: "test",
      beliefSnapshotHash: `goal-${suffix}`,
      relevantBeliefIds: beliefs.map((belief) => belief.id),
      insightRunId: insightRun.id,
      promptVersion: "test",
      schemaVersion: "test",
      completedAt: new Date("2026-07-26T09:10:00Z"),
      horizons: {
        create: [
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "threeMonths",
            orderIndex: 1,
            title: "Grow repeat revenue",
            description: "Use supported customer behaviour to build repeat sales.",
            supportingBeliefIds: [beliefs[1].id],
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "sixMonths",
            orderIndex: 2,
            title: "Increase customer value",
            description: "Build from early repeat-purchase learning.",
            supportingBeliefIds: [beliefs[1].id],
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "twelveMonths",
            orderIndex: 3,
            title: "Grow revenue with discipline",
            description: "Scale the strongest supported growth loop.",
            supportingBeliefIds: [beliefs[2].id],
          },
        ],
      },
    },
  });

  return { merchant, shop };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
