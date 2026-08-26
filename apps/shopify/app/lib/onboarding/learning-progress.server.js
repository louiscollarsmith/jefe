// @ts-check

import { enqueueMerchantMemoryRefresh } from "../merchant-memory/jobs.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
  MEMORY_REFRESH_JOB_TYPE,
} from "../merchant-memory/constants.server.js";
import { STORE_UNDERSTANDING_RUN_STATUS } from "../merchant-memory/store-understanding-registry.server.js";
import {
  INSIGHT_RUN_STATUS,
  MERCHANT_INSIGHTS_JOB_TYPE,
} from "../merchant-insights/constants.server.js";
import {
  GOAL_HORIZONS,
  GOAL_RUN_STATUS,
  MERCHANT_GOALS_JOB_TYPE,
} from "../merchant-goals/constants.server.js";
import { ensureMerchantInsightsQueued } from "../merchant-insights/service.server.js";
import { ensureMerchantGoalsQueued } from "../merchant-goals/service.server.js";
import { ensureAgenticRecommendationQueued } from "../shopify/agentic-runtime/recommendation-service.server.js";
import {
  AGENTIC_RECOMMENDATION_JOB_TYPE,
  AGENTIC_RECOMMENDATION_SOURCE_MODE,
} from "../shopify/agentic-runtime/constants.server.js";
import { PLAN_RUN_STATUS } from "../merchant-plan/constants.server.js";
import {
  FULL_BACKFILL_JOB_TYPES,
  INITIAL_COMMERCE_BACKFILL_DOMAINS,
  isFullBackfillComplete,
} from "../../services/shopify-backfill-status.server.js";

export const ONBOARDING_LEARNING_JOB_TYPES = Object.freeze([
  ...FULL_BACKFILL_JOB_TYPES,
  MEMORY_REFRESH_JOB_TYPE,
  MERCHANT_INSIGHTS_JOB_TYPE,
  MERCHANT_GOALS_JOB_TYPE,
  AGENTIC_RECOMMENDATION_JOB_TYPE,
]);

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const READY_STORE_UNDERSTANDING_STATUSES = new Set([
  STORE_UNDERSTANDING_RUN_STATUS.completed,
  STORE_UNDERSTANDING_RUN_STATUS.skipped,
  STORE_UNDERSTANDING_RUN_STATUS.modelDisabled,
]);
const PENDING_STORE_UNDERSTANDING_STATUSES = new Set([
  STORE_UNDERSTANDING_RUN_STATUS.queued,
  STORE_UNDERSTANDING_RUN_STATUS.running,
]);
const READY_LEARNING_RUN_STATUSES = new Set([
  INSIGHT_RUN_STATUS.completed,
  GOAL_RUN_STATUS.completed,
]);
const PENDING_LEARNING_RUN_STATUSES = new Set([
  INSIGHT_RUN_STATUS.queued,
  INSIGHT_RUN_STATUS.running,
  GOAL_RUN_STATUS.queued,
  GOAL_RUN_STATUS.running,
]);
const BLOCKED_LEARNING_RUN_STATUSES = new Set([
  INSIGHT_RUN_STATUS.failed,
  INSIGHT_RUN_STATUS.insufficientData,
  INSIGHT_RUN_STATUS.modelDisabled,
  GOAL_RUN_STATUS.failed,
  GOAL_RUN_STATUS.insufficientData,
  GOAL_RUN_STATUS.modelDisabled,
]);
const PENDING_PLAN_RUN_STATUSES = new Set([
  PLAN_RUN_STATUS.queued,
  PLAN_RUN_STATUS.running,
]);
const TERMINAL_PLAN_RUN_STATUSES = new Set([
  PLAN_RUN_STATUS.completed,
  PLAN_RUN_STATUS.failed,
  PLAN_RUN_STATUS.insufficientData,
  PLAN_RUN_STATUS.modelDisabled,
  "no_actionable_opportunity",
]);
const SURFACEABLE_REVIEW_STATUSES = new Set([
  "proposed",
  "accepted",
  "needs_review",
]);

/**
 * Inspect durable onboarding learning state and queue exactly the next missing
 * prerequisite. Repeated calls reuse in-flight jobs and do not start later
 * stages while an earlier one is still pending.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain?: string | null }} input
 */
