// @ts-nocheck

import { LlmOutputValidationError } from "../llm/errors.server.js";
import { createLlmProvider } from "../llm/provider.server.js";
import { recordEvidence } from "../merchant-memory/service.server.js";
import { enqueueBackfillJob } from "../../services/shopify-backfill-status.server.js";
import { completePlanOnboarding } from "../../services/onboarding.server.js";
import { proposeActionFromIntent } from "../actions/action-resolution.server.js";
import { isClearanceExecuteEnabled } from "../actions/clearance-adapter.server.js";
import { buildMerchantPlanSnapshot } from "./candidates.server.js";
import {
  MERCHANT_PLAN_JOB_TYPE,
  MERCHANT_PLAN_PROMPT_VERSION,
  MERCHANT_PLAN_SCHEMA_VERSION,
  MERCHANT_PLAN_SNAPSHOT_VERSION,
  MIN_PLAN_BELIEFS,
  PLAN_REVIEW_STATUS,
  PLAN_RUN_STATUS,
} from "./constants.server.js";
import {
  MERCHANT_PLAN_OUTPUT_SCHEMA,
  parseAndValidateMerchantPlanOutput,
} from "./schema.server.js";
import {
  buildMerchantPlanPrompt,
  buildMerchantPlanSystemPrompt,
} from "./prompt.server.js";

const ACTIVE_RUN_STATUSES = [PLAN_RUN_STATUS.queued, PLAN_RUN_STATUS.running];

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function ensureMerchantPlanQueued(prisma, input) {
  const prepared = await preparePlanRun(prisma, input);
  if (prepared.status !== "ready") return prepared;
  const run = prepared.run;

  if (
    (!input.resetAttempts && run.status === PLAN_RUN_STATUS.completed) ||
    run.status === PLAN_RUN_STATUS.running ||
    (!input.resetAttempts &&
      (run.status === PLAN_RUN_STATUS.insufficientData ||
        run.status === PLAN_RUN_STATUS.modelDisabled ||
        run.status === PLAN_RUN_STATUS.failed))
  ) {
    return { status: "reused", run, snapshot: prepared.snapshot };
  }

  const queuedRun = await prisma.merchantPlanRun.update({
    where: { id: run.id },
    data: {
      status: PLAN_RUN_STATUS.queued,
      safeErrorCode: null,
      lastError: null,
      failedAt: null,
    },
  });

  await enqueueBackfillJob(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    jobType: MERCHANT_PLAN_JOB_TYPE,
    runAfter: input.runAfter,
    resetAttempts: input.resetAttempts,
    payload: {
      runId: run.id,
      snapshotHash: prepared.snapshot.snapshotHash,
      reason: "merchant_goals_ready",
    },
  });

  return { status: "queued", run: queuedRun, snapshot: prepared.snapshot };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function getMerchantPlanExperience(prisma, input) {
  const snapshot = await buildMerchantPlanSnapshot(prisma, input);
  const [currentRun, previousCompletedRun, activeJob] = await Promise.all([
    prisma.merchantPlanRun.findUnique({
      where: {
        shopId_snapshotHash_promptVersion_schemaVersion: {
          shopId: input.shopId,
          snapshotHash: snapshot.snapshotHash,
          promptVersion: MERCHANT_PLAN_PROMPT_VERSION,
          schemaVersion: MERCHANT_PLAN_SCHEMA_VERSION,
        },
      },
      include: { recommendation: true },
    }),
    prisma.merchantPlanRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: PLAN_RUN_STATUS.completed,
        snapshotHash: { not: snapshot.snapshotHash },
      },
      include: { recommendation: true },
      orderBy: { completedAt: "desc" },
    }),
    prisma.backfillJob.findUnique({
      where: {
        shopId_jobType: {
          shopId: input.shopId,
          jobType: MERCHANT_PLAN_JOB_TYPE,
        },
      },
    }),
  ]);

  const selectedRun =
    currentRun?.status === PLAN_RUN_STATUS.completed
      ? currentRun
      : previousCompletedRun;

  return {
    snapshotHash: snapshot.snapshotHash,
    candidateCount: snapshot.candidateCount,
    hasGoals: snapshot.hasGoals,
    currentRun: serializeRun(currentRun),
    previousCompletedRun: serializeRun(previousCompletedRun),
    selectedRun: serializeRun(selectedRun),
    activeJob: activeJob
      ? {
          status: activeJob.status,
          lastError: activeJob.lastError,
          attemptCount: activeJob.attemptCount,
        }
      : null,
    stale: Boolean(
      selectedRun &&
        selectedRun.status === PLAN_RUN_STATUS.completed &&
        selectedRun.snapshotHash !== snapshot.snapshotHash,
    ),
  };
}

