// @ts-nocheck

import { LlmOutputValidationError } from "../llm/errors.server.js";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  confirmBelief,
  recordEvidence,
  upsertMerchantSuppliedBelief,
} from "../merchant-memory/service.server.js";
import {
  getBeliefDefinition,
  getConversationalBeliefRegistry,
} from "../merchant-memory/conversational-belief-registry.server.js";
import { enqueueMerchantMemoryRefresh } from "../merchant-memory/jobs.server.js";
import {
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
} from "../merchant-memory/constants.server.js";
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
import {
  MERCHANT_INSIGHT_CORRECTION_OUTPUT_SCHEMA,
  buildMerchantInsightCorrectionPrompt,
  buildMerchantInsightCorrectionSystemPrompt,
  parseAndValidateMerchantInsightCorrection,
} from "./correction-processor.server.js";

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
      : previousCompletedRun;

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
 * Read-only fetch of the latest completed Insights run for the Daily Home.
 * Unlike getMerchantInsightsExperience, this does NOT build a snapshot (no
 * re-query/re-hash of the belief set) and does NOT ensure or queue
 * generation. It only reads the most recent completed run so the home
 * screen loads fast.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function getLatestMerchantInsights(prisma, input) {
  const latestCompletedRun = await prisma.merchantInsightRun.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: INSIGHT_RUN_STATUS.completed,
    },
    include: { findings: { orderBy: { orderIndex: "asc" } } },
    orderBy: { completedAt: "desc" },
  });
  return { selectedRun: serializeRun(latestCompletedRun) };
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

  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "insights",
        runType: "MerchantInsightRun",
        runId: run.id,
      },
    });
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
    const { llmResult, parsed } = await generateValidatedInsights(provider, {
      snapshot,
      logger,
    });
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
 * @param {import("../llm/provider.server.js").LlmProvider} provider
 * @param {{ snapshot: Awaited<ReturnType<typeof buildMerchantInsightSnapshot>>; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function generateValidatedInsights(provider, input) {
  const allowedBeliefIds = new Set(input.snapshot.beliefIds);
  let validationError = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const llmResult = await provider.generateStructuredJson({
      systemPrompt: buildMerchantInsightsSystemPrompt(),
      prompt: buildMerchantInsightsPrompt(input.snapshot.snapshot, {
        validationError,
      }),
      schema: MERCHANT_INSIGHTS_OUTPUT_SCHEMA,
      maxInputTokens: 16000,
      maxOutputTokens: 3600,
      timeoutMs: 15_000,
    });
    lastResult = llmResult;
    const parsed = parseAndValidateMerchantInsightsOutput(llmResult.json, {
      allowedBeliefIds,
      suppliedBeliefs: input.snapshot.snapshot.beliefs,
    });
    if (parsed.ok) return { llmResult, parsed };

    validationError = parsed.error;
    if (attempt < 2) {
      input.logger.warn("Merchant insights output failed validation; retrying", {
        error: parsed.error,
      });
    }
  }

  throw new LlmOutputValidationError(
    validationError ??
      `Insight generation failed validation after ${lastResult ? "model output" : "request"}.`,
  );
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
 * @param {{ merchantId: string; shopId: string; findingId: string; correction: string; insightText?: string | null; supportingBeliefIds?: string[]; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
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
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      id: { in: finding.supportingBeliefIds },
    },
    include: { evidence: { take: 3, orderBy: { createdAt: "desc" } } },
  });
  const processor =
    input.llmProvider ?? createLlmProvider({ logger: input.logger ?? console });
  if (!processor.enabled || !processor.generateStructuredJson) {
    return {
      ok: false,
      error: "I couldn't process that correction safely. Please try again.",
    };
  }

  let llmResult;
  try {
    llmResult = await processor.generateStructuredJson({
      systemPrompt: buildMerchantInsightCorrectionSystemPrompt(),
      prompt: buildMerchantInsightCorrectionPrompt({
        insight: serializeFindingForCorrection(finding),
        correction,
        supportingBeliefs: beliefs.map(serializeBeliefForCorrection),
        merchantWritableBeliefs: merchantWritableBeliefDefinitions(),
      }),
      schema: MERCHANT_INSIGHT_CORRECTION_OUTPUT_SCHEMA,
      maxInputTokens: 8000,
      maxOutputTokens: 1800,
      timeoutMs: 12_000,
    });
  } catch (error) {
    input.logger?.warn?.("Merchant insight correction processor failed", {
      findingId: finding.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: "I couldn't process that correction safely. Please try again.",
    };
  }

  const parsed = parseAndValidateMerchantInsightCorrection(llmResult.json, {
    supportingBeliefIds: new Set(finding.supportingBeliefIds),
  });
  if (!parsed.ok) {
    return {
      ok: false,
      error: "I couldn't process that correction safely. Please try again.",
    };
  }
  const processorOutput = parsed.correction;
  const affectedBeliefIds =
    processorOutput.affectedBeliefIds.length > 0
      ? processorOutput.affectedBeliefIds
      : finding.supportingBeliefIds;
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    for (const change of processorOutput.proposedMemoryChanges) {
      await upsertMerchantSuppliedBelief(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        category: change.category,
        key: change.key,
        value: change.value,
        valueType: change.valueType,
        suppliedBy: "merchant_insights_correction",
        suppliedAt: now,
        evidenceSummary: change.summary,
        evidenceSourceType: "merchant_insights",
        evidenceSourceReference: `merchant_insight_finding:${finding.id}`,
        metadata: {
          findingId: finding.id,
          runId: finding.runId,
          originalCorrection: correction,
          processorOutput,
        },
      });
    }

    await recordEvidence(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefId: null,
      sourceType: "merchant_insights",
      sourceReference: `merchant_insight_finding:${finding.id}`,
      evidenceType: "merchant_insight_correction",
      summary: `Merchant corrected Jefe's insight: ${correction.slice(0, 240)}`,
      metadata: {
        findingId: finding.id,
        runId: finding.runId,
        insight: serializeFindingForCorrection(finding),
        supportingBeliefIds: finding.supportingBeliefIds,
        submittedInsightText: input.insightText ?? null,
        submittedSupportingBeliefIds: input.supportingBeliefIds ?? [],
        originalCorrection: correction,
        processorOutput,
        status: "processed",
      },
      observedAt: now,
    });

    for (const beliefId of affectedBeliefIds) {
      await recordEvidence(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        beliefId,
        sourceType: "merchant_insights",
        sourceReference: `merchant_insight_finding:${finding.id}`,
        evidenceType: "merchant_correction",
        summary:
          "Merchant challenged an insight supported by this belief; deterministic facts were not overwritten.",
        metadata: {
          findingId: finding.id,
          runId: finding.runId,
          originalCorrection: correction,
          processorOutput,
        },
        observedAt: now,
      });
    }

    return tx.merchantInsightFinding.update({
      where: { id: finding.id },
      data: {
        reviewStatus: INSIGHT_REVIEW_STATUS.corrected,
        reviewedAt: now,
        correctedAt: now,
      },
    });
  });

  if (processorOutput.rebuildMerchantMemory) {
    await enqueueMerchantMemoryRefresh(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      categories: [
        ...new Set(
          beliefs
            .filter((belief) => affectedBeliefIds.includes(belief.id))
            .map((belief) => belief.category),
        ),
      ],
      reason: "merchant_insight_correction",
      resetAttempts: true,
    });
  }

  if (processorOutput.regenerateInsights) {
    await ensureMerchantInsightsQueued(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runAfter: processorOutput.rebuildMerchantMemory
        ? new Date(Date.now() + 30_000)
        : undefined,
      resetAttempts: true,
    });
  }

  return {
    ok: true,
    finding: updated,
    processorOutput,
    regenerateInsights: processorOutput.regenerateInsights,
  };
}

