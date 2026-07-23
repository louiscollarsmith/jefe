// @ts-check

import {
  ACTIVE_BELIEF_STATUSES,
  AUTHORITATIVE_BELIEF_STATUSES,
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
  MEMORY_DERIVATION_VERSION,
} from "./constants.server.js";
import { deriveMerchantMemoryBeliefs } from "./shopify-derivations.server.js";
import { runStoreUnderstandingPass } from "./store-understanding.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; category?: string; includeEvidence?: boolean }} input
 */
export async function getBeliefsForMerchant(prisma, input) {
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      status: { in: ACTIVE_BELIEF_STATUSES },
      category: input.category ?? undefined,
    },
    include: input.includeEvidence
      ? {
          evidence: {
            orderBy: { createdAt: "desc" },
            take: 5,
          },
        }
      : undefined,
    orderBy: [{ category: "asc" }, { key: "asc" }],
  });

  return beliefs.map((belief) => toDomainBelief(belief));
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; key: string; includeEvidence?: boolean }} input
 */
export async function getBelief(prisma, input) {
  const belief = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    include: input.includeEvidence
      ? { evidence: { orderBy: { createdAt: "desc" }, take: 5 } }
      : undefined,
  });

  return belief ? toDomainBelief(belief) : null;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {DerivedBeliefInput} input
 */
export async function upsertDerivedBelief(prisma, input) {
  const now = input.evaluatedAt ?? new Date();
  const existing = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing && AUTHORITATIVE_BELIEF_STATUSES.includes(existing.status)) {
    await recordHistory(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId ?? existing.shopId,
      beliefId: existing.id,
      key: input.key,
      previousStatus: existing.status,
      newStatus: existing.status,
      previousValue: existing.value,
      newValue: existing.value,
      changeReason: "derived_recalculation_skipped_authoritative_belief",
      changedBy: "system",
      metadata: {
        proposedValue: input.value,
        proposedConfidence: input.confidence,
      },
    });
    return { belief: existing, changed: false, skipped: true };
  }

  if (!existing) {
    const belief = await prisma.merchantMemoryBelief.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId ?? null,
        category: input.category,
        key: input.key,
        value: input.value,
        valueType: input.valueType,
        status: BELIEF_STATUS.inferred,
        confidence: String(input.confidence.toFixed(4)),
        confidenceReason: input.confidenceReason,
        precedence: input.precedence ?? BELIEF_PRECEDENCE.systemInference,
        derivationVersion:
          input.derivationVersion ?? MEMORY_DERIVATION_VERSION,
        firstObservedAt: input.firstObservedAt ?? input.observedAt ?? now,
        lastObservedAt: input.lastObservedAt ?? input.observedAt ?? now,
        lastEvaluatedAt: now,
      },
    });
    await recordHistory(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefId: belief.id,
      key: input.key,
      previousStatus: null,
      newStatus: belief.status,
      previousValue: null,
      newValue: input.value,
      changeReason: "derived_belief_created",
      changedBy: "system",
      metadata: { confidence: input.confidence },
    });
    await recordEvidence(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefId: belief.id,
      ...input.evidence,
    });
    return { belief, changed: true, skipped: false };
  }

  const valueChanged = !jsonEqual(existing.value, input.value);
  const belief = await prisma.merchantMemoryBelief.update({
    where: { id: existing.id },
    data: {
      shopId: input.shopId ?? existing.shopId,
      category: input.category,
      value: input.value,
      valueType: input.valueType,
      status: BELIEF_STATUS.inferred,
      confidence: String(input.confidence.toFixed(4)),
      confidenceReason: input.confidenceReason,
      precedence: input.precedence ?? existing.precedence,
      derivationVersion:
        input.derivationVersion ?? MEMORY_DERIVATION_VERSION,
      firstObservedAt:
        existing.firstObservedAt ?? input.firstObservedAt ?? input.observedAt,
      lastObservedAt: input.lastObservedAt ?? input.observedAt ?? now,
      lastEvaluatedAt: now,
    },
  });
  await recordHistory(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId ?? belief.shopId,
    beliefId: belief.id,
    key: input.key,
    previousStatus: existing.status,
    newStatus: belief.status,
    previousValue: existing.value,
    newValue: input.value,
    changeReason: valueChanged
      ? "derived_belief_value_updated"
      : "derived_belief_recalculated",
    changedBy: "system",
    metadata: { confidence: input.confidence },
  });
  await recordEvidence(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    beliefId: belief.id,
    ...input.evidence,
  });
  return { belief, changed: valueChanged, skipped: false };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {EvidenceInput} input
 */
