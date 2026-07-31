// @ts-check

import {
  ACTIVE_BELIEF_STATUSES,
  AUTHORITATIVE_BELIEF_STATUSES,
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
  MEMORY_DERIVATION_VERSION,
} from "./constants.server.js";
import { getBeliefDefinition } from "./conversational-belief-registry.server.js";
import { isDerivationVersionChange } from "./derivation-versioning.server.js";
import { deriveMerchantMemoryBeliefs } from "./shopify-derivations.server.js";
import { runStoreUnderstandingPass } from "./store-understanding.server.js";
import { makeToolStackBeliefRecorder } from "../integrations/tool-stack-belief.server.js";

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
  const nextDerivationVersion =
    input.derivationVersion ?? MEMORY_DERIVATION_VERSION;
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

  if (
    existing &&
    existing.status === BELIEF_STATUS.inferred &&
    isDerivationVersionChange(existing.derivationVersion, nextDerivationVersion)
  ) {
    return runInTransaction(prisma, async (tx) => {
      await tx.merchantMemoryBelief.update({
        where: { id: existing.id },
        data: {
          status: BELIEF_STATUS.superseded,
          supersededAt: now,
        },
      });
      const belief = await tx.merchantMemoryBelief.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId ?? existing.shopId,
          category: input.category,
          key: input.key,
          value: input.value,
          valueType: input.valueType,
          status: BELIEF_STATUS.inferred,
          confidence: String(input.confidence.toFixed(4)),
          confidenceReason: input.confidenceReason,
          precedence: input.precedence ?? BELIEF_PRECEDENCE.systemInference,
          derivationVersion: nextDerivationVersion,
          firstObservedAt: input.firstObservedAt ?? input.observedAt ?? now,
          lastObservedAt: input.lastObservedAt ?? input.observedAt ?? now,
          lastEvaluatedAt: now,
          supersedesBeliefId: existing.id,
        },
      });
      await recordHistory(tx, {
        merchantId: existing.merchantId,
        shopId: existing.shopId,
        beliefId: existing.id,
        key: existing.key,
        previousStatus: existing.status,
        newStatus: BELIEF_STATUS.superseded,
        previousValue: existing.value,
        newValue: existing.value,
        changeReason: "derived_belief_superseded_by_new_derivation_version",
        changedBy: "system",
        metadata: {
          previousDerivationVersion: existing.derivationVersion,
          newDerivationVersion: nextDerivationVersion,
          supersededByBeliefId: belief.id,
        },
      });
      await recordHistory(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId ?? existing.shopId,
        beliefId: belief.id,
        key: input.key,
        previousStatus: null,
        newStatus: belief.status,
        previousValue: null,
        newValue: input.value,
        changeReason: "derived_belief_created_for_new_derivation_version",
        changedBy: "system",
        metadata: {
          confidence: input.confidence,
          previousDerivationVersion: existing.derivationVersion,
          newDerivationVersion: nextDerivationVersion,
          supersedesBeliefId: existing.id,
        },
      });
      await recordEvidence(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId ?? existing.shopId,
        beliefId: belief.id,
        ...input.evidence,
      });
      return {
        belief,
        changed: true,
        skipped: false,
        superseded: true,
      };
    });
  }

  if (!existing) {
    return runInTransaction(prisma, async (tx) => {
      const belief = await tx.merchantMemoryBelief.create({
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
          derivationVersion: nextDerivationVersion,
          firstObservedAt: input.firstObservedAt ?? input.observedAt ?? now,
          lastObservedAt: input.lastObservedAt ?? input.observedAt ?? now,
          lastEvaluatedAt: now,
        },
      });
      await recordHistory(tx, {
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
      await recordEvidence(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        beliefId: belief.id,
        ...input.evidence,
      });
      return { belief, changed: true, skipped: false };
    });
  }

  const valueChanged = !jsonEqual(existing.value, input.value);
  return runInTransaction(prisma, async (tx) => {
    const belief = await tx.merchantMemoryBelief.update({
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
        derivationVersion: nextDerivationVersion,
        firstObservedAt:
          existing.firstObservedAt ?? input.firstObservedAt ?? input.observedAt,
        lastObservedAt: input.lastObservedAt ?? input.observedAt ?? now,
        lastEvaluatedAt: now,
      },
    });
    await recordHistory(tx, {
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
    await recordEvidence(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefId: belief.id,
      ...input.evidence,
    });
    return { belief, changed: valueChanged, skipped: false };
  });
}

