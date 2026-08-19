// @ts-nocheck

import { LlmOutputValidationError } from "../llm/errors.server.js";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  CONVERSATION_TOPICS,
  addAssistantConversationNote,
  addMerchantConversationNote,
} from "../merchant-memory/conversation.server.js";
import { buildPlanEvidenceSnapshot } from "../merchant-memory/context-retriever.server.js";
import { recordEvidence } from "../merchant-memory/service.server.js";
import { enqueueBackfillJob } from "../../services/shopify-backfill-status.server.js";
import { completePlanOnboarding } from "../../services/onboarding.server.js";
import { proposeActionFromIntent } from "../actions/action-resolution.server.js";
import { isActionExecuteEnabled } from "../actions/action-intent.server.js";
import {
  ensureMerchantActionForRecommendation,
  updateMerchantActionForRecommendation,
} from "../actions/merchant-action.server.js";
import { advanceActionWorkflow } from "../actions/action-step-lifecycle.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
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
import {
  isMerchantProposalTrigger,
  persistProposedRecommendationIfAllowed,
  resolveProposalTriggerForPlanRun,
  resolveProposalTriggerForQueue,
  shouldDeferAutonomousProposalCreation,
} from "./proposal-creation-invariant.server.js";

const ACTIVE_RUN_STATUSES = [PLAN_RUN_STATUS.queued, PLAN_RUN_STATUS.running];

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runAfter?: Date; resetAttempts?: boolean; sourceMode?: string; proposalTrigger?: import("./proposal-creation-invariant.server.js").ProposalCreationTrigger }} input
 */
export async function ensureMerchantPlanQueued(prisma, input) {
  const proposalTrigger = resolveProposalTriggerForQueue(input);
  if (
    !isMerchantProposalTrigger(proposalTrigger) &&
    (await shouldDeferAutonomousProposalCreation(prisma, input))
  ) {
    return { status: "deferred_initial_proposal_exists" };
  }

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
      proposalTrigger,
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
      include: recommendationInclude(),
    }),
    prisma.merchantPlanRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: PLAN_RUN_STATUS.completed,
        snapshotHash: { not: snapshot.snapshotHash },
      },
      include: recommendationInclude(),
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
      // "home" runs are merchant-triggered from the Reading your store card.
      sourceMode: { in: ["full", "home"] },
    },
    include: recommendationInclude(),
    orderBy: { completedAt: "desc" },
  });
  return { selectedRun: serializeRun(latestCompletedRun) };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error">; proposalTrigger?: import("./proposal-creation-invariant.server.js").ProposalCreationTrigger }} input
 */