/**
 * Read-only fetch of the latest completed Plan run for the Daily Home.
 * Unlike getMerchantPlanExperience, this does NOT build a snapshot (no
 * re-query/re-hash of the belief set) and does NOT ensure or queue
 * generation. It only reads the most recent completed run so the home
 * screen loads fast.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function getLatestMerchantPlan(prisma, input) {
  const latestCompletedRun = await prisma.merchantPlanRun.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: PLAN_RUN_STATUS.completed,
    },
    include: { recommendation: true },
    orderBy: { completedAt: "desc" },
  });
  return { selectedRun: serializeRun(latestCompletedRun) };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function generateMerchantPlan(prisma, input) {
  const logger = input.logger ?? console;
  const prepared = input.runId
    ? await loadPreparedRun(prisma, input)
    : await preparePlanRun(prisma, input);
  if (prepared.status !== "ready") return prepared;

  const run = prepared.run;
  const snapshot = prepared.snapshot;
  if (!snapshot.hasGoals || snapshot.candidateCount < MIN_PLAN_BELIEFS) {
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: PLAN_RUN_STATUS.insufficientData,
        completedAt: new Date(),
        result: {
          reason: snapshot.hasGoals
            ? "insufficient_supported_beliefs"
            : "missing_completed_goals",
          candidateCount: snapshot.candidateCount,
        },
      },
    });
    return { status: PLAN_RUN_STATUS.insufficientData, runId: run.id };
  }

  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "plan",
        runType: "MerchantPlanRun",
        runId: run.id,
      },
    });
  await prisma.merchantPlanRun.update({
    where: { id: run.id },
    data: {
      status: PLAN_RUN_STATUS.running,
      startedAt: new Date(),
      failedAt: null,
      safeErrorCode: null,
      lastError: null,
      provider: provider.provider,
      modelIdentifier: provider.model,
    },
  });

  if (!provider.enabled || !provider.generateStructuredJson) {
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: PLAN_RUN_STATUS.modelDisabled,
        completedAt: new Date(),
        safeErrorCode: "llm_disabled",
        result: { reason: "llm_disabled" },
      },
    });
    return { status: PLAN_RUN_STATUS.modelDisabled, runId: run.id };
  }

  try {
    const { llmResult, parsed } = await generateValidatedPlan(provider, {
      snapshot,
      logger,
    });
    const recommendation = parsed.recommendation;

    await prisma.$transaction(async (tx) => {
      await tx.merchantPlanRecommendation.deleteMany({ where: { runId: run.id } });
      await tx.merchantPlanRecommendation.create({
        data: {
          runId: run.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          title: recommendation.title,
          summary: recommendation.summary,
          primaryGoalId: recommendation.primaryGoalId,
          supportingGoalIds: recommendation.supportingGoalIds,
          whyThisAction: recommendation.whyThisAction,
          whyNow: recommendation.whyNow,
          startToday: recommendation.startToday,
          executionSteps: recommendation.executionSteps,
          successSignal: recommendation.successSignal,
          expectedBenefit: recommendation.expectedBenefit,
          supportingBeliefIds: recommendation.supportingBeliefIds,
          supportingInsightIds: recommendation.supportingInsightIds,
          confidence: recommendation.confidence,
          assumption: recommendation.assumption,
          caveat: recommendation.caveat,
          reviewStatus: PLAN_REVIEW_STATUS.proposed,
        },
      });
      await tx.merchantPlanRun.updateMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: PLAN_RUN_STATUS.completed,
          id: { not: run.id },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      await tx.merchantPlanRun.update({
        where: { id: run.id },
        data: {
          status: PLAN_RUN_STATUS.completed,
          completedAt: new Date(),
          safeErrorCode: null,
          lastError: null,
          result: {
            selectedCandidateId: recommendation.candidateId,
            candidateSummaries: parsed.candidates.map((candidate) => ({
              id: candidate.id,
              action: candidate.action,
              expectedEffort: candidate.expectedEffort,
              timeToUsefulSignal: candidate.timeToUsefulSignal,
              supportingBeliefIds: candidate.supportingBeliefIds,
              supportingInsightIds: candidate.supportingInsightIds,
            })),
            usage: llmResult.usage,
            attempts: llmResult.attempts,
            durationMs: llmResult.durationMs,
          },
        },
      });
    });

    // Emit any action-intent the plan-rec carried into the typed action lane — Jefe
    // deciding, FROM MEMORY, to offer a concrete move (dead-stock clearance is the first
    // through it). The primitive re-resolves the intent against live memory and computes
    // floored/capped params, so it proposes only a real, safe opportunity — and writes
    // nothing external (execution stays behind CLEARANCE_EXECUTE_ENABLED). Best-effort +
    // OUTSIDE the plan transaction: a failure here never fails plan generation.
    await maybeEmitPlanAction(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      intent: recommendation.actionIntent,
      logger,
    });

    logger.info("Merchant Plan generated", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runId: run.id,
    });
    return { status: PLAN_RUN_STATUS.completed, runId: run.id };
  } catch (error) {
    const safe = planGenerationFailure(error);
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: PLAN_RUN_STATUS.failed,
        failedAt: new Date(),
        safeErrorCode: safe.code,
        lastError: safe.message,
        result: { errorName: error instanceof Error ? error.name : "Error" },
      },
    });
    throw error;
  }
}

/**
 * Hand a plan-rec's optional action-intent to the typed action lane. The intent is
 * advisory (the LLM picked the verb); proposeActionFromIntent re-resolves it against
 * live memory and computes floored + capped parameters, creating a `proposed` row only
 * when there is a real, safe opportunity. Nothing external is written — execution stays
 * behind CLEARANCE_EXECUTE_ENABLED. Best-effort: never throws into plan generation.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; intent: any; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function maybeEmitPlanAction(prisma, { merchantId, shopId, intent, logger }) {
  if (!intent) return;
  try {
    const result = await proposeActionFromIntent(prisma, {
      merchantId,
      shopId,
      intent,
      writeEnabled: isClearanceExecuteEnabled(),
    });
    logger.info("Plan emitted an action-intent", {
      merchantId,
      shopId,
      actionType: intent.actionType,
      status: result.status,
      runId: result.execution?.runId ?? null,
    });
  } catch (error) {
    logger.error("Plan action-intent emit failed (non-fatal)", {
      merchantId,
      shopId,
      actionType: intent?.actionType ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function generateValidatedPlan(provider, input) {
  const allowedBeliefIds = new Set(input.snapshot.beliefIds);
  const allowedInsightIds = new Set(input.snapshot.insightIds);
  const allowedGoalIds = new Set(input.snapshot.goalIds);
  let validationError = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const llmResult = await provider.generateStructuredJson({
      systemPrompt: buildMerchantPlanSystemPrompt(),
      prompt: buildMerchantPlanPrompt(input.snapshot.snapshot, {
        validationError,
      }),
      schema: MERCHANT_PLAN_OUTPUT_SCHEMA,
      maxInputTokens: 18000,
      maxOutputTokens: 3600,
      timeoutMs: 15_000,
    });
    lastResult = llmResult;
    const parsed = parseAndValidateMerchantPlanOutput(llmResult.json, {
      allowedBeliefIds,
      allowedInsightIds,
      allowedGoalIds,
      suppliedBeliefs: input.snapshot.snapshot.beliefs,
      suppliedInsights: input.snapshot.snapshot.insights,
      suppliedGoals: input.snapshot.snapshot.goals,
      previousRecommendations: input.snapshot.snapshot.previousRecommendations,
    });
    if (parsed.ok) return { llmResult, parsed };
    validationError = parsed.error;
    if (attempt < 2) {
      input.logger.warn("Merchant Plan output failed validation; retrying", {
        error: parsed.error,
      });
    }
  }

  throw new LlmOutputValidationError(
    validationError ??
      `Plan generation failed validation after ${lastResult ? "model output" : "request"}.`,
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; message?: string | null }} input
 */