/**
 * Bind the real derived-belief write path (`upsertDerivedBelief`) to the tool-stack detection
 * orchestrator's injected `recordBelief` seam. The integrations wiring (a separate lane) calls
 * `detectAndRecordToolStack({ ..., recordBelief: toolStackBeliefRecorder(prisma, { shopId, logger }) })`
 * once the orchestrator has a caller; until then the seam is inert. The belief is written at
 * systemInference precedence (model inference) and superseded by any merchant correction — never
 * merchant-confirmed. Kept here (not in the pure integrations module) so that module stays a leaf
 * and `service`/`shopify-derivations` can both depend on it without an import cycle.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId?: string | null; logger?: { info?: Function; warn?: Function; error?: Function } }} [options]
 */
export function toolStackBeliefRecorder(prisma, options = {}) {
  return makeToolStackBeliefRecorder({
    upsertDerivedBelief,
    prisma,
    shopId: options.shopId ?? null,
    logger: options.logger,
  });
}

/**
 * @param {any} prisma
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
  // A confirmation of a time-varying OBSERVED metric ("confirm the current
  // observation") must not pin the value: it records the confirmation but keeps
  // the belief re-derivable at system precedence so later rebuilds refresh it.
  // Confirming any other kind, or a merchant *asserting* a value via
  // correctBelief, stays authoritative as before. When the key is not a known
  // observation we keep the historical authoritative behaviour.
  const definition = getBeliefDefinition(input.key);
  const reconfirmableObservation = definition?.kind === "observation";

  return runInTransaction(prisma, async (tx) => {
    const updated = await tx.merchantMemoryBelief.update({
      where: { id: belief.id },
      data: reconfirmableObservation
        ? { lastConfirmedAt: confirmedAt }
        : {
            status: BELIEF_STATUS.merchantConfirmed,
            confidence: "1.0000",
            confidenceReason: "Merchant confirmed this belief.",
            precedence: BELIEF_PRECEDENCE.merchantConfirmation,
            lastConfirmedAt: confirmedAt,
          },
    });
    await recordHistory(tx, {
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
      metadata: reconfirmableObservation
        ? { ...(input.metadata ?? {}), confirmationMode: "observation_reconfirmable" }
        : input.metadata ?? {},
    });
    if (input.evidenceSummary || reconfirmableObservation) {
      await recordEvidence(tx, {
        merchantId: belief.merchantId,
        shopId: belief.shopId,
        beliefId: belief.id,
        sourceType: input.evidenceSourceType ?? "merchant_input",
        sourceReference: input.evidenceSourceReference ?? input.confirmedBy ?? null,
        evidenceType: "merchant_confirmation",
        summary: input.evidenceSummary ?? "Merchant confirmed the current observation.",
        metadata: input.metadata ?? { confirmedAt: confirmedAt.toISOString() },
        observedAt: confirmedAt,
      });
    }
    return updated;
  });
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
  return runInTransaction(prisma, async (tx) => {
    const updated = await tx.merchantMemoryBelief.update({
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
    await recordHistory(tx, {
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
    await recordEvidence(tx, {
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
  });
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
    return runInTransaction(prisma, async (tx) => {
      const belief = await tx.merchantMemoryBelief.create({
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
      await recordHistory(tx, {
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
      await recordEvidence(tx, {
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
    });
  }

  return runInTransaction(prisma, async (tx) => {
    const updated = await tx.merchantMemoryBelief.update({
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
    await recordHistory(tx, {
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
    await recordEvidence(tx, {
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
  });
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
    const derivationResult = await deriveMerchantMemoryBeliefs(prisma, input);
    const derivations = Array.isArray(derivationResult)
      ? derivationResult
      : derivationResult.derivations;
    const skippedOutcomes = Array.isArray(derivationResult)
      ? []
      : derivationResult.skippedOutcomes;
    const derivationReport = Array.isArray(derivationResult)
      ? {
          attempted: derivations.length,
          published: derivations.length,
          suppressed: 0,
          statusCounts: { CALCULATED: derivations.length },
          suppressedReasonCounts: {},
        }
      : derivationResult.derivationReport;
    let createdOrUpdated = 0;
    let skipped = skippedOutcomes.length;
    for (const derivation of derivations) {
      const result = await upsertDerivedBelief(prisma, derivation);
      if (result.skipped) skipped += 1;
      else createdOrUpdated += 1;
    }
    // Retire deterministic system inferences whose definition was attempted this
    // run but no longer publishes (e.g. it dropped below its minimum-data
    // threshold and now returns INSUFFICIENT_DATA / NOT_APPLICABLE). Bounded to
    // the keys the run actually attempted (skippedOutcomes) and to active
    // systemInference beliefs, so merchant-authoritative beliefs are never
    // obsoleted. Mirrors obsoleteUnsupportedStoreUnderstandingBeliefs.
    const obsoletedDeterministic =
      (input.refreshType ?? "selective_refresh") === "full_rebuild"
        ? await obsoleteUnsupportedDeterministicBeliefs(prisma, {
            merchantId: input.merchantId,
            shopId: input.shopId,
            skippedKeys: new Set(
              skippedOutcomes.map((outcome) => outcome.key),
            ),
            runId: run.id,
          })
        : 0;
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
      skippedOutcomes,
      obsoletedDeterministic,
      derivationReport,
      registryDefinitionCount: Array.isArray(derivationResult)
        ? derivations.length
        : derivationResult.registryDefinitionCount,
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
 * Retire active deterministic system inferences whose definition was attempted
 * in the current rebuild but is no longer supported by the data. Bounded to the
 * attempted-but-not-published keys (skippedOutcomes) and, critically, to
 * `status: inferred` + `precedence: systemInference` so merchant-confirmed and
 * merchant-corrected (authoritative) beliefs are never obsoleted.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; skippedKeys: Set<string>; runId: string }} input
 */
