// @ts-nocheck

import { createHash } from "node:crypto";
import {
  buildMerchantInsightSnapshot,
  selectPrioritizedCandidates,
} from "../merchant-insights/candidates.server.js";
import { INSIGHT_RUN_STATUS } from "../merchant-insights/constants.server.js";
import {
  GOAL_MEMORY_KEYS,
  MAX_GOAL_BELIEFS,
  MERCHANT_GOALS_SNAPSHOT_VERSION,
} from "./constants.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function buildMerchantGoalSnapshot(prisma, input) {
  // Reuse the Insights snapshot builder (and its cap) for the belief base, but
  // suppress its logger: a Goals run reports its own combined cap below, so an
  // inner "insights capped" line here would be misleading. The drop counts are
  // still returned and folded into the Goals accounting.
  const memory = await buildMerchantInsightSnapshot(prisma, {
    ...input,
    logger: undefined,
  });
  const goalMemoryKeys = new Set(Object.values(GOAL_MEMORY_KEYS));
  const filteredCandidates = memory.snapshot.beliefs.filter(
    (belief) => !goalMemoryKeys.has(belief.key),
  );
  // The belief set is already bounded upstream by the Insights cap this reuses.
  // Re-apply the same prioritisation here so the Goals snapshot is independently
  // guaranteed to stay under the provider input limit (18000 tokens). For a set
  // already at or under the cap this is a no-op that preserves order, so small
  // stores keep their exact snapshot hash.
  const selection = selectPrioritizedCandidates(
    filteredCandidates.map((candidate) => ({
      candidate,
      category: candidate.cat,
      key: candidate.key,
      score: scoreNormalizedCandidate(candidate),
    })),
    MAX_GOAL_BELIEFS,
  );
  const beliefs = selection.selected;
  const beliefIds = beliefs.map((belief) => belief.id);
  const allowedBeliefIds = new Set(beliefIds);
  const memorySnapshot = {
    ...memory.snapshot,
    beliefCount: beliefs.length,
    beliefs,
  };
  const insightRun = await prisma.merchantInsightRun.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: INSIGHT_RUN_STATUS.completed,
      supersededAt: null,
    },
    include: { findings: { orderBy: { orderIndex: "asc" } } },
    orderBy: { completedAt: "desc" },
  });
  const coachingEvidence = await prisma.merchantMemoryEvidence.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      evidenceType: {
        in: ["merchant_goal_coaching", "merchant_goal_document_context"],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  const insights = (insightRun?.findings ?? []).map((finding) => ({
    title: safeText(finding.title, 90),
    finding: safeText(finding.finding, 260),
    whyItMatters: safeText(finding.whyItMatters, 180),
    category: finding.category,
    confidence: finding.confidence,
    reviewStatus: finding.reviewStatus,
    supportingBeliefIds: finding.supportingBeliefIds.filter((beliefId) =>
      allowedBeliefIds.has(beliefId),
    ),
    generatedBy: "jefe_llm",
  }));
  const snapshot = {
    snapshotVersion: MERCHANT_GOALS_SNAPSHOT_VERSION,
    merchantId: input.merchantId,
    shopId: input.shopId,
    memorySnapshotVersion: memory.snapshot.snapshotVersion,
    memorySnapshotHash: hashSnapshot(memorySnapshot),
    insightRunId: insightRun?.id ?? null,
    insightCount: insights.length,
    privacy: {
      source: "merchant_memory_and_merchant_insights",
      excludesRawShopifyRecords: true,
      excludesCustomerNamesEmailsPhonesAddresses: true,
      excludesCredentialsAndTokens: true,
    },
    beliefCount: beliefs.length,
    beliefs,
    merchantContext: memory.snapshot.merchantContext,
    insights,
    goalCoaching: coachingEvidence
      .map((item) => ({
        id: item.id,
        sourceType: item.sourceType,
        evidenceType: item.evidenceType,
        summary: safeText(item.summary, 600),
        observedAt: item.observedAt?.toISOString?.() ?? null,
      }))
      .reverse(),
  };
  const snapshotHash = hashSnapshot(snapshot);

  // Surface beliefs excluded by capping (upstream Insights cap + any applied
  // here) so truncation is observable rather than silent.
  const droppedBeliefCount =
    (memory.droppedBeliefCount ?? 0) + selection.droppedCount;
  const droppedCategories = [
    ...new Set([
      ...(memory.droppedCategories ?? []),
      ...selection.droppedCategories,
    ]),
  ].sort();
  if (droppedBeliefCount > 0) {
    input.logger?.warn?.("Merchant goals candidate set capped", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      cap: MAX_GOAL_BELIEFS,
      keptBeliefs: beliefs.length,
      droppedBeliefCount,
      droppedCategories,
    });
  }

  return {
    snapshot,
    snapshotHash,
    beliefIds,
    candidateCount: beliefs.length,
    droppedBeliefCount,
    droppedCategories,
    insightRunId: insightRun?.id ?? null,
  };
}

/**
 * Approximate selection score for an already-normalized candidate. Used only on
 * the rare over-cap defensive path (the primary bound is the upstream Insights
 * cap). Recency is unavailable after normalization, so this ranks by merchant
 * authority and confidence only.
 * @param {{ authority?: string; conf?: number | null }} candidate
 */
function scoreNormalizedCandidate(candidate) {
  let score = 0;
  if (candidate.authority === "merchant_corrected") score += 40;
  else if (candidate.authority === "merchant_confirmed") score += 32;
  else if (candidate.authority === "deterministic") score += 18;
  if (Number.isFinite(candidate.conf)) score += Math.round(candidate.conf * 20);
  return score;
}

/** @param {unknown} value @param {number} max */
function safeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted]",
    )
    .slice(0, max);
}

/** @param {any} snapshot */
function hashSnapshot(snapshot) {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

/** @param {any} value */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