export async function recordEvidence(prisma, input) {
  return prisma.merchantMemoryEvidence.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      beliefId: input.beliefId ?? null,
      sourceType: input.sourceType,
      sourceReference: input.sourceReference ?? null,
      evidenceType: input.evidenceType,
      summary: input.summary,
      metadata: input.metadata ?? {},
      observedAt: input.observedAt ?? null,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; key: string; reason?: string }} input
 */
export async function markBeliefObsolete(prisma, input) {
  const belief = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
  });
  if (!belief) return null;

  const updated = await prisma.merchantMemoryBelief.update({
    where: { id: belief.id },
    data: { status: BELIEF_STATUS.obsolete, supersededAt: new Date() },
  });
  await recordHistory(prisma, {
    merchantId: belief.merchantId,
    shopId: belief.shopId,
    beliefId: belief.id,
    key: belief.key,
    previousStatus: belief.status,
    newStatus: updated.status,
    previousValue: belief.value,
    newValue: updated.value,
    changeReason: input.reason ?? "belief_marked_obsolete",
    changedBy: "system",
  });
  return updated;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; key: string; replacement: DerivedBeliefInput; reason?: string }} input
 */
export async function supersedeBelief(prisma, input) {
  const existing = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
  });
  if (!existing) return upsertDerivedBelief(prisma, input.replacement);

  await prisma.merchantMemoryBelief.update({
    where: { id: existing.id },
    data: { status: BELIEF_STATUS.superseded, supersededAt: new Date() },
  });
  await recordHistory(prisma, {
    merchantId: existing.merchantId,
    shopId: existing.shopId,
    beliefId: existing.id,
    key: existing.key,
    previousStatus: existing.status,
    newStatus: BELIEF_STATUS.superseded,
    previousValue: existing.value,
    newValue: existing.value,
    changeReason: input.reason ?? "belief_superseded",
    changedBy: "system",
  });

  const result = await upsertDerivedBelief(prisma, input.replacement);
  await prisma.merchantMemoryBelief.update({
    where: { id: result.belief.id },
    data: { supersedesBeliefId: existing.id },
  });
  return result;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; key: string; confirmedBy?: string; confirmedAt?: Date; evidenceSummary?: string; evidenceSourceType?: string; evidenceSourceReference?: string | null; metadata?: any }} input
 */
export async function confirmBelief(prisma, input) {
  const belief = await prisma.merchantMemoryBelief.findFirstOrThrow({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
  });
  const confirmedAt = input.confirmedAt ?? new Date();
  const updated = await prisma.merchantMemoryBelief.update({
    where: { id: belief.id },
    data: {
      status: BELIEF_STATUS.merchantConfirmed,
      confidence: "1.0000",
      confidenceReason: "Merchant confirmed this belief.",
      precedence: BELIEF_PRECEDENCE.merchantConfirmation,
      lastConfirmedAt: confirmedAt,
    },
  });
  await recordHistory(prisma, {
    merchantId: belief.merchantId,
    shopId: belief.shopId,
    beliefId: belief.id,
    key: belief.key,
    previousStatus: belief.status,
    newStatus: updated.status,
    previousValue: belief.value,
    newValue: updated.value,
    changeReason: "merchant_confirmed_belief",
    changedBy: input.confirmedBy ?? "merchant",
    metadata: input.metadata ?? {},
  });
  if (input.evidenceSummary) {
    await recordEvidence(prisma, {
      merchantId: belief.merchantId,
      shopId: belief.shopId,
      beliefId: belief.id,
      sourceType: input.evidenceSourceType ?? "merchant_input",
      sourceReference: input.evidenceSourceReference ?? input.confirmedBy ?? null,
      evidenceType: "merchant_confirmation",
      summary: input.evidenceSummary,
      metadata: input.metadata ?? { confirmedAt: confirmedAt.toISOString() },
      observedAt: confirmedAt,
    });
  }
  return updated;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; key: string; value: any; valueType: string; correctedBy?: string; correctedAt?: Date; evidenceSummary?: string; evidenceSourceType?: string; evidenceSourceReference?: string | null; metadata?: any }} input
 */
