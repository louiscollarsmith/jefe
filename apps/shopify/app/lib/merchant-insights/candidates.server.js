// @ts-nocheck

import { createHash } from "node:crypto";
import {
  ACTIVE_BELIEF_STATUSES,
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
} from "../merchant-memory/constants.server.js";
import { getBeliefDefinition } from "../merchant-memory/conversational-belief-registry.server.js";
import {
  MAX_INSIGHT_BELIEFS,
  MERCHANT_INSIGHTS_SNAPSHOT_VERSION,
} from "./constants.server.js";

// Additive recency bonus (0..RECENCY_WEIGHT) folded into a belief's selection
// score. Recency is measured relative to the current belief set (no wall clock
// is read), so the same belief set always yields the same selection and hash.
const RECENCY_WEIGHT = 12;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function buildMerchantInsightSnapshot(prisma, input) {
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: { in: ACTIVE_BELIEF_STATUSES },
      supersededAt: null,
    },
    include: {
      evidence: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ category: "asc" }, { key: "asc" }, { updatedAt: "desc" }],
  });
  const memoryRefreshRun = await prisma.merchantMemoryRefreshRun.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: "completed",
    },
    orderBy: { completedAt: "desc" },
    select: { id: true, completedAt: true },
  });

  const scored = withRecencyScores(
    beliefs
      .map((belief) => {
        const candidate = normalizeBeliefCandidate(belief);
        if (!candidate) return null;
        return {
          candidate,
          category: candidate.cat,
          key: candidate.key,
          base: scoreBeliefForSelection(belief),
          recencyMs: beliefRecencyMs(belief),
        };
      })
      .filter(Boolean),
  );
  const selection = selectPrioritizedCandidates(scored, MAX_INSIGHT_BELIEFS);
  const candidates = selection.selected;

  if (selection.droppedCount > 0) {
    input.logger?.warn?.("Merchant insights candidate set capped", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      cap: MAX_INSIGHT_BELIEFS,
      keptBeliefs: candidates.length,
      droppedBeliefCount: selection.droppedCount,
      droppedCategories: selection.droppedCategories,
    });
  }

  const snapshot = {
    snapshotVersion: MERCHANT_INSIGHTS_SNAPSHOT_VERSION,
    merchantId: input.merchantId,
    shopId: input.shopId,
    memoryRefreshRunId: memoryRefreshRun?.id ?? null,
    memoryCompletedAt: memoryRefreshRun?.completedAt?.toISOString?.() ?? null,
    privacy: {
      source: "merchant_memory_beliefs",
      excludesRawShopifyRecords: true,
      excludesCustomerNamesEmailsPhonesAddresses: true,
      excludesCredentialsAndTokens: true,
    },
    beliefCount: candidates.length,
    beliefs: candidates,
  };
  const snapshotHash = hashSnapshot(snapshot);
  return {
    snapshot,
    snapshotHash,
    beliefIds: candidates.map((belief) => belief.id),
    candidateCount: candidates.length,
    droppedBeliefCount: selection.droppedCount,
    droppedCategories: selection.droppedCategories,
    memoryRefreshRunId: memoryRefreshRun?.id ?? null,
  };
}

/**
 * Prioritise and cap a scored candidate set so the generation prompt stays
 * under the provider's input-token limit. Selection is deterministic for a
 * given input, and the returned candidates are ordered by category then key so
 * the snapshot hash is stable regardless of scoring order.
 *
 * When the set is over the cap, at least one belief from every represented
 * category is retained (category coverage) before the remaining slots are
 * filled by descending score, so no whole category is silently dropped (unless
 * there are more categories than the cap itself).
 *
 * @param {Array<{ candidate: any; category: string; key: string; score: number }>} scored
 * @param {number} cap
 * @returns {{ selected: any[]; droppedCount: number; droppedCategories: string[]; fullyDroppedCategories: string[] }}
 */