export async function generateMerchantPlan(prisma, input) {
  const logger = input.logger ?? console;
  const prepared = input.runId
    ? await loadPreparedRun(prisma, input)
    : await preparePlanRun(prisma, input);
  if (prepared.status !== "ready") return prepared;

  const run = prepared.run;
  const snapshot = prepared.snapshot;
  const proposalTrigger = resolveProposalTriggerForPlanRun(run, input);
  if (
    proposalTrigger === "background" &&
    (await shouldDeferAutonomousProposalCreation(prisma, input))
  ) {
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: PLAN_RUN_STATUS.completed,
        completedAt: new Date(),
        result: { reason: "deferred_initial_proposal_exists" },
      },
    });
    logger.info("Merchant Plan generation deferred — initial proposal already exists", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runId: run.id,
    });
    return { status: "deferred_initial_proposal_exists", runId: run.id };
  }
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

    const persistResult = await persistProposedRecommendationIfAllowed(
      prisma,
      {
        merchantId: input.merchantId,
        shopId: input.shopId,
        trigger: proposalTrigger,
      },
      async (tx) => {
        const persistedRecommendation = await tx.merchantPlanRecommendation.upsert({
          where: { runId: run.id },
          create: {
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
            successSignal: recommendation.successSignal,
            expectedBenefit: recommendation.expectedBenefit,
            supportingBeliefIds: recommendation.supportingBeliefIds,
            supportingInsightIds: recommendation.supportingInsightIds,
            confidence: recommendation.confidence,
            assumption: recommendation.assumption,
            caveat: recommendation.caveat,
            reviewStatus: PLAN_REVIEW_STATUS.proposed,
          },
          update: {
            title: recommendation.title,
            summary: recommendation.summary,
            primaryGoalId: recommendation.primaryGoalId,
            supportingGoalIds: recommendation.supportingGoalIds,
            whyThisAction: recommendation.whyThisAction,
            whyNow: recommendation.whyNow,
            startToday: recommendation.startToday,
            successSignal: recommendation.successSignal,
            expectedBenefit: recommendation.expectedBenefit,
            supportingBeliefIds: recommendation.supportingBeliefIds,
            supportingInsightIds: recommendation.supportingInsightIds,
            confidence: recommendation.confidence,
            assumption: recommendation.assumption,
            caveat: recommendation.caveat,
          },
        });
        const persistedWorkflow = await persistRecommendationWorkflow(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          recommendation: persistedRecommendation,
          workflow: recommendation.workflow,
        });
        await ensureMerchantActionForRecommendation(tx, {
          recommendation: {
            ...persistedRecommendation,
            workflows: [
              {
                ...persistedWorkflow,
                steps: recommendation.workflow?.steps ?? [],
              },
            ],
          },
        });
        await buildPlanEvidenceSnapshot(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          recommendation: persistedRecommendation,
          sourceSnapshotHash: run.snapshotHash,
          snapshotSource: "plan_generation",
          logger,
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
        return persistedRecommendation;
      },
    );

    if (!persistResult.ok) {
      await prisma.merchantPlanRun.update({
        where: { id: run.id },
        data: {
          status: PLAN_RUN_STATUS.completed,
          completedAt: new Date(),
          result: { reason: persistResult.reason },
        },
      });
      logger.info("Merchant Plan generation skipped — proposal invariant", {
        merchantId: input.merchantId,
        shopId: input.shopId,
        runId: run.id,
        reason: persistResult.reason,
      });
      return { status: persistResult.reason, runId: run.id };
    }

    const persistedRecommendation = persistResult.value;

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
 * Hand an accepted workflow step's action-intent to the typed action lane. The intent is
 * advisory (the LLM picked the verb); proposeActionFromIntent re-resolves it against
 * live memory and computes floored + capped parameters, creating a `proposed` row only
 * when there is a real, safe opportunity. Nothing external is written — execution stays
 * behind each action's execute flag. Best-effort: never throws into Plan acceptance.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; intent: any; sourceRecommendation?: any; recommendationStepId?: string | null; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function maybeEmitPlanAction(prisma, { merchantId, shopId, intent, sourceRecommendation, recommendationStepId, logger }) {
  if (!intent) return;
  try {
    const result = await proposeActionFromIntent(prisma, {
      merchantId,
      shopId,
      intent,
      // This intent's OWN execute flag — never clearance's. A plan can emit any registered
      // action type, and isClearanceExecuteEnabled() would have told a second type it was live
      // because CLEARANCE_EXECUTE_ENABLED is true in production. Fail-closed on unknown types.
      writeEnabled: isActionExecuteEnabled(intent?.actionType),
      sourceRecommendation,
      recommendationStepId: recommendationStepId ?? null,
    });
    logger.info("Plan emitted an action-intent", {
      merchantId,
      shopId,
      actionType: intent.actionType,
      recommendationStepId: recommendationStepId ?? null,
      status: result.status,
      runId: result.execution?.runId ?? null,
    });
  } catch (error) {
    logger.error("Plan action-intent emit failed (non-fatal)", {
      merchantId,
      shopId,
      actionType: intent?.actionType ?? null,
      recommendationStepId: recommendationStepId ?? null,
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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
  const interpretedDirection = interpretPlanRefinementDirection(message);
  await prisma.$transaction(async (tx) => {
    await recordEvidence(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceType: "merchant_plan",
      sourceReference: input.recommendationId
        ? `merchant_plan_recommendation:${input.recommendationId}`
        : "plan_onboarding_conversation",
      evidenceType: "merchant_plan_refinement",
      summary: `Merchant refined Jefe's Plan: ${interpretedDirection}`,
      metadata: {
        originalMessage: message,
        interpretedDirection,
        recommendationId: input.recommendationId ?? null,
      },
      observedAt: now,
    });
    if (input.recommendationId) {
      const updated = await tx.merchantPlanRecommendation.updateMany({
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
      if (updated.count > 0) {
        await updateMerchantActionForRecommendation(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          recommendationId: input.recommendationId,
          recommendation: {
            reviewStatus: PLAN_REVIEW_STATUS.refinementRequested,
          },
        });
      }
    }
  });
  await addMerchantConversationNote(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    topic: CONVERSATION_TOPICS.onboardingPlan,
    message,
  });
  await ensureMerchantPlanQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    resetAttempts: true,
    runAfter: input.runAfter,
    proposalTrigger: "merchant_onboarding",
  });
  await addAssistantConversationNote(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    topic: CONVERSATION_TOPICS.onboardingPlan,
    content: buildPlanRefinementConversationMessage(interpretedDirection),
    operation: {
      operationType: "plan_refinement_context",
      reason: "Captured merchant guidance for Plan regeneration.",
      recommendationId: input.recommendationId ?? null,
      merchantStatement: message,
      interpretedDirection,
    },
  });
  return { ok: true };
}