export async function ensureOnboardingLearningProgress(prisma, input) {
  const before = await inspectOnboardingLearningProgress(prisma, input);
  if (!before.contextAnswered) {
    return {
      status: "awaiting_context",
      queuedStage: null,
      queued: null,
      ...before,
    };
  }

  let queued = null;
  const queuedStage = before.nextStage;
  if (before.nextStage === "store_understanding" && before.storeUnderstanding.state !== "pending") {
    queued = await queueStoreUnderstanding(prisma, input, before);
  } else if (before.nextStage === "insights" && before.insights.state !== "pending") {
    queued = await ensureMerchantInsightsQueued(prisma, input);
  } else if (before.nextStage === "goals" && before.goals.state !== "pending") {
    queued = await ensureMerchantGoalsQueued(prisma, input);
  } else if (before.nextStage === "recommendation" && before.recommendation.state !== "pending") {
    queued = await ensureAgenticRecommendationQueued(prisma, input);
  }

  const after = queued
    ? await inspectOnboardingLearningProgress(prisma, input)
    : before;

  return {
    status: progressStatus(after, queued),
    queuedStage: queued ? queuedStage : null,
    queued,
    ...after,
  };
}

/**
 * Read-only snapshot of the first-value learning pipeline.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function inspectOnboardingLearningProgress(prisma, input) {
  const [
    contextBelief,
    backfillStatuses,
    storeUnderstandingRun,
    insightRun,
    goalRun,
    planRun,
    surfaceableRecommendation,
    jobs,
  ] = await Promise.all([
    prisma.merchantMemoryBelief.findFirst({
      where: {
        merchantId: input.merchantId,
        key: "preferences.optimisation_priority",
        status: { in: ACTIVE_BELIEF_STATUSES },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }),
    prisma.shopBackfillStatus.findMany({
      where: { shopId: input.shopId, domain: { in: INITIAL_COMMERCE_BACKFILL_DOMAINS } },
      select: { domain: true, status: true },
    }),
    prisma.storeUnderstandingRun.findFirst({
      where: { merchantId: input.merchantId, shopId: input.shopId },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    }),
    prisma.merchantInsightRun.findFirst({
      where: { merchantId: input.merchantId, shopId: input.shopId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, status: true, supersededAt: true },
    }),
    prisma.merchantGoalRun.findFirst({
      where: { merchantId: input.merchantId, shopId: input.shopId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        status: true,
        supersededAt: true,
        _count: { select: { horizons: true } },
      },
    }),
    prisma.merchantPlanRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, status: true },
    }),
    prisma.merchantPlanRecommendation.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
        reviewStatus: { in: [...SURFACEABLE_REVIEW_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, reviewStatus: true },
    }),
    prisma.backfillJob.findMany({
      where: {
        shopId: input.shopId,
        jobType: { in: [...ONBOARDING_LEARNING_JOB_TYPES] },
      },
      select: { id: true, jobType: true, status: true },
    }),
  ]);

  const jobByType = new Map(jobs.map((job) => [job.jobType, job]));
  const contextAnswered = Boolean(contextBelief);
  // Replaces the removed `bootstrap` stage (docs/ops/remove-bootstrap-full-onboarding/): the
  // pipeline can no longer advance toward store_understanding/insights/goals/recommendation until
  // full Shopify backfill has genuinely completed — the single source of truth shared with
  // fast-onboarding.server.js's UI copy (isFullBackfillComplete).
  const fullBackfillJobs = jobs.filter((job) => FULL_BACKFILL_JOB_TYPES.includes(job.jobType));
  const fullBackfill = isFullBackfillComplete(backfillStatuses, fullBackfillJobs)
    ? { state: "ready" }
    : fullBackfillJobs.some((job) => job.status === "failed")
      ? { state: "blocked" }
      : { state: "pending" };
  const storeUnderstanding = stageFromJobAndRun({
    job: jobByType.get(MEMORY_REFRESH_JOB_TYPE) ?? null,
    run: storeUnderstandingRun,
    readyStatuses: READY_STORE_UNDERSTANDING_STATUSES,
    pendingStatuses: PENDING_STORE_UNDERSTANDING_STATUSES,
  });
  const insights = stageFromJobAndRun({
    job: jobByType.get(MERCHANT_INSIGHTS_JOB_TYPE) ?? null,
    run: insightRun,
    readyStatuses: READY_LEARNING_RUN_STATUSES,
    pendingStatuses: PENDING_LEARNING_RUN_STATUSES,
    blockedStatuses: BLOCKED_LEARNING_RUN_STATUSES,
  });
  const goalsReady =
    goalRun?.status === GOAL_RUN_STATUS.completed &&
    Number(goalRun._count?.horizons ?? 0) === GOAL_HORIZONS.length;
  const goals = goalsReady
    ? { state: "ready", runId: goalRun.id, jobId: jobByType.get(MERCHANT_GOALS_JOB_TYPE)?.id ?? null }
    : stageFromJobAndRun({
        job: jobByType.get(MERCHANT_GOALS_JOB_TYPE) ?? null,
        run: goalRun,
        readyStatuses: new Set(),
        pendingStatuses: PENDING_LEARNING_RUN_STATUSES,
        blockedStatuses: BLOCKED_LEARNING_RUN_STATUSES,
      });
  const recommendation = recommendationStage({
    recommendation: surfaceableRecommendation,
    planRun,
    job: jobByType.get(AGENTIC_RECOMMENDATION_JOB_TYPE) ?? null,
  });

  const nextStage = resolveNextStage({
    contextAnswered,
    fullBackfill,
    storeUnderstanding,
    insights,
    goals,
    recommendation,
  });
  const learningPipelinePending = isLearningPipelinePending({
    contextAnswered,
    fullBackfill,
    storeUnderstanding,
    insights,
    goals,
    recommendation,
    nextStage,
  });

  return {
    contextAnswered,
    fullBackfill,
    storeUnderstanding,
    insights,
    goals,
    recommendation,
    nextStage,
    learningPipelinePending,
    activeJobTypes: jobs
      .filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
      .map((job) => job.jobType),
  };
}

/** @param {{ contextAnswered: boolean; learningPipelinePending: boolean; nextStage: string; recommendation: { state: string } }} snapshot @param {unknown} queued */
function progressStatus(snapshot, queued) {
  if (snapshot.learningPipelinePending) return queued ? "queued" : "pending";
  if (snapshot.nextStage === "complete") return "complete";
  if (snapshot.nextStage === "blocked") return "blocked";
  return queued ? "queued" : "idle";
}