export function selectPrioritizedCandidates(scored, cap) {
  const total = scored.length;
  if (total <= cap) {
    const selected = [...scored]
      .sort(byCategoryThenKey)
      .map((item) => item.candidate);
    return {
      selected,
      droppedCount: 0,
      droppedCategories: [],
      fullyDroppedCategories: [],
    };
  }

  const byPriority = [...scored].sort(byPriorityDesc);
  const leaderByCategory = new Map();
  for (const item of byPriority) {
    if (!leaderByCategory.has(item.category)) {
      leaderByCategory.set(item.category, item);
    }
  }

  const chosen = new Set();
  if (leaderByCategory.size <= cap) {
    // Guarantee category coverage first, then fill by descending priority.
    for (const leader of leaderByCategory.values()) chosen.add(leader);
    for (const item of byPriority) {
      if (chosen.size >= cap) break;
      chosen.add(item);
    }
  } else {
    // More categories than slots: keep the highest-priority category leaders.
    for (const leader of [...leaderByCategory.values()]
      .sort(byPriorityDesc)
      .slice(0, cap)) {
      chosen.add(leader);
    }
  }

  const keptByCategory = countByCategory(chosen);
  const totalByCategory = countByCategory(scored);
  const droppedCategories = [];
  const fullyDroppedCategories = [];
  for (const [category, totalCount] of totalByCategory) {
    const kept = keptByCategory.get(category) ?? 0;
    if (kept < totalCount) droppedCategories.push(category);
    if (kept === 0) fullyDroppedCategories.push(category);
  }
  droppedCategories.sort();
  fullyDroppedCategories.sort();

  const selected = [...chosen]
    .sort(byCategoryThenKey)
    .map((item) => item.candidate);
  return {
    selected,
    droppedCount: total - selected.length,
    droppedCategories,
    fullyDroppedCategories,
  };
}

/** @param {Iterable<{ category: string }>} items */
function countByCategory(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  return counts;
}

/** @param {{ category: string; key: string }} a @param {{ category: string; key: string }} b */
function byCategoryThenKey(a, b) {
  return (
    String(a.category).localeCompare(String(b.category)) ||
    String(a.key).localeCompare(String(b.key))
  );
}

/** @param {{ score: number }} a @param {{ score: number }} b */
function byPriorityDesc(a, b) {
  return b.score - a.score || byCategoryThenKey(a, b);
}

/**
 * Fold a set-relative recency bonus into each candidate's base score. Uses the
 * min/max observed timestamp within the set (never the wall clock) so the
 * result is deterministic for a given belief set.
 * @param {Array<{ candidate: any; category: string; key: string; base: number; recencyMs: number | null }>} items
 */
function withRecencyScores(items) {
  const times = items
    .map((item) => item.recencyMs)
    .filter((ms) => ms !== null);
  const min = times.length ? Math.min(...times) : 0;
  const max = times.length ? Math.max(...times) : 0;
  const span = max - min;
  return items.map((item) => {
    let bonus = 0;
    if (span > 0 && item.recencyMs !== null) {
      bonus = Math.round(((item.recencyMs - min) / span) * RECENCY_WEIGHT);
    }
    return {
      candidate: item.candidate,
      category: item.category,
      key: item.key,
      score: item.base + bonus,
    };
  });
}

/**
 * Base selection score for a raw belief: merchant authority and deterministic
 * provenance dominate, then confidence. Mirrors the merchant-plan relevance
 * weighting. The recency bonus is added separately in withRecencyScores.
 * @param {any} belief
 */
function scoreBeliefForSelection(belief) {
  let score = 0;
  const status = String(belief.status ?? "");
  if (status === BELIEF_STATUS.merchantCorrected) score += 40;
  else if (status === BELIEF_STATUS.merchantConfirmed) score += 32;
  if (Number(belief.precedence ?? 0) >= BELIEF_PRECEDENCE.directObservation) {
    score += 18;
  }
  const confidence =
    belief.confidence === null ? null : Number(belief.confidence);
  if (Number.isFinite(confidence)) score += Math.round(confidence * 20);
  return score;
}

/**
 * Most recent relevant timestamp for a belief, in epoch ms, or null.
 * @param {any} belief
 */
