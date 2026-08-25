// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { createLlmProvider } from "../../llm/provider.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
  MEMORY_BACKFILL_DOMAIN,
} from "../../merchant-memory/constants.server.js";
import { authorityLevel } from "../../merchant-insights/candidates.server.js";
import { retrieveMerchantContext } from "../../merchant-memory/merchant-context.server.js";
import { GOAL_RUN_STATUS } from "../../merchant-goals/constants.server.js";
import { INSIGHT_RUN_STATUS } from "../../merchant-insights/constants.server.js";
import {
  PLAN_REVIEW_STATUS,
  PLAN_RUN_STATUS,
} from "../../merchant-plan/constants.server.js";
import { supersedeAllProposedRecommendations } from "../../merchant-plan/proposal-creation-invariant.server.js";
import {
  enqueueBackfillJob,
  MERCHANT_BOOTSTRAP_JOB_TYPE,
} from "../../../services/shopify-backfill-status.server.js";
import { ShopifyAdminGraphqlClient } from "../admin-graphql.server.js";
import { runCandidateDrivenRecommendation } from "./candidate-pipeline.server.js";
import {
  AGENTIC_RECOMMENDATION_JOB_TYPE,
  AGENTIC_RECOMMENDATION_SCHEMA_VERSION,
  AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
  AGENTIC_RECOMMENDATION_SOURCE_MODE,
} from "./constants.server.js";
import {
  revisionSnapshot,
  semanticActionFromRecommendation,
} from "./semantic-action.server.js";
import { buildActiveWorkItem, checkCandidateNovelty } from "./action-fingerprint.server.js";
import { DETERMINISTIC_BELIEF_REGISTRY } from "../../merchant-memory/deterministic-belief-registry.server.js";

const ACTIVE_RUN_STATUSES = [PLAN_RUN_STATUS.queued, PLAN_RUN_STATUS.running];

// llmExposure lookup: maps belief key → normalized exposure class.
// Beliefs not in the registry (merchant-confirmed, non-deterministic) default to "core".
const REGISTRY_EXPOSURE_MAP = new Map(
  DETERMINISTIC_BELIEF_REGISTRY.map((entry) => [entry.key, entry.llmExposure]),
);

/** @param {string} key */
export function resolveExposure(key) {
  const raw = REGISTRY_EXPOSURE_MAP.get(key);
  if (raw === "Internal guardrail; use to set confidence") return "guardrail";
  if (raw === "On-demand; promote only when decision-relevant") return "on_demand";
  return "core"; // "Core or category retrieval" and all non-registry keys
}

const AUTHORITY_RANK = {
  merchant_corrected: 0,
  merchant_confirmed: 1,
  deterministic: 2,
  system_inference: 3,
  lower_authority_inference: 4,
};

/** @param {any} a @param {any} b */
export function compareBeliefStable(a, b) {
  const ra = AUTHORITY_RANK[a.authority] ?? 5;
  const rb = AUTHORITY_RANK[b.authority] ?? 5;
  if (ra !== rb) return ra - rb;
  return (a.key ?? "").localeCompare(b.key ?? "");
}

/**
 * Partitions normalized beliefs into model-visible and guardrail sets,
 * each sorted deterministically by authority then key.
 * @param {any[]} normalizedBeliefs
 */