/**
 * Only ever reachable once `fullBackfill.state === "ready"` (see resolveNextStage) — full
 * backfill's own `handleFinalize` already enqueues this same full Memory refresh automatically
 * the moment backfill completes (docs/ops/remove-bootstrap-full-onboarding/). This call is a
 * safe, idempotent fallback re-trigger (protects against polling racing ahead of that automatic
 * enqueue, a worker restart, or route revalidation) — `enqueueMerchantMemoryRefresh`'s
 * `shopId_jobType` upsert makes a redundant call here a no-op-equivalent, never a duplicate.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain?: string | null }} input
 * @param {{ storeUnderstanding: { state: string } }} snapshot
 */
async function queueStoreUnderstanding(prisma, input, snapshot) {
  if (snapshot.storeUnderstanding.state === "pending") {
    return { status: "reused" };
  }
  const job = await enqueueMerchantMemoryRefresh(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain ?? null,
    categories: [],
    reason: "full_backfill_complete_fallback",
    resetAttempts: false,
  });
  return { status: "queued", job };
}

/**
 * @param {{
 *   job: { id?: string; status?: string } | null;
 *   run: { id?: string; status?: string } | null;
 *   readyStatuses?: Set<string>;
 *   pendingStatuses?: Set<string>;
 *   blockedStatuses?: Set<string>;
 *   readyWhenJobSucceeded?: boolean;
 * }} input
 */
