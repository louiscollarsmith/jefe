// @ts-nocheck

import { LlmOutputValidationError } from "../llm/errors.server.js";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  confirmBelief,
  correctBelief,
  recordEvidence,
} from "../merchant-memory/service.server.js";
import { getBeliefDefinition } from "../merchant-memory/conversational-belief-registry.server.js";
import {
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
} from "../merchant-memory/constants.server.js";
import { OPERATION_TYPES } from "../merchant-memory/conversation-constants.server.js";
import { validateStructuredOperation } from "../merchant-memory/conversation.server.js";
import { enqueueBackfillJob } from "../../services/shopify-backfill-status.server.js";
import { buildMerchantInsightSnapshot } from "./candidates.server.js";
import {
  INSIGHT_REVIEW_STATUS,
  INSIGHT_RUN_STATUS,
  MERCHANT_INSIGHTS_JOB_TYPE,
  MERCHANT_INSIGHTS_PROMPT_VERSION,
  MERCHANT_INSIGHTS_SCHEMA_VERSION,
  MERCHANT_INSIGHTS_SNAPSHOT_VERSION,
  MIN_USEFUL_INSIGHT_BELIEFS,
} from "./constants.server.js";
import {
  MERCHANT_INSIGHTS_OUTPUT_SCHEMA,
  parseAndValidateMerchantInsightsOutput,
} from "./schema.server.js";
import {
  buildMerchantInsightsPrompt,
  buildMerchantInsightsSystemPrompt,
} from "./prompt.server.js";

