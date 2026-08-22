import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { upsertDerivedBelief } from "../app/lib/merchant-memory/service.server.js";
import {
  MEMORY_REFRESH_JOB_TYPE,
} from "../app/lib/merchant-memory/constants.server.js";
import {
  STORE_UNDERSTANDING_DERIVATION_VERSION,
  STORE_UNDERSTANDING_INPUT_VERSION,
  STORE_UNDERSTANDING_RUN_STATUS,
} from "../app/lib/merchant-memory/store-understanding-registry.server.js";
import {
  INSIGHT_RUN_STATUS,
  MERCHANT_INSIGHTS_JOB_TYPE,
  MERCHANT_INSIGHTS_PROMPT_VERSION,
  MERCHANT_INSIGHTS_SCHEMA_VERSION,
  MERCHANT_INSIGHTS_SNAPSHOT_VERSION,
} from "../app/lib/merchant-insights/constants.server.js";
import {
  GOAL_HORIZONS,
  GOAL_RUN_STATUS,
  MERCHANT_GOALS_JOB_TYPE,
  MERCHANT_GOALS_PROMPT_VERSION,
  MERCHANT_GOALS_SCHEMA_VERSION,
  MERCHANT_GOALS_SNAPSHOT_VERSION,
} from "../app/lib/merchant-goals/constants.server.js";
import { AGENTIC_RECOMMENDATION_JOB_TYPE } from "../app/lib/shopify/agentic-runtime/constants.server.js";
import {
  answerOnboardingContext,
  classifyFailure,
  getFastOnboardingExperience,
} from "../app/lib/onboarding/fast-onboarding.server.js";
import {
  ensureOnboardingLearningProgress,
  inspectOnboardingLearningProgress,
  ONBOARDING_LEARNING_JOB_TYPES,
} from "../app/lib/onboarding/learning-progress.server.js";
import {
  BOOTSTRAP_BACKFILL_DOMAIN,
  MERCHANT_BOOTSTRAP_JOB_TYPE,
} from "../app/services/shopify-backfill-status.server.js";

const databaseUrl = process.env.DATABASE_URL;
const serviceSource = fs.readFileSync(
  new URL("../app/lib/onboarding/fast-onboarding.server.js", import.meta.url),
  "utf8",
);
const progressSource = fs.readFileSync(
  new URL("../app/lib/onboarding/learning-progress.server.js", import.meta.url),
  "utf8",
);
const componentSource = fs.readFileSync(
  new URL("../app/components/fast-value-onboarding.tsx", import.meta.url),
  "utf8",
);

test("context answers resume learning through one idempotent orchestrator", () => {
  assert.match(serviceSource, /ensureOnboardingLearningProgress/);
  assert.match(progressSource, /export async function ensureOnboardingLearningProgress/);
  assert.match(progressSource, /storeUnderstanding/);
  assert.match(progressSource, /ensureMerchantInsightsQueued/);
  assert.match(progressSource, /ensureMerchantGoalsQueued/);
  assert.match(progressSource, /ensureAgenticRecommendationQueued/);
  assert.doesNotMatch(
    serviceSource.slice(
      serviceSource.indexOf("export async function answerOnboardingContext"),
      serviceSource.indexOf("export async function continueOnboardingInsight"),
    ),
    /ensureAgenticRecommendationQueued/,
  );
  assert.deepEqual(
    [...ONBOARDING_LEARNING_JOB_TYPES],
    [
      MERCHANT_BOOTSTRAP_JOB_TYPE,
      MEMORY_REFRESH_JOB_TYPE,
      MERCHANT_INSIGHTS_JOB_TYPE,
      MERCHANT_GOALS_JOB_TYPE,
      AGENTIC_RECOMMENDATION_JOB_TYPE,
    ],
  );
});

test("Still working requires a queued or running learning job", () => {
  assert.match(componentSource, /waitingForLearningWork/);
  assert.match(componentSource, /experience\.learningPipelinePending/);
  assert.match(componentSource, /showWaitingCopy/);
  assert.match(progressSource, /learningPipelinePending/);
  const unscheduled = classifyFailure(
    { status: "complete", metadata: { phase: "awaiting_context" } },
    { status: "succeeded" },
    {
      bootstrapPhase: "awaiting_context",
      contextAnswered: true,
      hasSurfaceableRecommendation: false,
      fullLearningState: "learning",
      learningPipelinePending: false,
    },
  );
  assert.equal(unscheduled.type, "retryable");
  assert.match(unscheduled.message, /next learning step has not started/);
  assert.equal(
    classifyFailure(
      { status: "complete", metadata: { phase: "awaiting_context" } },
      { status: "succeeded" },
      {
        bootstrapPhase: "awaiting_context",
        contextAnswered: true,
        hasSurfaceableRecommendation: false,
        fullLearningState: "learning",
        learningPipelinePending: true,
      },
    ),
    null,
  );
});