function stageFromJobAndRun(input) {
  const job = input.job;
  const run = input.run;
  if (job && ACTIVE_JOB_STATUSES.has(stringValue(job.status) ?? "")) {
    return { state: "pending", runId: run?.id ?? null, jobId: job.id ?? null };
  }
  if (run && input.pendingStatuses?.has(stringValue(run.status) ?? "")) {
    return { state: "pending", runId: run.id ?? null, jobId: job?.id ?? null };
  }
  if (run && input.readyStatuses?.has(stringValue(run.status) ?? "")) {
    return { state: "ready", runId: run.id ?? null, jobId: job?.id ?? null };
  }
  if (input.readyWhenJobSucceeded && job?.status === "succeeded") {
    return { state: "ready", runId: run?.id ?? null, jobId: job.id ?? null };
  }
  if (run && input.blockedStatuses?.has(stringValue(run.status) ?? "")) {
    return { state: "blocked", runId: run.id ?? null, jobId: job?.id ?? null };
  }
  if (job?.status === "failed") {
    return { state: "blocked", runId: run?.id ?? null, jobId: job.id ?? null };
  }
  return { state: "missing", runId: run?.id ?? null, jobId: job?.id ?? null };
}

/** @param {{ recommendation: { id?: string } | null; planRun: { id?: string; status?: string } | null; job: { id?: string; status?: string } | null }} input */
function recommendationStage(input) {
  if (input.recommendation) {
    return {
      state: "ready",
      runId: input.planRun?.id ?? null,
      jobId: input.job?.id ?? null,
      recommendationId: input.recommendation.id ?? null,
    };
  }
  if (input.job && ACTIVE_JOB_STATUSES.has(stringValue(input.job.status) ?? "")) {
    return { state: "pending", runId: input.planRun?.id ?? null, jobId: input.job.id ?? null };
  }
  if (input.planRun && PENDING_PLAN_RUN_STATUSES.has(stringValue(input.planRun.status) ?? "")) {
    return { state: "pending", runId: input.planRun.id ?? null, jobId: input.job?.id ?? null };
  }
  if (input.planRun && TERMINAL_PLAN_RUN_STATUSES.has(stringValue(input.planRun.status) ?? "")) {
    return { state: "blocked", runId: input.planRun.id ?? null, jobId: input.job?.id ?? null };
  }
  if (input.job?.status === "failed") {
    return { state: "blocked", runId: input.planRun?.id ?? null, jobId: input.job.id ?? null };
  }
  return { state: "missing", runId: input.planRun?.id ?? null, jobId: input.job?.id ?? null };
}

/** @param {{ contextAnswered: boolean; fullBackfill: { state: string }; storeUnderstanding: { state: string }; insights: { state: string }; goals: { state: string }; recommendation: { state: string } }} snapshot */
function resolveNextStage(snapshot) {
  if (!snapshot.contextAnswered) return "context";
  if (snapshot.recommendation.state === "ready") return "complete";
  if (snapshot.recommendation.state === "pending") return "recommendation";
  if (snapshot.goals.state === "ready") {
    return snapshot.recommendation.state === "missing" ? "recommendation" : "blocked";
  }
  if (snapshot.goals.state === "pending") return "goals";
  if (snapshot.insights.state === "ready") {
    return snapshot.goals.state === "missing" ? "goals" : "blocked";
  }
  if (snapshot.insights.state === "pending") return "insights";
  if (snapshot.storeUnderstanding.state === "ready") {
    return snapshot.insights.state === "missing" ? "insights" : "blocked";
  }
  if (snapshot.storeUnderstanding.state === "pending") return "store_understanding";
  if (snapshot.fullBackfill.state === "pending") return "full_backfill";
  if (snapshot.fullBackfill.state === "blocked") return "blocked";
  if (snapshot.storeUnderstanding.state === "missing") return "store_understanding";
  if (snapshot.insights.state === "missing") return "insights";
  if (snapshot.goals.state === "missing") return "goals";
  if (snapshot.recommendation.state === "missing") return "recommendation";
  return "blocked";
}

/** @param {{ contextAnswered: boolean; fullBackfill: { state: string }; storeUnderstanding: { state: string }; insights: { state: string }; goals: { state: string }; recommendation: { state: string }; nextStage: string }} snapshot */
function isLearningPipelinePending(snapshot) {
  if (!snapshot.contextAnswered) return false;
  return [
    snapshot.fullBackfill,
    snapshot.storeUnderstanding,
    snapshot.insights,
    snapshot.goals,
    snapshot.recommendation,
  ].some((stage) => stage.state === "pending");
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value ? value : null;
}