export async function correctBelief(prisma, input) {
  const belief = await prisma.merchantMemoryBelief.findFirstOrThrow({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
  });
  const correctedAt = input.correctedAt ?? new Date();
  const updated = await prisma.merchantMemoryBelief.update({
    where: { id: belief.id },
    data: {
      value: input.value,
      valueType: input.valueType,
      status: BELIEF_STATUS.merchantCorrected,
      confidence: "1.0000",
      confidenceReason: "Merchant corrected this belief.",
      precedence: BELIEF_PRECEDENCE.merchantCorrection,
      lastConfirmedAt: correctedAt,
      lastEvaluatedAt: correctedAt,
    },
  });
  await recordHistory(prisma, {
    merchantId: belief.merchantId,
    shopId: belief.shopId,
    beliefId: belief.id,
    key: belief.key,
    previousStatus: belief.status,
    newStatus: updated.status,
    previousValue: belief.value,
    newValue: updated.value,
    changeReason: "merchant_corrected_belief",
    changedBy: input.correctedBy ?? "merchant",
    metadata: input.metadata ?? {},
  });
  await recordEvidence(prisma, {
    merchantId: belief.merchantId,
    shopId: belief.shopId,
    beliefId: belief.id,
    sourceType: input.evidenceSourceType ?? "merchant_input",
    sourceReference: input.evidenceSourceReference ?? input.correctedBy ?? null,
    evidenceType: "merchant_correction",
    summary: input.evidenceSummary ?? "Merchant supplied a correction.",
    metadata: input.metadata ?? { correctedAt: correctedAt.toISOString() },
    observedAt: correctedAt,
  });
  return updated;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; category: string; key: string; value: any; valueType: string; suppliedBy?: string; suppliedAt?: Date; evidenceSummary?: string; evidenceSourceType?: string; evidenceSourceReference?: string | null; metadata?: any; precedence?: number }} input
 */
export async function upsertMerchantSuppliedBelief(prisma, input) {
  const suppliedAt = input.suppliedAt ?? new Date();
  const existing = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: input.key,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!existing) {
    const belief = await prisma.merchantMemoryBelief.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId ?? null,
        category: input.category,
        key: input.key,
        value: input.value,
        valueType: input.valueType,
        status: BELIEF_STATUS.merchantConfirmed,
        confidence: "1.0000",
        confidenceReason: "Merchant supplied this understanding.",
        precedence: input.precedence ?? BELIEF_PRECEDENCE.merchantConfirmation,
        firstObservedAt: suppliedAt,
        lastObservedAt: suppliedAt,
        lastEvaluatedAt: suppliedAt,
        lastConfirmedAt: suppliedAt,
      },
    });
    await recordHistory(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefId: belief.id,
      key: input.key,
      previousStatus: null,
      newStatus: belief.status,
      previousValue: null,
      newValue: input.value,
      changeReason: "merchant_conversation_belief_created",
      changedBy: input.suppliedBy ?? "merchant",
      metadata: input.metadata ?? {},
    });
    await recordEvidence(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefId: belief.id,
      sourceType: input.evidenceSourceType ?? "merchant_input",
      sourceReference: input.evidenceSourceReference ?? input.suppliedBy ?? null,
      evidenceType: "merchant_supplied_context",
      summary: input.evidenceSummary ?? "Merchant supplied business context.",
      metadata: input.metadata ?? { suppliedAt: suppliedAt.toISOString() },
      observedAt: suppliedAt,
    });
    return { belief, changed: true, created: true };
  }

  const updated = await prisma.merchantMemoryBelief.update({
    where: { id: existing.id },
    data: {
      shopId: input.shopId ?? existing.shopId,
      category: input.category,
      value: input.value,
      valueType: input.valueType,
      status: BELIEF_STATUS.merchantCorrected,
      confidence: "1.0000",
      confidenceReason: "Merchant updated this understanding.",
      precedence: input.precedence ?? BELIEF_PRECEDENCE.merchantCorrection,
      lastObservedAt: suppliedAt,
      lastEvaluatedAt: suppliedAt,
      lastConfirmedAt: suppliedAt,
    },
  });
  await recordHistory(prisma, {
    merchantId: existing.merchantId,
    shopId: input.shopId ?? existing.shopId,
    beliefId: existing.id,
    key: input.key,
    previousStatus: existing.status,
    newStatus: updated.status,
    previousValue: existing.value,
    newValue: input.value,
    changeReason: "merchant_conversation_belief_updated",
    changedBy: input.suppliedBy ?? "merchant",
    metadata: input.metadata ?? {},
  });
  await recordEvidence(prisma, {
    merchantId: existing.merchantId,
    shopId: input.shopId ?? existing.shopId,
    beliefId: existing.id,
    sourceType: input.evidenceSourceType ?? "merchant_input",
    sourceReference: input.evidenceSourceReference ?? input.suppliedBy ?? null,
    evidenceType: "merchant_supplied_context",
    summary: input.evidenceSummary ?? "Merchant updated business context.",
    metadata: input.metadata ?? { suppliedAt: suppliedAt.toISOString() },
    observedAt: suppliedAt,
  });
  return { belief: updated, changed: true, created: false };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; changedByPrefix?: string; revertedBy?: string; revertedAt?: Date; metadata?: any }} input
 */