test("context answer queues the missing first-value pipeline", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding learning progress tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createLearningFixture(prisma, suffix, {
      bootstrapComplete: true,
    });

    const answered = await answerOnboardingContext(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      value: "revenue",
    });
    const first = await inspectOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const jobsAfterAnswer = await learningJobs(prisma, shop.id);
    const second = await ensureOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
    });
    const jobsAfterRepeat = await learningJobs(prisma, shop.id);
    const experience = await getFastOnboardingExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
    });

    assert.equal(answered.ok, true);
    assert.equal(answered.context.value, "revenue");
    assert.equal(first.contextAnswered, true);
    assert.equal(first.nextStage, "store_understanding");
    assert.equal(first.storeUnderstanding.state, "pending");
    assert.equal(first.learningPipelinePending, true);
    assert.equal(jobsAfterAnswer[MEMORY_REFRESH_JOB_TYPE], "queued");
    assert.equal(jobsAfterAnswer[MERCHANT_INSIGHTS_JOB_TYPE], undefined);
    assert.equal(jobsAfterAnswer[MERCHANT_GOALS_JOB_TYPE], undefined);
    assert.equal(jobsAfterAnswer[AGENTIC_RECOMMENDATION_JOB_TYPE], undefined);
    assert.equal(second.queuedStage, null);
    assert.equal(jobsAfterRepeat[MEMORY_REFRESH_JOB_TYPE], "queued");
    assert.equal(experience.learningPipelinePending, true);
    assert.equal(experience.failure, null);
    assert.equal(experience.recommendationInvestigationPending, false);
    assert.equal(experience.recommendation, null);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Learning Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("orchestration queues exactly the next missing learning stage", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding learning progress tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const understandingReady = await createLearningFixture(prisma, `${suffix}-u`, {
      bootstrapComplete: true,
      contextAnswered: true,
      storeUnderstandingComplete: true,
    });
    const understandingProgress = await ensureOnboardingLearningProgress(prisma, {
      merchantId: understandingReady.merchant.id,
      shopId: understandingReady.shop.id,
    });
    const understandingJobs = await learningJobs(prisma, understandingReady.shop.id);

    const insightsReady = await createLearningFixture(prisma, `${suffix}-i`, {
      bootstrapComplete: true,
      contextAnswered: true,
      storeUnderstandingComplete: true,
      insightsComplete: true,
    });
    const insightsProgress = await ensureOnboardingLearningProgress(prisma, {
      merchantId: insightsReady.merchant.id,
      shopId: insightsReady.shop.id,
    });
    const insightsJobs = await learningJobs(prisma, insightsReady.shop.id);

    const goalsReady = await createLearningFixture(prisma, `${suffix}-g`, {
      bootstrapComplete: true,
      contextAnswered: true,
      storeUnderstandingComplete: true,
      insightsComplete: true,
      goalsComplete: true,
    });
    const goalsProgress = await ensureOnboardingLearningProgress(prisma, {
      merchantId: goalsReady.merchant.id,
      shopId: goalsReady.shop.id,
    });
    const goalsJobs = await learningJobs(prisma, goalsReady.shop.id);

    assert.equal(understandingProgress.queuedStage, "insights");
    assert.equal(understandingProgress.insights.state, "pending");
    assert.equal(understandingJobs[MERCHANT_INSIGHTS_JOB_TYPE], "queued");
    assert.equal(understandingJobs[MERCHANT_GOALS_JOB_TYPE], undefined);
    assert.equal(understandingJobs[AGENTIC_RECOMMENDATION_JOB_TYPE], undefined);

    assert.equal(insightsProgress.queuedStage, "goals");
    assert.equal(insightsProgress.goals.state, "pending");
    assert.equal(insightsJobs[MERCHANT_GOALS_JOB_TYPE], "queued");
    assert.equal(insightsJobs[AGENTIC_RECOMMENDATION_JOB_TYPE], undefined);

    assert.equal(goalsProgress.queuedStage, "recommendation");
    assert.equal(goalsProgress.recommendation.state, "pending");
    assert.equal(goalsJobs[AGENTIC_RECOMMENDATION_JOB_TYPE], "queued");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Onboarding Learning Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("repeated orchestration reuses one job per stage", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding learning progress tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createLearningFixture(prisma, suffix, {
      bootstrapComplete: true,
      contextAnswered: true,
      storeUnderstandingComplete: true,
    });
    const first = await ensureOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const second = await ensureOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const third = await ensureOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const insightJobs = await prisma.backfillJob.findMany({
      where: { shopId: shop.id, jobType: MERCHANT_INSIGHTS_JOB_TYPE },
    });
    const insightRuns = await prisma.merchantInsightRun.findMany({
      where: { shopId: shop.id },
    });

    assert.equal(first.queuedStage, "insights");
    assert.equal(second.queuedStage, null);
    assert.equal(third.queuedStage, null);
    assert.equal(insightJobs.length, 1);
    assert.equal(insightJobs[0].status, "queued");
    assert.equal(insightRuns.length, 1);
    assert.equal(second.insights.runId, first.insights.runId);
    assert.equal(third.insights.runId, first.insights.runId);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Learning Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("getFastOnboardingExperience self-heals an unscheduled pipeline", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding learning progress tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createLearningFixture(prisma, suffix, {
      bootstrapComplete: true,
      contextAnswered: true,
    });
    const before = await inspectOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const experience = await getFastOnboardingExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
    });
    const after = await inspectOnboardingLearningProgress(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });

    assert.equal(before.storeUnderstanding.state, "missing");
    assert.equal(before.learningPipelinePending, false);
    assert.equal(after.storeUnderstanding.state, "pending");
    assert.equal(after.learningPipelinePending, true);
    assert.equal(experience.learningPipelinePending, true);
    assert.equal(experience.recommendationInvestigationPending, false);
    assert.equal(experience.failure, null);
    assert.equal(experience.recommendation, null);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Learning Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