const ACTIVE_RUN_STATUSES = [
  INSIGHT_RUN_STATUS.queued,
  INSIGHT_RUN_STATUS.running,
];
/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function ensureMerchantInsightsQueued(prisma, input) {
  const prepared = await prepareInsightRun(prisma, input);
  if (prepared.status !== "ready") return prepared;
  const run = prepared.run;

  if (
    run.status === INSIGHT_RUN_STATUS.completed ||
    run.status === INSIGHT_RUN_STATUS.running ||
    (!input.resetAttempts &&
      (run.status === INSIGHT_RUN_STATUS.insufficientData ||
        run.status === INSIGHT_RUN_STATUS.modelDisabled ||
        run.status === INSIGHT_RUN_STATUS.failed))
  ) {
    return { status: "reused", run, snapshot: prepared.snapshot };
  }

  await prisma.merchantInsightRun.update({
    where: { id: run.id },
    data: {
      status: INSIGHT_RUN_STATUS.queued,
      safeErrorCode: null,
      lastError: null,
      failedAt: null,
    },
  });

  await enqueueBackfillJob(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    jobType: MERCHANT_INSIGHTS_JOB_TYPE,
    runAfter: input.runAfter,
    resetAttempts: input.resetAttempts,
    payload: {
      runId: run.id,
      snapshotHash: prepared.snapshot.snapshotHash,
      reason: "merchant_memory_ready",
    },
  });

  return { status: "queued", run, snapshot: prepared.snapshot };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function getMerchantInsightsExperience(prisma, input) {
  const snapshot = await buildMerchantInsightSnapshot(prisma, input);
  const [currentRun, previousCompletedRun, activeJob] = await Promise.all([
    prisma.merchantInsightRun.findUnique({
      where: {
        shopId_beliefSnapshotHash_promptVersion_schemaVersion: {
          shopId: input.shopId,
          beliefSnapshotHash: snapshot.snapshotHash,
          promptVersion: MERCHANT_INSIGHTS_PROMPT_VERSION,
          schemaVersion: MERCHANT_INSIGHTS_SCHEMA_VERSION,
        },
      },
      include: { findings: { orderBy: { orderIndex: "asc" } } },
    }),
    prisma.merchantInsightRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: INSIGHT_RUN_STATUS.completed,
        beliefSnapshotHash: { not: snapshot.snapshotHash },
      },
      include: { findings: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.backfillJob.findUnique({
      where: {
        shopId_jobType: {
          shopId: input.shopId,
          jobType: MERCHANT_INSIGHTS_JOB_TYPE,
        },
      },
    }),
  ]);

  const selectedRun =
    currentRun?.status === INSIGHT_RUN_STATUS.completed
      ? currentRun
      : (previousCompletedRun ?? currentRun);

  return {
    snapshotHash: snapshot.snapshotHash,
    candidateCount: snapshot.candidateCount,
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
      selectedRun.status === INSIGHT_RUN_STATUS.completed &&
      selectedRun.beliefSnapshotHash !== snapshot.snapshotHash,
    ),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function generateMerchantInsights(prisma, input) {
  const logger = input.logger ?? console;
  const prepared = input.runId
    ? await loadPreparedRun(prisma, input)
    : await prepareInsightRun(prisma, input);
  if (prepared.status !== "ready") return prepared;

  const run = prepared.run;
  const snapshot = prepared.snapshot;

  if (snapshot.candidateCount < MIN_USEFUL_INSIGHT_BELIEFS) {
    await prisma.merchantInsightRun.update({
      where: { id: run.id },
      data: {
        status: INSIGHT_RUN_STATUS.insufficientData,
        completedAt: new Date(),
        result: {
          reason: "insufficient_supported_beliefs",
          candidateCount: snapshot.candidateCount,
        },
      },
    });
    return { status: INSIGHT_RUN_STATUS.insufficientData, runId: run.id };
  }

  const provider = input.llmProvider ?? createLlmProvider({ logger });
  await prisma.merchantInsightRun.update({
    where: { id: run.id },
    data: {
      status: INSIGHT_RUN_STATUS.running,
      startedAt: new Date(),
      failedAt: null,
      safeErrorCode: null,
      lastError: null,
      provider: provider.provider,
      modelIdentifier: provider.model,
    },
  });

  if (!provider.enabled || !provider.generateStructuredJson) {
    await prisma.merchantInsightRun.update({
      where: { id: run.id },
      data: {
        status: INSIGHT_RUN_STATUS.modelDisabled,
        completedAt: new Date(),
        safeErrorCode: "llm_disabled",
        result: { reason: "llm_disabled" },
      },
    });
    return { status: INSIGHT_RUN_STATUS.modelDisabled, runId: run.id };
  }

  try {
    const llmResult = await provider.generateStructuredJson({
      systemPrompt: buildMerchantInsightsSystemPrompt(),
      prompt: buildMerchantInsightsPrompt(snapshot.snapshot),
      schema: MERCHANT_INSIGHTS_OUTPUT_SCHEMA,
      maxInputTokens: 16000,
      maxOutputTokens: 3600,
      timeoutMs: 15_000,
    });
    const parsed = parseAndValidateMerchantInsightsOutput(llmResult.json, {
      allowedBeliefIds: new Set(snapshot.beliefIds),
      suppliedBeliefs: snapshot.snapshot.beliefs,
    });
    if (!parsed.ok) {
      throw new LlmOutputValidationError(parsed.error);
    }
    if (parsed.insights.length === 0) {
      await prisma.merchantInsightRun.update({
        where: { id: run.id },
        data: {
          status: INSIGHT_RUN_STATUS.insufficientData,
          completedAt: new Date(),
          result: {
            reason: "empty_valid_output",
            usage: llmResult.usage,
            attempts: llmResult.attempts,
          },
        },
      });
      return { status: INSIGHT_RUN_STATUS.insufficientData, runId: run.id };
    }

    await prisma.$transaction(async (tx) => {
      await tx.merchantInsightFinding.deleteMany({ where: { runId: run.id } });
      await tx.merchantInsightFinding.createMany({
        data: parsed.insights.map((insight, index) => ({
          runId: run.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          orderIndex: index + 1,
          title: insight.title,
          finding: insight.finding,
          whyItMatters: insight.whyItMatters,
          confidence: insight.confidence,
          category: insight.category,
          caveat: insight.caveat,
          supportingBeliefIds: insight.supportingBeliefIds,
        })),
      });
      await tx.merchantInsightRun.updateMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: INSIGHT_RUN_STATUS.completed,
          id: { not: run.id },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      await tx.merchantInsightRun.update({
        where: { id: run.id },
        data: {
          status: INSIGHT_RUN_STATUS.completed,
          completedAt: new Date(),
          safeErrorCode: null,
          lastError: null,
          result: {
            insightCount: parsed.insights.length,
            usage: llmResult.usage,
            attempts: llmResult.attempts,
            durationMs: llmResult.durationMs,
          },
        },
      });
    });

    logger.info("Merchant insights generated", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runId: run.id,
      insightCount: parsed.insights.length,
    });
    return {
      status: INSIGHT_RUN_STATUS.completed,
      runId: run.id,
      insightCount: parsed.insights.length,
    };
  } catch (error) {
    const safe = insightGenerationFailure(error);
    await prisma.merchantInsightRun.update({
      where: { id: run.id },
      data: {
        status: INSIGHT_RUN_STATUS.failed,
        failedAt: new Date(),
        safeErrorCode: safe.code,
        lastError: safe.message,
        result: {
          errorName: error instanceof Error ? error.name : "Error",
        },
      },
    });
    throw error;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; message?: string | null }} input
 */