function serializeFindingForCorrection(finding) {
  return {
    id: finding.id,
    title: finding.title,
    finding: finding.finding,
    whyItMatters: finding.whyItMatters,
    confidence: finding.confidence,
    category: finding.category,
    caveat: finding.caveat,
    supportingBeliefIds: finding.supportingBeliefIds,
  };
}

function serializeBeliefForCorrection(belief) {
  const definition = getBeliefDefinition(belief.key);
  return {
    id: belief.id,
    key: belief.key,
    category: belief.category,
    label: definition?.label ?? belief.key,
    value: belief.value,
    valueType: belief.valueType,
    status: belief.status,
    confidence: belief.confidence === null ? null : Number(belief.confidence),
    precedence: Number(belief.precedence ?? 0),
    authority: isDeterministicObservation(belief)
      ? "deterministic"
      : belief.status,
    evidence: (belief.evidence ?? []).map((item) => ({
      sourceType: item.sourceType,
      evidenceType: item.evidenceType,
      summary: item.summary,
      observedAt: item.observedAt?.toISOString?.() ?? null,
    })),
    guidance: definition?.guidance ?? null,
  };
}

function merchantWritableBeliefDefinitions() {
  return Object.values(getConversationalBeliefRegistry())
    .filter(
      (definition) =>
        definition.merchantCreatable && definition.kind !== "observation",
    )
    .map((definition) => ({
      key: definition.key,
      category: definition.category,
      label: definition.label,
      valueType: definition.valueType,
      allowedValues: definition.allowedValues ?? null,
      guidance: definition.guidance,
    }));
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