async function createLearningFixture(prisma, suffix, options = {}) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Onboarding Learning Test ${suffix}`,
      shops: {
        create: {
          shopDomain: `onboarding-learning-${suffix}.myshopify.com`,
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
      derivationVersion: `${belief.key}@v1`,
      observedAt: new Date("2026-08-22T09:00:00Z"),
      evidence: {
        sourceType: "system_derivation",
        sourceReference: "test",
        evidenceType: "deterministic_calculation",
        summary: belief.summary,
        metadata: { sourceRecordCounts: { orders: 6 } },
        observedAt: new Date("2026-08-22T09:00:00Z"),
      },
    });
  }

  if (options.bootstrapComplete) {
    await prisma.backfillJob.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_BOOTSTRAP_JOB_TYPE,
        status: "succeeded",
        startedAt: new Date("2026-08-22T09:00:00Z"),
        completedAt: new Date("2026-08-22T09:00:20Z"),
        payloadJson: { onboardingEpoch: `epoch-${suffix}` },
        resultJson: { phase: "awaiting_context" },
      },
    });
    await prisma.shopBackfillStatus.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        domain: BOOTSTRAP_BACKFILL_DOMAIN,
        status: "complete",
        startedAt: new Date("2026-08-22T09:00:00Z"),
        completedAt: new Date("2026-08-22T09:00:20Z"),
        metadata: {
          phase: "awaiting_context",
          onboardingEpoch: `epoch-${suffix}`,
        },
      },
    });
  }

  if (options.contextAnswered) {
    await answerOnboardingContext(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      value: "revenue",
    });
    await prisma.backfillJob.deleteMany({
      where: {
        shopId: shop.id,
        jobType: {
          in: [
            MEMORY_REFRESH_JOB_TYPE,
            MERCHANT_INSIGHTS_JOB_TYPE,
            MERCHANT_GOALS_JOB_TYPE,
            AGENTIC_RECOMMENDATION_JOB_TYPE,
          ],
        },
      },
    });
  }

  if (options.storeUnderstandingComplete) {
    await prisma.storeUnderstandingRun.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        status: STORE_UNDERSTANDING_RUN_STATUS.completed,
        trigger: "test",
        inputSummaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
        inputSummaryHash: `hash-${suffix}`,
        derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
        completedAt: new Date("2026-08-22T09:01:00Z"),
        result: { reason: "test" },
      },
    });
  }

  if (options.insightsComplete) {
    await prisma.merchantInsightRun.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        status: INSIGHT_RUN_STATUS.completed,
        beliefSnapshotVersion: MERCHANT_INSIGHTS_SNAPSHOT_VERSION,
        beliefSnapshotHash: `insight-${suffix}`,
        promptVersion: MERCHANT_INSIGHTS_PROMPT_VERSION,
        schemaVersion: MERCHANT_INSIGHTS_SCHEMA_VERSION,
        completedAt: new Date("2026-08-22T09:02:00Z"),
        findings: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            orderIndex: 0,
            title: "Orders have a clear value shape",
            finding: "Average order value is 64.",
            whyItMatters: "That gives Jefe a grounded baseline.",
            confidence: "high",
            category: "revenue",
          },
        },
      },
    });
  }

  if (options.goalsComplete) {
    const insight = await prisma.merchantInsightRun.findFirst({
      where: { shopId: shop.id, status: INSIGHT_RUN_STATUS.completed },
      select: { id: true },
    });
    await prisma.merchantGoalRun.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        status: GOAL_RUN_STATUS.completed,
        beliefSnapshotVersion: MERCHANT_GOALS_SNAPSHOT_VERSION,
        beliefSnapshotHash: `goal-${suffix}`,
        promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
        schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
        insightRunId: insight?.id ?? null,
        completedAt: new Date("2026-08-22T09:03:00Z"),
        horizons: {
          create: GOAL_HORIZONS.map((horizon) => ({
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: horizon.key,
            orderIndex: horizon.orderIndex,
            title: `${horizon.label} test goal`,
            description: "Fixture goal.",
          })),
        },
      },
    });
  }

  return { merchant, shop };
}

async function learningJobs(prisma, shopId) {
  const jobs = await prisma.backfillJob.findMany({
    where: { shopId, jobType: { in: [...ONBOARDING_LEARNING_JOB_TYPES] } },
    select: { jobType: true, status: true },
  });
  return Object.fromEntries(jobs.map((job) => [job.jobType, job.status]));
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