function buildPlanRefinementConversationMessage(interpretedDirection) {
  return `I interpreted your guidance as: ${interpretedDirection}`;
}

function interpretPlanRefinementDirection(message) {
  const normalized = message.toLowerCase();
  const directions = [];

  if (/(avoid|no|don't|do not).{0,24}(email|campaign|newsletter)/.test(normalized)) {
    directions.push("de-prioritise email-led work for this Plan");
  }
  if (/(stock|inventory|dead stock|cleanup|clearance)/.test(normalized)) {
    directions.push("make the first move more operational and stock-focused");
  }
  if (/(avoid|no|don't|do not).{0,24}(discount|sale|markdown)/.test(normalized)) {
    directions.push("avoid discount-led growth unless the memory strongly supports it");
  }
  if (/(lighter|simpler|smaller|easier|quick|low effort)/.test(normalized)) {
    directions.push("keep the recommendation lightweight enough to start quickly");
  }
  if (/(customer|retention|repeat|loyal|vip)/.test(normalized)) {
    directions.push("ground the first move in customer retention and repeat purchase behaviour");
  }

  if (directions.length === 0) {
    return "use the merchant's latest guidance as planning context, synthesised into a sharper first move rather than copied literally";
  }

  return `${directions.join("; ")}.`;
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
  const recommendation = await prisma.$transaction(async (tx) => {
    const updated = await tx.merchantPlanRecommendation.update({
      where: { id: existing.id },
      data: {
        reviewStatus: PLAN_REVIEW_STATUS.accepted,
        acceptedAt: now,
      },
      include: recommendationInclude().recommendation.include,
    });
    await tx.merchantRecommendationWorkflow.updateMany({
      where: { recommendationId: existing.id, status: "draft" },
      data: { status: "active" },
    });
    await updateMerchantActionForRecommendation(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendationId: updated.id,
      recommendation: updated,
    });
    const workflow =
      updated.workflows?.[0] ??
      (await tx.merchantRecommendationWorkflow.findFirst({
        where: { recommendationId: updated.id, merchantId: input.merchantId, shopId: input.shopId },
        orderBy: { version: "desc" },
      }));
    const actionRow = await tx.merchantAction.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        sourceRecommendationId: updated.id,
      },
      select: { id: true },
    });
    if (workflow?.id) {
      await advanceActionWorkflow(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: actionRow?.id ?? null,
        workflowId: workflow.id,
        now,
      });
    }
    await emitExecutableWorkflowSteps(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendation: updated,
      logger: baseLogger.child({ component: "merchant-plan-workflow" }),
    });
    return updated;
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
    // Marks who first generated this snapshot's plan. "home" = merchant clicked Generate on
    // the home screen — counted against the per-day home proposal cap. Set on CREATE only;
    // the upsert `update` below never reclassifies an existing run.
    sourceMode: input.sourceMode === "home" ? "home" : "full",
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