export function partitionBeliefsByExposure(normalizedBeliefs) {
  const visible = normalizedBeliefs
    .filter((b) => resolveExposure(b.key) !== "guardrail")
    .sort(compareBeliefStable);
  const guardrails = normalizedBeliefs
    .filter((b) => resolveExposure(b.key) === "guardrail")
    .sort(compareBeliefStable);
  return { visible, guardrails };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; sourceMode?: string; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function ensureAgenticRecommendationQueued(prisma, input) {
  const sourceMode = input.sourceMode ?? AGENTIC_RECOMMENDATION_SOURCE_MODE;
  const previousRun = input.resetAttempts
    ? await findLatestAgenticRecommendationRun(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        statuses: [
          PLAN_RUN_STATUS.completed,
          PLAN_RUN_STATUS.failed,
          PLAN_RUN_STATUS.modelDisabled,
          PLAN_RUN_STATUS.insufficientData,
          "no_actionable_opportunity",
        ],
      })
    : null;
  const [onboardingEpoch, attemptNumber] = await Promise.all([
    loadOnboardingEpoch(prisma, input),
    nextAgenticRecommendationAttemptNumber(prisma, input),
  ]);
  const prepared = await prepareAgenticRecommendationRun(prisma, {
    ...input,
    sourceMode,
    forceFreshRun: input.resetAttempts === true && Boolean(previousRun),
    retryOfRunId: previousRun?.id ?? null,
    onboardingEpoch,
    attemptNumber,
  });
  if (prepared.status !== "ready") return prepared;
  if (!prepared.run) throw new Error("Agentic recommendation run was not prepared.");
  const run = prepared.run;
  if (
    (!input.resetAttempts && run.status === PLAN_RUN_STATUS.completed) ||
    (!input.resetAttempts && ["no_actionable_opportunity", PLAN_RUN_STATUS.modelDisabled, PLAN_RUN_STATUS.failed].includes(run.status))
  ) {
    return { status: "reused", run, snapshot: prepared.snapshot };
  }
  if (!input.resetAttempts && ACTIVE_RUN_STATUSES.includes(run.status)) {
    const existingJob = await prisma.backfillJob.findUnique({
      where: {
        shopId_jobType: {
          shopId: input.shopId,
          jobType: AGENTIC_RECOMMENDATION_JOB_TYPE,
        },
      },
      select: { id: true, status: true },
    });
    if (existingJob && !["succeeded", "failed", "cancelled"].includes(existingJob.status)) {
      return { status: "reused", run, snapshot: prepared.snapshot };
    }
  }
  const queuedRun = await prisma.merchantPlanRun.update({
    where: { id: run.id },
    data: {
      status: PLAN_RUN_STATUS.queued,
      safeErrorCode: null,
      lastError: null,
      failedAt: null,
      sourceMode,
    },
  });
  await enqueueBackfillJob(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    jobType: AGENTIC_RECOMMENDATION_JOB_TYPE,
    runAfter: input.runAfter,
    resetAttempts: input.resetAttempts,
    payload: {
      runId: run.id,
      sourceMode,
      snapshotHash: run.snapshotHash,
      baseSnapshotHash: prepared.snapshot.snapshotHash,
      retryOfRunId: previousRun?.id ?? null,
      onboardingEpoch,
      attemptNumber,
      reason: previousRun ? "merchant_plan_retry" : "merchant_goals_ready",
    },
  });
  return { status: "queued", run: queuedRun, snapshot: prepared.snapshot };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   accessToken: string;
 *   scopes?: string[];
 *   runId?: string | null;
 *   sourceMode?: string;
 *   retryOfRunId?: string | null;
 *   onboardingEpoch?: string | null;
 *   attemptNumber?: number | null;
 *   fetchImpl?: typeof fetch;
 *   llmProvider?: import("../../llm/provider.server.js").LlmProvider;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   maxCandidatesFirstPass?: number;
 *   maxCandidatesRescue?: number;
 *   perCandidateIterations?: number;
 *   maxTotalLlmCalls?: number;
 * }} input
 */