export async function revertLatestMerchantSuppliedChange(prisma, input) {
  const changedByPrefix = input.changedByPrefix ?? "merchant_conversation";
  const history = await prisma.merchantMemoryBeliefHistory.findFirst({
    where: {
      merchantId: input.merchantId,
      changedBy: { startsWith: changedByPrefix },
      changeReason: {
        in: [
          "merchant_conversation_belief_created",
          "merchant_conversation_belief_updated",
          "merchant_corrected_belief",
          "merchant_confirmed_belief",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!history?.beliefId) return null;

  const belief = await prisma.merchantMemoryBelief.findFirst({
    where: { id: history.beliefId, merchantId: input.merchantId },
  });
  if (!belief) return null;

  const revertedAt = input.revertedAt ?? new Date();
  const previousStatus = history.previousStatus ?? BELIEF_STATUS.obsolete;
  const previousValue = /** @type {any} */ (history.previousValue ?? belief.value);
  const updated = await prisma.merchantMemoryBelief.update({
    where: { id: belief.id },
    data: {
      status: previousStatus,
      value: previousValue,
      precedence:
        previousStatus === BELIEF_STATUS.merchantCorrected
          ? BELIEF_PRECEDENCE.merchantCorrection
          : previousStatus === BELIEF_STATUS.merchantConfirmed
            ? BELIEF_PRECEDENCE.merchantConfirmation
            : belief.precedence,
      supersededAt:
        previousStatus === BELIEF_STATUS.obsolete ||
        previousStatus === BELIEF_STATUS.superseded
          ? revertedAt
          : null,
      lastEvaluatedAt: revertedAt,
    },
  });
  await recordHistory(prisma, {
    merchantId: belief.merchantId,
    shopId: belief.shopId,
    beliefId: belief.id,
    key: belief.key,
    previousStatus: belief.status,
    newStatus: updated.status,
    previousValue: belief.value,
    newValue: updated.value,
    changeReason: "merchant_conversation_change_reverted",
    changedBy: input.revertedBy ?? "merchant_conversation",
    metadata: input.metadata ?? { revertedHistoryId: history.id },
  });
  return updated;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; categories?: string[]; refreshType?: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function rebuildMerchantMemory(prisma, input) {
  return refreshBeliefs(prisma, {
    ...input,
    refreshType: input.refreshType ?? "full_rebuild",
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; categories?: string[]; refreshType?: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function refreshBeliefs(prisma, input) {
  const logger = input.logger ?? console;
  const startedAt = new Date();
  const run = await prisma.merchantMemoryRefreshRun.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      refreshType: input.refreshType ?? "selective_refresh",
      status: "running",
      requestedCategories: input.categories ?? [],
      startedAt,
    },
  });

  logger.info("Merchant Memory build started", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    categories: input.categories ?? [],
    runId: run.id,
  });

  try {
    const derivations = await deriveMerchantMemoryBeliefs(prisma, input);
    let createdOrUpdated = 0;
    let skipped = 0;
    for (const derivation of derivations) {
      const result = await upsertDerivedBelief(prisma, derivation);
      if (result.skipped) skipped += 1;
      else createdOrUpdated += 1;
    }
    const durationMs = Date.now() - startedAt.getTime();
    const storeUnderstanding =
      (input.refreshType ?? "selective_refresh") === "full_rebuild"
        ? await runStoreUnderstandingPass(prisma, {
            merchantId: input.merchantId,
            shopId: input.shopId,
            trigger: "post_memory_rebuild",
            llmProvider: input.llmProvider,
            logger,
          })
        : null;
    const result = {
      derivations: derivations.length,
      createdOrUpdated,
      skipped,
      durationMs,
      storeUnderstanding,
    };

    await prisma.merchantMemoryRefreshRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result,
      },
    });

    logger.info("Merchant Memory build completed", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      ...result,
    });

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Merchant Memory build failed.";
    await prisma.merchantMemoryRefreshRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        lastError: message.slice(0, 1000),
      },
    });
    logger.error("Merchant Memory build failed", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      error: message,
    });
    throw error;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {HistoryInput} input
 */