function recommendationInclude() {
  return {
    recommendation: {
      include: {
        workflows: {
          orderBy: { version: "desc" },
          take: 1,
          include: { steps: { orderBy: { orderIndex: "asc" } } },
        },
      },
    },
  };
}

function serializeRecommendation(recommendation) {
  const workflow = serializeWorkflow(recommendation.workflows?.[0] ?? null);
  return {
    id: recommendation.id,
    title: recommendation.title,
    summary: recommendation.summary,
    primaryGoalId: recommendation.primaryGoalId,
    supportingGoalIds: recommendation.supportingGoalIds,
    whyThisAction: recommendation.whyThisAction,
    whyNow: recommendation.whyNow,
    startToday: recommendation.startToday,
    workflow,
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

function serializeWorkflow(workflow) {
  if (!workflow) return null;
  return {
    id: workflow.id,
    version: workflow.version,
    status: workflow.status,
    source: workflow.source,
    steps: (workflow.steps ?? []).map((step) => ({
      id: step.id,
      orderIndex: step.orderIndex,
      title: step.title,
      description: step.description,
      completionCriteria: step.completionCriteria,
      status: step.status,
      mode: step.mode,
      capabilityRef: step.capabilityRef,
      dependsOnStepIds: step.dependsOnStepIds ?? [],
      evidenceIds: step.evidenceIds ?? [],
    })),
  };
}

async function persistRecommendationWorkflow(tx, { merchantId, shopId, recommendation, workflow }) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const persistedWorkflow = await tx.merchantRecommendationWorkflow.upsert({
    where: {
      recommendationId_version: {
        recommendationId: recommendation.id,
        version: 1,
      },
    },
    create: {
      recommendationId: recommendation.id,
      merchantId,
      shopId,
      version: 1,
      status: "draft",
      source: "plan_generation",
    },
    update: {
      merchantId,
      shopId,
      status: "draft",
      source: "plan_generation",
    },
  });
  await tx.merchantRecommendationStep.deleteMany({
    where: { workflowId: persistedWorkflow.id, status: "draft" },
  });
  if (steps.length === 0) return persistedWorkflow;
  await tx.merchantRecommendationStep.createMany({
    data: steps.map((step, index) => ({
      workflowId: persistedWorkflow.id,
      recommendationId: recommendation.id,
      merchantId,
      shopId,
      orderIndex: index,
      title: step.title,
      description: step.description,
      completionCriteria: step.completionCriteria ?? null,
      status: "draft",
      mode: step.mode,
      capabilityRef: step.capabilityRef ?? null,
      dependsOnStepIds: step.dependsOnStepIds ?? [],
      evidenceIds: [],
    })),
  });
  return persistedWorkflow;
}

async function emitExecutableWorkflowSteps(tx, { merchantId, shopId, recommendation, logger }) {
  const workflow = recommendation.workflows?.[0] ?? null;
  const steps = workflow?.steps ?? [];
  for (const step of steps) {
    if (step.mode !== "execute" || !step.capabilityRef) continue;
    const intent = actionIntentFromCapabilityRef(step.capabilityRef);
    if (!intent) continue;
    await maybeEmitPlanAction(tx, {
      merchantId,
      shopId,
      intent,
      sourceRecommendation: recommendation,
      recommendationStepId: step.id,
      logger,
    });
  }
}

function actionIntentFromCapabilityRef(ref) {
  const parts = String(ref ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== "execute") return null;
  return {
    actionType: parts[1],
    targetKind: parts[2],
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