export async function runAgenticRecommendationInvestigation(prisma, input) {
  const logger = input.logger ?? console;
  const prepared = input.runId
    ? await loadPreparedAgenticRecommendationRun(prisma, input)
    : await prepareAgenticRecommendationRun(prisma, input);
  if (prepared.status !== "ready") return prepared;
  if (!prepared.run) throw new Error("Agentic recommendation run was not prepared.");
  const run = prepared.run;
  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "agentic_recommendation",
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
      // sourceMode is set by the caller (e.g., "home" or "agentic") and must not be overwritten
      // here — overwriting it would break isHomeProposalGenerationInFlight's sourceMode filter,
      // causing the home-triggered polling to lose track of the run while it is still running.
    },
  });
  if (!provider.enabled || !provider.generateStructuredJson) {
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: PLAN_RUN_STATUS.modelDisabled,
        completedAt: new Date(),
        safeErrorCode: "llm_disabled",
        result: { reason: "llm_disabled", runtime: "agentic_shopify" },
      },
    });
    return { status: PLAN_RUN_STATUS.modelDisabled, runId: run.id };
  }
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    logger,
  });
  try {
    const result = await runCandidateDrivenRecommendation({
      provider,
      prisma,
      client,
      merchantId: input.merchantId,
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      grantedScopes: input.scopes,
      snapshot: prepared.snapshot.snapshot,
      previousAttempt: prepared.previousAttempt ?? null,
      logger,
      runId: run.id,
      maxCandidatesFirstPass: input.maxCandidatesFirstPass,
      maxCandidatesRescue: input.maxCandidatesRescue,
      perCandidateIterations: input.perCandidateIterations,
      maxTotalLlmCalls: input.maxTotalLlmCalls,
    });
    if (result.ok && result.status === "RECOMMEND_ACTION") {
      // Server-side novelty check: verify the candidate doesn't structurally
      // duplicate an existing proposed or accepted (in-progress) Action.
      // Luna does not reliably detect structural overlap via prose alone.
      const currentActiveActions = await (prisma.merchantAction?.findMany?.({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: { in: ["proposed", "accepted"] },
        },
        select: { id: true, status: true, plan: true, outcome: true },
      }) ?? Promise.resolve([])).catch(() => []);
      const novelty = checkCandidateNovelty(result.recommendation, currentActiveActions);
      if (!novelty.novel) {
        const terminalStatus = "no_actionable_opportunity";
        const runMetadata = agenticRunMetadata(run);
        await prisma.merchantPlanRun.update({
          where: { id: run.id },
          data: {
            status: terminalStatus,
            completedAt: new Date(),
            safeErrorCode: null,
            lastError: null,
            result: {
              runtime: "agentic_shopify",
              ...runMetadata,
              status: "NO_ACTIONABLE_OPPORTUNITY",
              blocker: novelty.reason ?? "duplicate_action",
              noveltyCheck: novelty,
              diagnostics: result.diagnostics ?? {},
            },
          },
        });
        logger.info("Agentic recommendation rejected: structural overlap with existing action", {
          merchantId: input.merchantId,
          shopId: input.shopId,
          runId: run.id,
          reason: novelty.reason,
          overlappingActionId: novelty.overlappingActionId,
        });
        return {
          status: terminalStatus,
          runId: run.id,
          blocker: novelty.reason ?? "duplicate_action",
          diagnostics: result.diagnostics ?? {},
          trace: result.trace ?? null,
        };
      }
      const persisted = await persistAgenticRecommendation(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        run,
        recommendation: result.recommendation,
        diagnostics: result.diagnostics,
        trace: result.trace,
      });
      logger.info("Agentic recommendation generated", {
        merchantId: input.merchantId,
        shopId: input.shopId,
        runId: run.id,
        recommendationId: persisted.recommendation.id,
        actionId: persisted.action.id,
      });
      return {
        status: PLAN_RUN_STATUS.completed,
        runId: run.id,
        recommendationId: persisted.recommendation.id,
        actionId: persisted.action.id,
        recommendation: persisted.recommendation,
        diagnostics: result.diagnostics ?? {},
        trace: result.trace ?? null,
      };
    }
    // BLOCKED means "investigation complete but no safe Shopify action is possible right
    // now." This is a legitimate no-opportunity result, not a system failure. Map it to
    // no_actionable_opportunity alongside NO_ACTIONABLE_OPPORTUNITY.
    // VALIDATION_FAILED and INVESTIGATION_FAILED remain PLAN_RUN_STATUS.failed (genuine errors).
    const terminalStatus =
      result.status === "NO_ACTIONABLE_OPPORTUNITY" || result.status === "BLOCKED"
        ? "no_actionable_opportunity"
        : result.status === "INSUFFICIENT_EVIDENCE"
          ? PLAN_RUN_STATUS.insufficientData
          : PLAN_RUN_STATUS.failed;
    const safeErrorCode = agenticRecommendationSafeErrorCode(result.status);
    const runMetadata = agenticRunMetadata(run);
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: terminalStatus,
        completedAt: terminalStatus === "no_actionable_opportunity" ? new Date() : null,
        failedAt: terminalStatus === PLAN_RUN_STATUS.failed || terminalStatus === PLAN_RUN_STATUS.insufficientData ? new Date() : null,
        safeErrorCode,
        lastError: result.blocker ?? null,
        result: {
          runtime: "agentic_shopify",
          ...runMetadata,
          status: result.status,
          blocker: result.blocker ?? null,
          diagnostics: result.diagnostics ?? {},
          trace: safeTrace(result.trace),
        },
      },
    });
    return {
      status: terminalStatus,
      runId: run.id,
      blocker: result.blocker ?? null,
      diagnostics: result.diagnostics ?? {},
      trace: result.trace ?? null,
    };
  } catch (error) {
    await markAgenticRecommendationJobFailed(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runId: run.id,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; message?: string | null }} input
 */