export async function markMerchantInsightsJobFailed(prisma, input) {
  if (!input.runId) return null;
  return prisma.merchantInsightRun.updateMany({
    where: {
      id: input.runId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: { in: ACTIVE_RUN_STATUSES },
    },
    data: {
      status: INSIGHT_RUN_STATUS.failed,
      failedAt: new Date(),
      safeErrorCode: "job_failed",
      lastError: safeErrorText(input.message ?? "Insight generation failed."),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; findingId: string }} input
 */
export async function confirmMerchantInsightFinding(prisma, input) {
  const finding = await prisma.merchantInsightFinding.findFirstOrThrow({
    where: {
      id: input.findingId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      id: { in: finding.supportingBeliefIds },
    },
    include: { evidence: { take: 3, orderBy: { createdAt: "desc" } } },
  });
  const now = new Date();
  for (const belief of beliefs) {
    const definition = getBeliefDefinition(belief.key);
    if (
      definition?.confirmable &&
      !isDeterministicObservation(belief) &&
      belief.status !== BELIEF_STATUS.merchantConfirmed &&
      belief.status !== BELIEF_STATUS.merchantCorrected
    ) {
      await confirmBelief(prisma, {
        merchantId: input.merchantId,
        key: belief.key,
        confirmedBy: "merchant_insights",
        evidenceSummary: `Merchant confirmed an insight supported by ${definition.label}.`,
        evidenceSourceType: "merchant_insights",
        evidenceSourceReference: `merchant_insight_finding:${finding.id}`,
        metadata: { findingId: finding.id, runId: finding.runId },
      });
    } else {
      await recordEvidence(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        beliefId: belief.id,
        sourceType: "merchant_insights",
        sourceReference: `merchant_insight_finding:${finding.id}`,
        evidenceType: "merchant_review",
        summary:
          "Merchant confirmed the insight review without changing the source belief.",
        metadata: { findingId: finding.id, runId: finding.runId },
        observedAt: now,
      });
    }
  }
  return prisma.merchantInsightFinding.update({
    where: { id: finding.id },
    data: {
      reviewStatus: INSIGHT_REVIEW_STATUS.confirmed,
      reviewedAt: now,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; findingId: string; beliefId: string; correction: string }} input
 */
export async function correctMerchantInsightFinding(prisma, input) {
  const correction = input.correction.trim();
  if (correction.length < 2)
    return { ok: false, error: "Correction is required." };
  const finding = await prisma.merchantInsightFinding.findFirstOrThrow({
    where: {
      id: input.findingId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!finding.supportingBeliefIds.includes(input.beliefId)) {
    return { ok: false, error: "That belief does not support this insight." };
  }
  const belief = await prisma.merchantMemoryBelief.findFirstOrThrow({
    where: {
      id: input.beliefId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  const definition = getBeliefDefinition(belief.key);
  if (!definition?.merchantCorrectable) {
    return {
      ok: false,
      error:
        "I should keep that observed Shopify fact separate from merchant interpretation.",
    };
  }
  const operation = {
    operationType: OPERATION_TYPES.correctBelief,
    targetBeliefKey: belief.key,
    targetBeliefId: belief.id,
    category: belief.category,
    proposedValue: valueFromCorrection(correction, definition.valueType),
    valueType: definition.valueType,
    reason: "Merchant corrected a belief from the Insights onboarding review.",
    merchantStatement: correction,
    confidence: 0.95,
    requiresConfirmation: false,
  };
  const validation = await validateStructuredOperation(prisma, {
    merchantId: input.merchantId,
    operation,
    beliefs: [belief],
  });
  if (!validation.ok) return { ok: false, error: validation.error };

  await correctBelief(prisma, {
    merchantId: input.merchantId,
    key: belief.key,
    value: operation.proposedValue,
    valueType: operation.valueType,
    correctedBy: "merchant_insights",
    evidenceSummary: `Merchant corrected this during Insights onboarding: ${correction.slice(0, 240)}`,
    evidenceSourceType: "merchant_insights",
    evidenceSourceReference: `merchant_insight_finding:${finding.id}`,
    metadata: { findingId: finding.id, runId: finding.runId },
  });
  const updated = await prisma.merchantInsightFinding.update({
    where: { id: finding.id },
    data: {
      reviewStatus: INSIGHT_REVIEW_STATUS.corrected,
      reviewedAt: new Date(),
      correctedAt: new Date(),
    },
  });
  return { ok: true, finding: updated };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
async function prepareInsightRun(prisma, input) {
  const snapshot = await buildMerchantInsightSnapshot(prisma, input);
  if (snapshot.candidateCount === 0) {
    return { status: "insufficient_candidates", snapshot };
  }
  const data = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    status: INSIGHT_RUN_STATUS.queued,
    beliefSnapshotVersion: MERCHANT_INSIGHTS_SNAPSHOT_VERSION,
    beliefSnapshotHash: snapshot.snapshotHash,
    relevantBeliefIds: snapshot.beliefIds,
    memoryRefreshRunId: snapshot.memoryRefreshRunId,
    promptVersion: MERCHANT_INSIGHTS_PROMPT_VERSION,
    schemaVersion: MERCHANT_INSIGHTS_SCHEMA_VERSION,
  };
  const run = await prisma.merchantInsightRun.upsert({
    where: {
      shopId_beliefSnapshotHash_promptVersion_schemaVersion: {
        shopId: input.shopId,
        beliefSnapshotHash: snapshot.snapshotHash,
        promptVersion: MERCHANT_INSIGHTS_PROMPT_VERSION,
        schemaVersion: MERCHANT_INSIGHTS_SCHEMA_VERSION,
      },
    },
    create: data,
    update: {
      relevantBeliefIds: snapshot.beliefIds,
      memoryRefreshRunId: snapshot.memoryRefreshRunId,
    },
  });
  return { status: "ready", run, snapshot };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null }} input
 */
async function loadPreparedRun(prisma, input) {
  const run = await prisma.merchantInsightRun.findFirst({
    where: {
      id: input.runId ?? undefined,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!run) return prepareInsightRun(prisma, input);
  const snapshot = await buildMerchantInsightSnapshot(prisma, input);
  if (run.beliefSnapshotHash !== snapshot.snapshotHash) {
    return prepareInsightRun(prisma, input);
  }
  return { status: "ready", run, snapshot };
}

/** @param {any} run */
function serializeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    beliefSnapshotHash: run.beliefSnapshotHash,
    safeErrorCode: run.safeErrorCode,
    lastError: run.lastError,
    completedAt: run.completedAt?.toISOString?.() ?? null,
    failedAt: run.failedAt?.toISOString?.() ?? null,
    supersededAt: run.supersededAt?.toISOString?.() ?? null,
    findings: (run.findings ?? []).map((finding) => ({
      id: finding.id,
      orderIndex: finding.orderIndex,
      title: finding.title,
      finding: finding.finding,
      whyItMatters: finding.whyItMatters,
      confidence: finding.confidence,
      category: finding.category,
      caveat: finding.caveat,
      supportingBeliefIds: finding.supportingBeliefIds,
      reviewStatus: finding.reviewStatus,
      reviewedAt: finding.reviewedAt?.toISOString?.() ?? null,
      correctedAt: finding.correctedAt?.toISOString?.() ?? null,
    })),
  };
}

/** @param {any} belief */
function isDeterministicObservation(belief) {
  if (Number(belief.precedence ?? 0) >= BELIEF_PRECEDENCE.directObservation)
    return true;
  return (belief.evidence ?? []).some(
    (evidence) =>
      evidence.sourceType === "system_derivation" ||
      evidence.evidenceType === "deterministic_calculation",
  );
}

/** @param {string} correction @param {string} valueType */
function valueFromCorrection(correction, valueType) {
  if (valueType === "number")
    return { number: Number(correction.replace(/[^0-9.-]/g, "")) };
  if (valueType === "percentage") {
    return { percentage: Number(correction.replace(/[^0-9.-]/g, "")) };
  }
  if (valueType === "currency_code")
    return { currency: correction.trim().toUpperCase() };
  if (valueType === "boolean")
    return { boolean: /^(yes|true|available|on)$/i.test(correction.trim()) };
  if (valueType === "enum") return { option: correction.trim().toLowerCase() };
  if (valueType === "currency_amount") {
    return { amount: Number(correction.replace(/[^0-9.-]/g, "")) };
  }
  return { text: correction };
}

/** @param {unknown} error */
function insightGenerationFailure(error) {
  if (error instanceof LlmOutputValidationError) {
    return { code: "invalid_model_output", message: error.message };
  }
  if (error instanceof Error && error.name === "LlmInputLimitError") {
    return { code: "input_too_large", message: error.message };
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return { code: "llm_timeout", message: "Insight generation timed out." };
  }
  return {
    code: "llm_provider_failed",
    message: safeErrorText(
      error instanceof Error ? error.message : "Insight generation failed.",
    ),
  };
}

/** @param {string} message */
function safeErrorText(message) {
  return message.replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]").slice(0, 1000);
}