async function recordHistory(prisma, input) {
  return prisma.merchantMemoryBeliefHistory.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      beliefId: input.beliefId ?? null,
      key: input.key,
      previousStatus: input.previousStatus ?? null,
      newStatus: input.newStatus,
      previousValue: input.previousValue ?? undefined,
      newValue: input.newValue ?? undefined,
      changeReason: input.changeReason,
      changedBy: input.changedBy ?? "system",
      metadata: input.metadata ?? {},
    },
  });
}

/** @param {any} belief */
function toDomainBelief(belief) {
  return {
    id: belief.id,
    merchantId: belief.merchantId,
    shopId: belief.shopId,
    category: belief.category,
    key: belief.key,
    value: belief.value,
    valueType: belief.valueType,
    status: belief.status,
    confidence: belief.confidence === null ? null : Number(belief.confidence),
    confidenceReason: belief.confidenceReason,
    firstObservedAt: belief.firstObservedAt,
    lastObservedAt: belief.lastObservedAt,
    lastEvaluatedAt: belief.lastEvaluatedAt,
    lastConfirmedAt: belief.lastConfirmedAt,
    evidence: Array.isArray(belief.evidence)
      ? belief.evidence.map((/** @type {any} */ item) => ({
          id: item.id,
          sourceType: item.sourceType,
          sourceReference: item.sourceReference,
          evidenceType: item.evidenceType,
          summary: item.summary,
          metadata: item.metadata,
          observedAt: item.observedAt,
          createdAt: item.createdAt,
        }))
      : undefined,
  };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @typedef {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   category: string;
 *   key: string;
 *   value: any;
 *   valueType: string;
 *   confidence: number;
 *   confidenceReason: string;
 *   precedence?: number;
 *   derivationVersion?: string;
 *   observedAt?: Date | null;
 *   firstObservedAt?: Date | null;
 *   lastObservedAt?: Date | null;
 *   evaluatedAt?: Date;
 *   evidence: Omit<EvidenceInput, "merchantId" | "shopId" | "beliefId">;
 * }} DerivedBeliefInput
 *
 * @typedef {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   beliefId?: string | null;
 *   sourceType: string;
 *   sourceReference?: string | null;
 *   evidenceType: string;
 *   summary: string;
 *   metadata?: any;
 *   observedAt?: Date | null;
 * }} EvidenceInput
 *
 * @typedef {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   beliefId?: string | null;
 *   key: string;
 *   previousStatus?: string | null;
 *   newStatus: string;
 *   previousValue?: any;
 *   newValue?: any;
 *   changeReason: string;
 *   changedBy?: string;
 *   metadata?: any;
 * }} HistoryInput
 */