export async function markAgenticRecommendationJobFailed(prisma, input) {
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
      safeErrorCode: "agentic_recommendation_failed",
      lastError: safeText(input.message ?? "Agentic recommendation failed.", 500),
      result: { runtime: "agentic_shopify", reason: "failed" },
    },
  });
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {{ merchantId: string; shopId: string; sourceMode?: string; forceFreshRun?: boolean; retryOfRunId?: string | null; onboardingEpoch?: string | null; attemptNumber?: number | null }} input */
async function prepareAgenticRecommendationRun(prisma, input) {
  const sourceMode = input.sourceMode ?? AGENTIC_RECOMMENDATION_SOURCE_MODE;
  const snapshot = await buildAgenticRecommendationSnapshot(prisma, input);
  if (!snapshot.hasGoals) return { status: "missing_completed_goals", snapshot };
  if (input.forceFreshRun) {
    const run = await prisma.merchantPlanRun.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: PLAN_RUN_STATUS.queued,
        sourceMode,
        snapshotVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
        snapshotHash: retrySnapshotHash(snapshot.snapshotHash),
        relevantBeliefIds: snapshot.beliefIds,
        insightRunId: snapshot.insightRunId,
        goalRunId: snapshot.goalRunId,
        promptVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
        schemaVersion: AGENTIC_RECOMMENDATION_SCHEMA_VERSION,
        result: {
          runtime: "agentic_shopify",
          status: "queued",
          candidateCount: snapshot.beliefIds.length,
          retryOfRunId: input.retryOfRunId ?? null,
          baseSnapshotHash: snapshot.snapshotHash,
          onboardingEpoch: input.onboardingEpoch ?? null,
          attemptNumber: input.attemptNumber ?? null,
          attemptReason: "explicit_retry",
        },
      },
    });
    return {
      status: "ready",
      run,
      snapshot,
      previousAttempt: await loadPreviousAttemptDiagnostics(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        runId: input.retryOfRunId,
      }),
    };
  }
  const run = await prisma.merchantPlanRun.upsert({
    where: {
      shopId_snapshotHash_promptVersion_schemaVersion: {
        shopId: input.shopId,
        snapshotHash: snapshot.snapshotHash,
        promptVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
        schemaVersion: AGENTIC_RECOMMENDATION_SCHEMA_VERSION,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: PLAN_RUN_STATUS.queued,
      sourceMode,
      snapshotVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
      snapshotHash: snapshot.snapshotHash,
      relevantBeliefIds: snapshot.beliefIds,
      insightRunId: snapshot.insightRunId,
      goalRunId: snapshot.goalRunId,
      promptVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
      schemaVersion: AGENTIC_RECOMMENDATION_SCHEMA_VERSION,
      result: {
        runtime: "agentic_shopify",
        status: "queued",
        candidateCount: snapshot.beliefIds.length,
        onboardingEpoch: input.onboardingEpoch ?? null,
        attemptNumber: input.attemptNumber ?? null,
      },
    },
    update: {
      relevantBeliefIds: snapshot.beliefIds,
      insightRunId: snapshot.insightRunId,
      goalRunId: snapshot.goalRunId,
      sourceMode,
    },
  });
  return { status: "ready", run, snapshot };
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {{ merchantId: string; shopId: string; runId?: string | null }} input */
async function loadPreparedAgenticRecommendationRun(prisma, input) {
  const run = await prisma.merchantPlanRun.findFirst({
    where: {
      id: input.runId ?? undefined,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!run) return prepareAgenticRecommendationRun(prisma, input);

  const snapshot = await buildAgenticRecommendationSnapshot(prisma, input);
  const result = jsonObject(run.result);

  // Ownership invariant: a worker job created for run X must execute run X, never
  // silently switch to run Y. The previous code fell through to prepareAgenticRecommendationRun
  // when the snapshot hash changed between enqueue and worker pickup, which created a new run Y
  // with sourceMode="agentic" and left X queued forever.
  //
  // Queued runs: the snapshot may legitimately change before pickup (Shopify webhooks,
  // Memory refresh, Action state changes, snapshot schema version bumps). Use the current
  // snapshot for the investigation — it is always fresher — and preserve all run identity:
  // id, sourceMode, retry metadata, creation origin. Do NOT create a new run.
  //
  // Running runs: snapshot is immutable for the attempt in progress.
  //
  // Terminal runs: snapshot changed after completion is the legitimate "something changed,
  // re-investigate" case — prepareAgenticRecommendationRun correctly creates a new run here.
  if (run.status === PLAN_RUN_STATUS.queued || run.status === PLAN_RUN_STATUS.running) {
    return {
      status: "ready",
      run,
      snapshot,
      previousAttempt: await loadPreviousAttemptDiagnostics(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        runId: typeof result.retryOfRunId === "string" ? result.retryOfRunId : null,
      }),
    };
  }

  if (run.snapshotHash !== snapshot.snapshotHash && result.baseSnapshotHash !== snapshot.snapshotHash) {
    return prepareAgenticRecommendationRun(prisma, input);
  }
  return {
    status: "ready",
    run,
    snapshot,
    previousAttempt: await loadPreviousAttemptDiagnostics(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runId: typeof result.retryOfRunId === "string" ? result.retryOfRunId : null,
    }),
  };
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {{ merchantId: string; shopId: string }} input */
export async function buildAgenticRecommendationSnapshot(prisma, input) {
  const [goalRun, insightRun, beliefs, priorRecommendations, context, coachingEvidence, activeActions, shopifyMirrorStatus] = await Promise.all([
    prisma.merchantGoalRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: GOAL_RUN_STATUS.completed,
        supersededAt: null,
      },
      include: { horizons: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.merchantInsightRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: INSIGHT_RUN_STATUS.completed,
        sourceMode: "full",
        supersededAt: null,
      },
      include: { findings: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.merchantMemoryBelief.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: { in: ACTIVE_BELIEF_STATUSES },
        supersededAt: null,
      },
      include: { evidence: { orderBy: { createdAt: "desc" }, take: 2 } },
    }),
    prisma.merchantPlanRecommendation.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        reviewStatus: {
          in: [
            PLAN_REVIEW_STATUS.proposed,
            PLAN_REVIEW_STATUS.accepted,
            PLAN_REVIEW_STATUS.rejected,
            PLAN_REVIEW_STATUS.refinementRequested,
            PLAN_REVIEW_STATUS.completed,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    retrieveMerchantContext(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      task: "agentic_recommendation",
      query:
        "Investigate the next concrete Shopify Action that best advances the merchant's goals.",
      tokenBudget: 8000,
    }).catch(() => ({ episodicMemory: [], actionMemory: [] })),
    (prisma.merchantMemoryEvidence?.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        evidenceType: { in: ["merchant_goal_coaching", "merchant_goal_document_context"] },
      },
      orderBy: { createdAt: "desc" },
      take: 8,
    }) ?? Promise.resolve([])).catch(() => []),
    // Active actions (proposed + accepted/in-progress, not superseded) for deduplication
    (prisma.merchantAction?.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: { in: ["proposed", "accepted"] },
      },
      select: { id: true, status: true, title: true, plan: true, outcome: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }) ?? Promise.resolve([])).catch(() => []),
    // Shopify mirror watermark: updatedAt of the merchant_memory backfill status record.
    // This timestamp is written whenever a Shopify webhook triggers a memory refresh
    // (enqueueMerchantMemoryRefresh → upsertBackfillStatus). Including it in the
    // snapshot hash makes the reuse key sensitive to Shopify mutations — when
    // product status, inventory, or other mutable Shopify state changes, the webhook
    // fires, the watermark advances, and the hash changes, forcing a fresh investigation
    // rather than blindly reusing a stale no_actionable_opportunity result.
    (prisma.shopBackfillStatus?.findUnique?.({
      where: { shopId_domain: { shopId: input.shopId, domain: MEMORY_BACKFILL_DOMAIN } },
      select: { updatedAt: true },
    }) ?? Promise.resolve(null)).catch(() => null),
  ]);
  const goals = (goalRun?.horizons ?? []).map((/** @type {any} */ goal) => ({
    id: goal.id,
    horizon: goal.horizon,
    title: safeText(goal.title, 120),
    description: safeText(goal.description, 280),
    supportingBeliefIds: goal.supportingBeliefIds ?? [],
    generatedBy: "jefe_llm",
    authority: "jefe_interpretation",
  }));
  const insights = (insightRun?.findings ?? []).map((/** @type {any} */ finding) => ({
    id: finding.id,
    title: safeText(finding.title, 120),
    finding: safeText(finding.finding, 280),
    whyItMatters: safeText(finding.whyItMatters, 220),
    category: finding.category,
    confidence: finding.confidence,
    supportingBeliefIds: finding.supportingBeliefIds ?? [],
    generatedBy: "jefe_llm",
    authority: "jefe_interpretation",
  }));
  const allNormalizedBeliefs = beliefs.map(normalizeBelief).filter(Boolean);

  // Partition by llmExposure: guardrails go to a separate confidence section,
  // all other beliefs (core, on_demand, non-registry) are model-visible evidence.
  const visibleBeliefs = allNormalizedBeliefs
    .filter((b) => resolveExposure(b.key) !== "guardrail")
    .sort(compareBeliefStable);
  const guardrailBeliefs = allNormalizedBeliefs
    .filter((b) => resolveExposure(b.key) === "guardrail")
    .sort(compareBeliefStable);

  const activeWork = (activeActions ?? [])
    .map(buildActiveWorkItem)
    .filter(Boolean);
  const snapshot = {
    snapshotVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
    merchantId: input.merchantId,
    shopId: input.shopId,
    privacy: {
      source: "merchant_memory_goals_insights_and_bounded_shopify_reads",
      excludesCredentialsAndTokens: true,
      excludesFullUploadedDocuments: true,
    },
    goalCoaching: (coachingEvidence ?? []).map((/** @type {any} */ item) => ({
      id: item.id,
      sourceType: item.sourceType,
      evidenceType: item.evidenceType,
      summary: safeText(item.summary, 600),
      observedAt: item.observedAt?.toISOString?.() ?? null,
      authority: "merchant_stated",
    })).reverse(),
    goals,
    insights,
    beliefCount: visibleBeliefs.length,
    beliefs: visibleBeliefs,
    // Internal guardrails (data quality / coverage) — kept available server-side for
    // confidence context but not surfaced as recommendation evidence. Excluded from
    // the snapshot hash so guardrail-only changes do not invalidate recommendation reuse.
    dataQualityContext: guardrailBeliefs,
    merchantContext: [
      ...(context.episodicMemory ?? []).slice(0, 12).map((/** @type {any} */ item) => ({
        id: item.id,
        sourceType: "conversation_episode",
        summary: safeText(item.content, 700),
        observedAt: item.occurredAt,
      })),
      ...(context.actionMemory ?? []).slice(0, 8).map((/** @type {any} */ item) => ({
        id: item.id,
        sourceType: "action_memory",
        summary: safeText(item.content, 700),
        observedAt: item.occurredAt,
      })),
    ],
    previousRecommendations: priorRecommendations.map((/** @type {any} */ item) => ({
      id: item.id,
      title: safeText(item.title, 120),
      summary: safeText(item.summary, 280),
      reviewStatus: item.reviewStatus,
    })),
    activeWork,
    // Shopify mirror watermark: included in the hash so that any Shopify mutation
    // that fires a webhook → enqueueMerchantMemoryRefresh → upsertBackfillStatus
    // advances this timestamp and invalidates any cached snapshot result.
    shopifyMirrorWatermark: shopifyMirrorStatus?.updatedAt?.toISOString?.() ?? null,
  };
  // Hash over only the model-visible portion of the snapshot. dataQualityContext
  // (internal guardrails) is intentionally excluded: guardrail-only changes do not
  // invalidate recommendation reuse, since they don't affect what Luna sees.
  // eslint-disable-next-line no-unused-vars -- destructured only to exclude it from hashableSnapshot
  const { dataQualityContext: _excludedFromHash, ...hashableSnapshot } = snapshot;
  return {
    snapshot,
    snapshotHash: hashJson(hashableSnapshot),
    beliefIds: allNormalizedBeliefs.map((/** @type {any} */ belief) => belief.id),
    insightRunId: insightRun?.id ?? null,
    goalRunId: goalRun?.id ?? null,
    hasGoals: goals.length === 3,
  };
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {{ merchantId: string; shopId: string; run: any; recommendation: any; diagnostics?: any; trace?: any }} input */
async function persistAgenticRecommendation(prisma, input) {
  return prisma.$transaction(async (/** @type {any} */ tx) => {
    await supersedeAllProposedRecommendations(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
    });
    const recommendation = input.recommendation;
    const runMetadata = agenticRunMetadata(input.run);
    const semanticAction = semanticActionFromRecommendation(recommendation);
    const persistedRecommendation = await tx.merchantPlanRecommendation.upsert({
      where: { runId: input.run.id },
      create: {
        runId: input.run.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        title: recommendation.title,
        summary: recommendation.summary,
        primaryGoalId: recommendation.supportingGoalIds?.[0] ?? null,
        supportingGoalIds: recommendation.supportingGoalIds ?? [],
        whyThisAction: recommendation.whyThisAction,
        whyNow: recommendation.whyNow,
        startToday: recommendation.outcome,
        successSignal: {
          description: recommendation.verificationPlan,
          semanticOutcome: recommendation.outcome,
          scope: recommendation.scope,
          constraints: recommendation.constraints ?? [],
          eligibilityCriteria: recommendation.eligibilityCriteria ?? [],
          writeProtections: recommendation.writeProtections ?? [],
          materialExpectedEffects: recommendation.materialExpectedEffects ?? [],
          feasibleWriteOperations: recommendation.feasibleWriteOperations ?? [],
          diagnosedProblem: recommendation.diagnosedProblem ?? null,
          mechanism: recommendation.mechanism ?? null,
        },
        expectedBenefit: recommendation.materialExpectedEffects?.join("; ") || recommendation.summary,
        supportingBeliefIds: recommendation.supportingBeliefIds ?? [],
        supportingInsightIds: recommendation.supportingInsightIds ?? [],
        confidence: recommendation.confidence ?? "emerging",
        assumption: recommendation.assumption ?? null,
        caveat: recommendation.caveat ?? null,
        sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
        reviewStatus: PLAN_REVIEW_STATUS.proposed,
        outcomeStatus: "pending",
        reviewAt: new Date(Date.now() + 14 * 86400000),
      },
      update: {
        title: recommendation.title,
        summary: recommendation.summary,
        whyThisAction: recommendation.whyThisAction,
        whyNow: recommendation.whyNow,
        startToday: recommendation.outcome,
        successSignal: {
          description: recommendation.verificationPlan,
          semanticOutcome: recommendation.outcome,
          scope: recommendation.scope,
          constraints: recommendation.constraints ?? [],
          eligibilityCriteria: recommendation.eligibilityCriteria ?? [],
          writeProtections: recommendation.writeProtections ?? [],
          materialExpectedEffects: recommendation.materialExpectedEffects ?? [],
          feasibleWriteOperations: recommendation.feasibleWriteOperations ?? [],
          diagnosedProblem: recommendation.diagnosedProblem ?? null,
          mechanism: recommendation.mechanism ?? null,
        },
        expectedBenefit: recommendation.materialExpectedEffects?.join("; ") || recommendation.summary,
        supportingBeliefIds: recommendation.supportingBeliefIds ?? [],
        supportingInsightIds: recommendation.supportingInsightIds ?? [],
        confidence: recommendation.confidence ?? "emerging",
        assumption: recommendation.assumption ?? null,
        caveat: recommendation.caveat ?? null,
        sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
        reviewStatus: PLAN_REVIEW_STATUS.proposed,
      },
    });
    const revisionHistory = [revisionSnapshot(semanticAction, "recommendation")];
    const actionData = {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceRecommendationId: persistedRecommendation.id,
      title: semanticAction.title,
      summary: semanticAction.summary,
      status: "proposed",
      plan: {
        agentic: {
          runtime: "shopify_admin_api",
          currentActionRevision: semanticAction.revision,
          originalActionRevision: semanticAction.revision,
          semanticAction,
          revisionHistory,
        },
      },
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          currentActionRevision: semanticAction.revision,
          originalActionRevision: semanticAction.revision,
          semanticAction,
          revisionHistory,
          diagnostics: input.diagnostics ?? {},
        },
      },
      outcome: {},
    };
    const action = await tx.merchantAction.upsert({
      where: { sourceRecommendationId: persistedRecommendation.id },
      create: actionData,
      update: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        title: semanticAction.title,
        summary: semanticAction.summary,
        status: "proposed",
        plan: {
          agentic: {
            runtime: "shopify_admin_api",
            currentActionRevision: semanticAction.revision,
            originalActionRevision: semanticAction.revision,
            semanticAction,
            revisionHistory,
          },
        },
        progress: {
          agentic: {
            runtime: "shopify_admin_api",
            currentActionRevision: semanticAction.revision,
            originalActionRevision: semanticAction.revision,
            semanticAction,
            revisionHistory,
            diagnostics: input.diagnostics ?? {},
          },
        },
        outcome: {},
      },
    });
    await tx.merchantActionEvent?.create?.({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        merchantActionId: action.id,
        eventType: "agentic_shopify_action_proposed",
        metadata: {
          recommendationId: persistedRecommendation.id,
          currentActionRevision: semanticAction.revision,
          feasibleWriteOperations: semanticAction.feasibleWriteOperations,
        },
      },
    });
    await tx.merchantPlanRun.update({
      where: { id: input.run.id },
      data: {
        status: PLAN_RUN_STATUS.completed,
        completedAt: new Date(),
        safeErrorCode: null,
        lastError: null,
        // sourceMode is intentionally omitted — preserve the value set by the caller so
        // "home"-triggered runs stay filterable by isHomeProposalGenerationInFlight.
        result: {
          runtime: "agentic_shopify",
          ...runMetadata,
          status: "RECOMMEND_ACTION",
          recommendationId: persistedRecommendation.id,
          actionId: action.id,
          semanticActionRevision: semanticAction.revision,
          diagnostics: input.diagnostics ?? {},
          trace: safeTrace(input.trace),
        },
      },
    });
    return { recommendation: persistedRecommendation, action };
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; statuses?: string[] }} input
 */