function beliefRecencyMs(belief) {
  const value =
    belief.lastEvaluatedAt ??
    belief.lastConfirmedAt ??
    belief.lastObservedAt ??
    belief.updatedAt ??
    belief.createdAt ??
    null;
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {any} belief
 */
function normalizeBeliefCandidate(belief) {
  const confidence =
    belief.confidence === null ? null : Number(belief.confidence);
  const evidence = Array.isArray(belief.evidence) ? belief.evidence : [];
  const sourceTypes = new Set(evidence.map((item) => item.sourceType));
  const status = String(belief.status ?? "");
  const precedence = Number(belief.precedence ?? 0);
  if (Number.isFinite(confidence) && confidence <= 0) return null;

  const definition = getBeliefDefinition(belief.key);
  const evidenceSummary = normalizeEvidenceSummary(evidence[0]);

  return {
    id: belief.id,
    key: belief.key,
    cat: belief.category,
    label: truncate(definition?.label ?? humanizeBeliefKey(belief.key), 70),
    val: safeValue(belief.value),
    type: belief.valueType,
    conf: Number.isFinite(confidence) ? Number(confidence.toFixed(2)) : null,
    status,
    authority: authorityLevel(precedence, status),
    sources: [...sourceTypes].sort(),
    evidence: evidenceSummary,
    caveat: importantCaveat(belief, confidence),
  };
}

/**
 * @param {any} evidence
 */
function normalizeEvidenceSummary(evidence) {
  if (!evidence?.summary) return null;
  return safeText(evidence.summary, 90);
}

/** @param {number} precedence @param {string} status */
function authorityLevel(precedence, status) {
  if (status === BELIEF_STATUS.merchantCorrected) return "merchant_corrected";
  if (status === BELIEF_STATUS.merchantConfirmed) return "merchant_confirmed";
  if (precedence >= BELIEF_PRECEDENCE.directObservation) return "deterministic";
  if (precedence <= BELIEF_PRECEDENCE.llmInference)
    return "lower_authority_inference";
  return "system_inference";
}

/** @param {any} value */
function safeValue(value) {
  return compactValue(value, null, 0);
}

/** @param {any} value @param {string | null} key @param {number} depth */
function compactValue(value, key, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return safeText(value, depth === 0 ? 90 : 60);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => compactValue(item, key, depth + 1));
  }
  if (typeof value !== "object") return null;
  if (depth >= 2 || isLowSignalValueKey(key)) return undefined;

  const output = {};
  const entries = Object.entries(value)
    .filter(
      ([childKey, item]) =>
        item !== undefined && !isLowSignalValueKey(childKey),
    )
    .sort(([a], [b]) => valueKeyRank(a) - valueKeyRank(b) || a.localeCompare(b))
    .slice(0, depth === 0 ? 10 : 5);
  for (const [childKey, item] of entries) {
    const compact = compactValue(item, childKey, depth + 1);
    if (compact !== undefined && compact !== null && compact !== "") {
      output[childKey] = compact;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

/** @param {any} belief */
function importantCaveat(belief, confidence) {
  for (const evidence of belief.evidence ?? []) {
    const flags = evidence?.metadata?.dataQualityFlags;
    if (Array.isArray(flags) && flags.length > 0) {
      return safeText(`Data quality: ${flags.slice(0, 3).join(", ")}`, 75);
    }
  }
  if (
    Number.isFinite(confidence) &&
    confidence < 0.75 &&
    belief.confidenceReason
  ) {
    return safeText(belief.confidenceReason, 75);
  }
  return null;
}

/** @param {string} key */
function humanizeBeliefKey(key) {
  return key.split(".").slice(-1)[0].replace(/_/g, " ");
}

/** @param {string | null | undefined} value @param {number} max */
function truncate(value, max) {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/** @param {unknown} value @param {number} max */
function safeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const redacted = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted]",
    );
  return truncate(redacted, max);
}

/** @param {string | null} key */
function isLowSignalValueKey(key) {
  return /policy|formula|rule|url|source|dependency|included|excluded|handling|provenance/i.test(
    key ?? "",
  );
}

/** @param {string} key */
function valueKeyRank(key) {
  if (/amount|percentage|rate|share|count|currency|window|period/i.test(key))
    return 0;
  if (/name|label|text|status|kind|complete|available|active/i.test(key))
    return 1;
  return 2;
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
