// @ts-check

import { createHash } from "node:crypto";
import { createLlmProvider } from "../../llm/provider.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
} from "../../merchant-memory/constants.server.js";
import { retrieveMerchantContext } from "../../merchant-memory/merchant-context.server.js";
import { GOAL_RUN_STATUS } from "../../merchant-goals/constants.server.js";
import { INSIGHT_RUN_STATUS } from "../../merchant-insights/constants.server.js";
import {
  PLAN_REVIEW_STATUS,
  PLAN_RUN_STATUS,
} from "../../merchant-plan/constants.server.js";
import { supersedeAllProposedRecommendations } from "../../merchant-plan/proposal-creation-invariant.server.js";
import { enqueueBackfillJob } from "../../../services/shopify-backfill-status.server.js";
import { ShopifyAdminGraphqlClient } from "../admin-graphql.server.js";
import { generateAgenticShopifyRecommendation } from "./recommendation-agent.server.js";
import {
  AGENTIC_RECOMMENDATION_JOB_TYPE,
  AGENTIC_RECOMMENDATION_SCHEMA_VERSION,
  AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
  AGENTIC_RECOMMENDATION_SOURCE_MODE,
} from "./constants.server.js";
import {
  semanticActionFromRecommendation,
} from "./semantic-action.server.js";

const ACTIVE_RUN_STATUSES = [PLAN_RUN_STATUS.queued, PLAN_RUN_STATUS.running];
const MAX_AGENTIC_BELIEFS = 40;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function ensureAgenticRecommendationQueued(prisma, input) {
  const prepared = await prepareAgenticRecommendationRun(prisma, input);
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
      sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
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
      snapshotHash: prepared.snapshot.snapshotHash,
      reason: "merchant_goals_ready",
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
 *   fetchImpl?: typeof fetch;
 *   llmProvider?: import("../../llm/provider.server.js").LlmProvider;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
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
      sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
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
    const result = await generateAgenticShopifyRecommendation({
      provider,
      prisma,
      client,
      merchantId: input.merchantId,
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      grantedScopes: input.scopes,
      snapshot: prepared.snapshot.snapshot,
      logger,
    });
    if (result.ok && result.status === "RECOMMEND_ACTION") {
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
    const terminalStatus = result.status === "NO_ACTIONABLE_OPPORTUNITY"
      ? "no_actionable_opportunity"
      : PLAN_RUN_STATUS.failed;
    await prisma.merchantPlanRun.update({
      where: { id: run.id },
      data: {
        status: terminalStatus,
        completedAt: terminalStatus === "no_actionable_opportunity" ? new Date() : null,
        failedAt: terminalStatus === PLAN_RUN_STATUS.failed ? new Date() : null,
        safeErrorCode: result.status === "NO_ACTIONABLE_OPPORTUNITY" ? null : "agentic_recommendation_blocked",
        lastError: result.blocker ?? null,
        result: {
          runtime: "agentic_shopify",
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

/** @param {import("@prisma/client").PrismaClient} prisma @param {{ merchantId: string; shopId: string }} input */
async function prepareAgenticRecommendationRun(prisma, input) {
  const snapshot = await buildAgenticRecommendationSnapshot(prisma, input);
  if (!snapshot.hasGoals) return { status: "missing_completed_goals", snapshot };
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
      sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
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
      },
    },
    update: {
      relevantBeliefIds: snapshot.beliefIds,
      insightRunId: snapshot.insightRunId,
      goalRunId: snapshot.goalRunId,
      sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
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
  if (run.snapshotHash !== snapshot.snapshotHash) return prepareAgenticRecommendationRun(prisma, input);
  return { status: "ready", run, snapshot };
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {{ merchantId: string; shopId: string }} input */
async function buildAgenticRecommendationSnapshot(prisma, input) {
  const [goalRun, insightRun, beliefs, priorRecommendations, context] = await Promise.all([
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
      orderBy: [{ precedence: "desc" }, { updatedAt: "desc" }],
      take: MAX_AGENTIC_BELIEFS,
    }),
    prisma.merchantPlanRecommendation.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        reviewStatus: {
          in: [
            PLAN_REVIEW_STATUS.accepted,
            PLAN_REVIEW_STATUS.rejected,
            PLAN_REVIEW_STATUS.refinementRequested,
            PLAN_REVIEW_STATUS.completed,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    retrieveMerchantContext(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      task: "agentic_recommendation",
      query:
        "Investigate the next concrete Shopify Action that best advances the merchant's goals.",
      tokenBudget: 8000,
    }).catch(() => ({ episodicMemory: [], actionMemory: [] })),
  ]);
  const goals = (goalRun?.horizons ?? []).map((/** @type {any} */ goal) => ({
    id: goal.id,
    horizon: goal.horizon,
    title: safeText(goal.title, 120),
    description: safeText(goal.description, 280),
    supportingBeliefIds: goal.supportingBeliefIds ?? [],
  }));
  const insights = (insightRun?.findings ?? []).map((/** @type {any} */ finding) => ({
    id: finding.id,
    title: safeText(finding.title, 120),
    finding: safeText(finding.finding, 280),
    whyItMatters: safeText(finding.whyItMatters, 220),
    category: finding.category,
    confidence: finding.confidence,
    supportingBeliefIds: finding.supportingBeliefIds ?? [],
  }));
  const normalizedBeliefs = beliefs.map(normalizeBelief).filter(Boolean);
  const snapshot = {
    snapshotVersion: AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION,
    merchantId: input.merchantId,
    shopId: input.shopId,
    privacy: {
      source: "merchant_memory_goals_insights_and_bounded_shopify_reads",
      excludesCredentialsAndTokens: true,
      excludesFullUploadedDocuments: true,
    },
    goals,
    insights,
    beliefCount: normalizedBeliefs.length,
    beliefs: normalizedBeliefs,
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
  };
  return {
    snapshot,
    snapshotHash: hashJson(snapshot),
    beliefIds: normalizedBeliefs.map((/** @type {any} */ belief) => belief.id),
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
          materialExpectedEffects: recommendation.materialExpectedEffects ?? [],
          feasibleWriteOperations: recommendation.feasibleWriteOperations ?? [],
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
          materialExpectedEffects: recommendation.materialExpectedEffects ?? [],
          feasibleWriteOperations: recommendation.feasibleWriteOperations ?? [],
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
          semanticAction,
        },
      },
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          currentActionRevision: semanticAction.revision,
          semanticAction,
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
            semanticAction,
          },
        },
        progress: {
          agentic: {
            runtime: "shopify_admin_api",
            currentActionRevision: semanticAction.revision,
            semanticAction,
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
        sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE,
        result: {
          runtime: "agentic_shopify",
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
    authority: row.precedence,
    confidence: Number(row.confidence ?? 0),
    evidence: (row.evidence ?? []).map((/** @type {any} */ item) => ({
      id: item.id,
      summary: safeText(item.summary, 500),
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
  };
}

/** @param {unknown} value @param {number} [max] */
function safeText(value, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {unknown} value */
function hashJson(value) {
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