async function obsoleteUnsupportedDeterministicBeliefs(prisma, input) {
  if (input.skippedKeys.size === 0) return 0;
  const stale = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      key: { in: [...input.skippedKeys] },
      status: BELIEF_STATUS.inferred,
      precedence: BELIEF_PRECEDENCE.systemInference,
    },
  });
  const now = new Date();
  for (const belief of stale) {
    await runInTransaction(prisma, async (tx) => {
      await tx.merchantMemoryBelief.update({
        where: { id: belief.id },
        data: { status: BELIEF_STATUS.obsolete, supersededAt: now },
      });
      await recordHistory(tx, {
        merchantId: belief.merchantId,
        shopId: belief.shopId,
        beliefId: belief.id,
        key: belief.key,
        previousStatus: belief.status,
        newStatus: BELIEF_STATUS.obsolete,
        previousValue: belief.value,
        newValue: belief.value,
        changeReason: "deterministic_derivation_no_longer_supported",
        changedBy: "system",
        metadata: { runId: input.runId },
      });
    });
  }
  return stale.length;
}

/**
 * @param {any} prisma
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
/** Statuses that mean the MERCHANT is the author (they confirmed or corrected it). */
const MERCHANT_AUTHORED_STATUSES = new Set([
  BELIEF_STATUS.merchantConfirmed,
  BELIEF_STATUS.merchantCorrected,
]);

/**
 * Who a belief belongs to, for the Memory surface's grouping + left-rule.
 * "merchant" when they confirmed/corrected it; "jefe" for a system inference.
 * @param {string} status
 */
export function beliefAuthorship(status) {
  return MERCHANT_AUTHORED_STATUSES.has(status) ? "merchant" : "jefe";
}

/**
 * The confirm state that drives the surface's controls: "settled" (merchant-owned OR a
 * confident inference → Edit/Forget), "unsure" (a low-confidence inference → "That's
 * right / Not quite"). ("blocked" — Jefe can't determine it yet — is a gap/open-question
 * state, sourced separately from the questions feed, not a regular active belief.)
 * @param {string} status @param {number | null} confidence
 */
export function beliefConfirmState(status, confidence) {
  if (MERCHANT_AUTHORED_STATUSES.has(status)) return "settled";
  const conf = Number(confidence);
  return Number.isFinite(conf) && conf >= 0.7 ? "settled" : "unsure";
}

/**
 * A short provenance line, e.g. "you told Jefe · 29 Jul" / "from your store data · rechecked 31 Jul".
 * @param {any} belief
 */
function beliefSourceLine(belief) {
  const shortDate = (/** @type {any} */ d) => {
    if (!d) return null;
    try {
      return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    } catch {
      return null;
    }
  };
  if (MERCHANT_AUTHORED_STATUSES.has(belief.status)) {
    const when = shortDate(belief.lastConfirmedAt ?? belief.lastObservedAt ?? belief.lastEvaluatedAt);
    return `you told Jefe${when ? ` · ${when}` : ""}`;
  }
  const when = shortDate(belief.lastEvaluatedAt ?? belief.lastObservedAt);
  return `from your store data${when ? ` · rechecked ${when}` : ""}`;
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
    // Memory-surface rendering fields (deterministic from status/confidence/dates). The
    // plain-English `statement` is intentionally NOT here yet — see the memory-view design
    // note; it's a per-belief-key rendering that needs its own pass.
    authorship: beliefAuthorship(belief.status),
    confirmState: beliefConfirmState(belief.status, belief.confidence),
    sourceLine: beliefSourceLine(belief),
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
 * @param {import("@prisma/client").PrismaClient | any} prisma
 * @param {(tx: any) => Promise<any>} callback
 */
function runInTransaction(prisma, callback) {
  if (typeof prisma.$transaction === "function") {
    return prisma.$transaction(callback);
  }
  return callback(prisma);
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