export async function markMerchantPlanJobFailed(prisma, input) {
  if (!input.runId) return null;
  return prisma.merchantPlanRun.updateMany({
    where: {
      id: input.runId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: { in: ACTIVE_RUN_STATUSES },
    },
    data: {
      status: PLAN_RUN_STATUS.failed,
      failedAt: new Date(),
      safeErrorCode: "job_failed",
      lastError: safeErrorText(input.message ?? "Plan generation failed."),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; message: string; recommendationId?: string | null; runAfter?: Date }} input
 */
export async function processMerchantPlanMessage(prisma, input) {
  const message = input.message.trim();
  if (message.length < 2) return { ok: false, error: "Message is required." };
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await recordEvidence(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceType: "merchant_plan",
      sourceReference: input.recommendationId
        ? `merchant_plan_recommendation:${input.recommendationId}`
        : "plan_onboarding_conversation",
      evidenceType: "merchant_plan_refinement",
      summary: `Merchant refined Jefe's Plan: ${message.slice(0, 240)}`,
      metadata: { originalMessage: message, recommendationId: input.recommendationId ?? null },
      observedAt: now,
    });
    if (input.recommendationId) {
      await tx.merchantPlanRecommendation.updateMany({
        where: {
          id: input.recommendationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          reviewStatus: PLAN_REVIEW_STATUS.proposed,
        },
        data: {
          reviewStatus: PLAN_REVIEW_STATUS.refinementRequested,
          rejectedAt: now,
        },
      });
    }
  });
  await ensureMerchantPlanQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    resetAttempts: true,
    runAfter: input.runAfter,
  });
  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; recommendationId: string }} input
 */