async function findLatestAgenticRecommendationRun(prisma, input) {
  return prisma.merchantPlanRun.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      // Include home-triggered runs alongside agentic so retry diagnostics are
      // available regardless of which sourceMode triggered the previous attempt.
      sourceMode: { in: [AGENTIC_RECOMMENDATION_SOURCE_MODE, "home"] },
      ...(Array.isArray(input.statuses) && input.statuses.length
        ? { status: { in: input.statuses } }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string }} input
 */
async function loadOnboardingEpoch(prisma, input) {
  if (typeof prisma.backfillJob?.findUnique !== "function") return null;
  const bootstrap = await prisma.backfillJob.findUnique({
    where: {
      shopId_jobType: {
        shopId: input.shopId,
        jobType: MERCHANT_BOOTSTRAP_JOB_TYPE,
      },
    },
    select: { payloadJson: true },
  });
  const payload = jsonObject(bootstrap?.payloadJson);
  return typeof payload.onboardingEpoch === "string"
    ? payload.onboardingEpoch
    : null;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
async function nextAgenticRecommendationAttemptNumber(prisma, input) {
  if (typeof prisma.merchantPlanRun?.count !== "function") return null;
  const priorAttempts = await prisma.merchantPlanRun.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
    },
  });
  return priorAttempts + 1;
}

