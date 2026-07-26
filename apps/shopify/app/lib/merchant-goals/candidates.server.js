// @ts-nocheck

import { createHash } from "node:crypto";
import { buildMerchantInsightSnapshot } from "../merchant-insights/candidates.server.js";
import { INSIGHT_RUN_STATUS } from "../merchant-insights/constants.server.js";
import {
  GOAL_MEMORY_KEYS,
  MERCHANT_GOALS_SNAPSHOT_VERSION,
} from "./constants.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function buildMerchantGoalSnapshot(prisma, input) {
  const memory = await buildMerchantInsightSnapshot(prisma, input);
  const goalMemoryKeys = new Set(Object.values(GOAL_MEMORY_KEYS));
  const beliefs = memory.snapshot.beliefs.filter(
    (belief) => !goalMemoryKeys.has(belief.key),
  );
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
      evidenceType: { in: ["merchant_goal_coaching", "merchant_goal_document_context"] },
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
  return {
    snapshot,
    snapshotHash,
    beliefIds,
    candidateCount: beliefs.length,
    insightRunId: insightRun?.id ?? null,
  };
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