export async function acceptMerchantPlanAndCompleteOnboarding(prisma, input) {
  const now = new Date();
  const existing = await prisma.merchantPlanRecommendation.findFirstOrThrow({
    where: {
      id: input.recommendationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  const recommendation = await prisma.merchantPlanRecommendation.update({
    where: { id: existing.id },
    data: {
      reviewStatus: PLAN_REVIEW_STATUS.accepted,
      acceptedAt: now,
    },
  });
  await recordEvidence(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    sourceType: "merchant_plan",
    sourceReference: `merchant_plan_recommendation:${recommendation.id}`,
    evidenceType: "merchant_plan_accepted",
    summary: `Merchant accepted Jefe's first Plan recommendation: ${recommendation.title}`,
    metadata: {
      recommendationId: recommendation.id,
      runId: recommendation.runId,
      supportingBeliefIds: recommendation.supportingBeliefIds,
      supportingInsightIds: recommendation.supportingInsightIds,
    },
    observedAt: now,
  });
  await completePlanOnboarding(prisma, {
    shopId: input.shopId,
    metadata: {
      planRecommendationId: recommendation.id,
      planRunId: recommendation.runId,
    },
  });
  return { ok: true, recommendation };
}

async function preparePlanRun(prisma, input) {
  const snapshot = await buildMerchantPlanSnapshot(prisma, input);
  if (snapshot.candidateCount === 0 || !snapshot.hasGoals) {
    return { status: "insufficient_candidates", snapshot };
  }
  const data = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    status: PLAN_RUN_STATUS.queued,
    snapshotVersion: MERCHANT_PLAN_SNAPSHOT_VERSION,
    snapshotHash: snapshot.snapshotHash,
    relevantBeliefIds: snapshot.beliefIds,
    insightRunId: snapshot.insightRunId,
    goalRunId: snapshot.goalRunId,
    promptVersion: MERCHANT_PLAN_PROMPT_VERSION,
    schemaVersion: MERCHANT_PLAN_SCHEMA_VERSION,
  };
  const run = await prisma.merchantPlanRun.upsert({
    where: {
      shopId_snapshotHash_promptVersion_schemaVersion: {
        shopId: input.shopId,
        snapshotHash: snapshot.snapshotHash,
        promptVersion: MERCHANT_PLAN_PROMPT_VERSION,
        schemaVersion: MERCHANT_PLAN_SCHEMA_VERSION,
      },
    },
    create: data,
    update: {
      relevantBeliefIds: snapshot.beliefIds,
      insightRunId: snapshot.insightRunId,
      goalRunId: snapshot.goalRunId,
    },
  });
  return { status: "ready", run, snapshot };
}

async function loadPreparedRun(prisma, input) {
  const run = await prisma.merchantPlanRun.findFirst({
    where: {
      id: input.runId ?? undefined,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!run) return preparePlanRun(prisma, input);
  const snapshot = await buildMerchantPlanSnapshot(prisma, input);
  if (run.snapshotHash !== snapshot.snapshotHash) return preparePlanRun(prisma, input);
  return { status: "ready", run, snapshot };
}

function serializeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    snapshotHash: run.snapshotHash,
    safeErrorCode: run.safeErrorCode,
    lastError: run.lastError,
    completedAt: run.completedAt?.toISOString?.() ?? null,
    failedAt: run.failedAt?.toISOString?.() ?? null,
    supersededAt: run.supersededAt?.toISOString?.() ?? null,
    recommendation: run.recommendation ? serializeRecommendation(run.recommendation) : null,
  };
}

function serializeRecommendation(recommendation) {
  return {
    id: recommendation.id,
    title: recommendation.title,
    summary: recommendation.summary,
    primaryGoalId: recommendation.primaryGoalId,
    supportingGoalIds: recommendation.supportingGoalIds,
    whyThisAction: recommendation.whyThisAction,
    whyNow: recommendation.whyNow,
    startToday: recommendation.startToday,
    executionSteps: Array.isArray(recommendation.executionSteps)
      ? recommendation.executionSteps
      : [],
    successSignal:
      recommendation.successSignal &&
      typeof recommendation.successSignal === "object" &&
      !Array.isArray(recommendation.successSignal)
        ? recommendation.successSignal
        : {},
    expectedBenefit: recommendation.expectedBenefit,
    supportingBeliefIds: recommendation.supportingBeliefIds,
    supportingInsightIds: recommendation.supportingInsightIds,
    confidence: recommendation.confidence,
    assumption: recommendation.assumption,
    caveat: recommendation.caveat,
    reviewStatus: recommendation.reviewStatus,
    acceptedAt: recommendation.acceptedAt?.toISOString?.() ?? null,
    rejectedAt: recommendation.rejectedAt?.toISOString?.() ?? null,
  };
}

function planGenerationFailure(error) {
  if (error instanceof LlmOutputValidationError) {
    return { code: "invalid_model_output", message: error.message };
  }
  if (error instanceof Error && error.name === "LlmInputLimitError") {
    return { code: "input_too_large", message: error.message };
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return { code: "llm_timeout", message: "Plan generation timed out." };
  }
  return {
    code: "llm_provider_failed",
    message: safeErrorText(
      error instanceof Error ? error.message : "Plan generation failed.",
    ),
  };
}

function safeErrorText(message) {
  return String(message).replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]").slice(0, 1000);
}