/** @param {any} run */
function agenticRunMetadata(run) {
  const result = jsonObject(run?.result);
  return {
    retryOfRunId: typeof result.retryOfRunId === "string" ? result.retryOfRunId : null,
    baseSnapshotHash: typeof result.baseSnapshotHash === "string" ? result.baseSnapshotHash : null,
    onboardingEpoch: typeof result.onboardingEpoch === "string" ? result.onboardingEpoch : null,
    attemptNumber: Number.isFinite(result.attemptNumber) ? Number(result.attemptNumber) : null,
    attemptReason: typeof result.attemptReason === "string" ? result.attemptReason : null,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null }} input
 */
async function loadPreviousAttemptDiagnostics(prisma, input) {
  if (!input.runId) return null;
  const run = await prisma.merchantPlanRun.findFirst({
    where: {
      id: input.runId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!run) return null;
  const result = jsonObject(run.result);
  const diagnostics = jsonObject(result.diagnostics);
  const trace = jsonObject(result.trace);
  const toolResults = Array.isArray(trace.toolResults) ? trace.toolResults : [];
  const turns = Array.isArray(trace.turns) ? trace.turns : [];
  return {
    runId: run.id,
    status: run.status,
    resultStatus: typeof result.status === "string" ? result.status : null,
    safeErrorCode: run.safeErrorCode ?? null,
    blocker: safeText(result.blocker ?? run.lastError ?? null, 300),
    validationErrors: toolResults
      .filter((row) => row?.tool === "recommendation_validation" && row?.ok === false)
      .map((row) => ({
        code: safeText(row?.error?.code ?? "VALIDATION_FAILED", 120),
        message: safeText(row?.message ?? row?.error?.message, 300),
      }))
      .slice(-6),
    retrievedOperations: uniqueStrings(diagnostics.retrievedOperations).slice(0, 12),
    shopifyReads: Array.isArray(diagnostics.shopifyReads)
      ? diagnostics.shopifyReads
          .map((row) => ({
            operation: safeText(row?.operation, 120),
            ok: row?.ok === true,
            status: safeText(row?.status, 80),
          }))
          .slice(-12)
      : [],
    feasibleInterventions: uniqueStrings(diagnostics.feasibleInterventions).slice(-8),
    finalTurn: turns.length
      ? {
          status: safeText(turns[turns.length - 1]?.status, 80),
          toolCallCount: Number(turns[turns.length - 1]?.toolCallCount ?? 0),
        }
      : null,
  };
}

/** @param {string} baseSnapshotHash */
function retrySnapshotHash(baseSnapshotHash) {
  return hashJson({ baseSnapshotHash, retryAttemptId: randomUUID() });
}

/** @param {unknown} status */
function agenticRecommendationSafeErrorCode(status) {
  if (status === "NO_ACTIONABLE_OPPORTUNITY") return null;
  if (status === "BLOCKED") return null; // legitimate no-opportunity; not a system error
  if (status === "VALIDATION_FAILED") return "agentic_recommendation_validation_failed";
  if (status === "INVESTIGATION_FAILED") return "agentic_recommendation_investigation_failed";
  if (status === "INSUFFICIENT_EVIDENCE") return "agentic_recommendation_insufficient_evidence";
  return "agentic_recommendation_blocked";
}

/** @param {any} row */
function normalizeBelief(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    key: row.key,
    category: row.category,
    label: row.label ?? row.key,
    val: row.value,
    value: row.value,
    type: row.valueType,
    status: row.status,
    authority: authorityLevel(row.precedence, row.status, row.evidence ?? []),
    llmExposure: resolveExposure(row.key),
    confidence: Number(row.confidence ?? 0),
    evidence: (row.evidence ?? []).map((/** @type {any} */ item) => ({
      id: item.id,
      summary: safeText(item.summary, 500),
      sourceType: item.sourceType,
      evidenceType: item.evidenceType,
      observedAt: item.observedAt?.toISOString?.() ?? null,
    })),
  };
}

/** @param {unknown} value */
function safeTrace(value) {
  const trace = value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
  return {
    turns: Array.isArray(trace.turns)
      ? trace.turns.map((/** @type {any} */ turn) => ({
          status: turn.status,
          hypothesesConsidered: turn.hypothesesConsidered ?? [],
          toolCallCount: Array.isArray(turn.toolCalls) ? turn.toolCalls.length : 0,
        }))
      : [],
    toolResults: Array.isArray(trace.toolResults)
      ? trace.toolResults.map((/** @type {any} */ row) => ({
          tool: row.tool,
          ok: row.ok,
          message: row.message,
          facts: {
            query: row.facts?.query ?? null,
            operation: row.facts?.operation ?? null,
            status: row.facts?.status ?? null,
            gatewayDecision: row.facts?.gatewayDecision ?? null,
          },
          error: row.error ?? null,
        }))
      : [],
    progressLog: Array.isArray(trace.progressLog) ? trace.progressLog : [],
  };
}

/** @param {unknown} value @param {number} [max] */
function safeText(value, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => safeText(item, 220)).filter(Boolean))];
}

/** @param {unknown} value */
export function hashJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value ?? null);
  const object = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
