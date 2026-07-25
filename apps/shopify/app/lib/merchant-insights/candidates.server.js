// @ts-nocheck

import { createHash } from "node:crypto";
import {
  ACTIVE_BELIEF_STATUSES,
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
} from "../merchant-memory/constants.server.js";
import { getBeliefDefinition } from "../merchant-memory/conversational-belief-registry.server.js";
import { MERCHANT_INSIGHTS_SNAPSHOT_VERSION } from "./constants.server.js";

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

  const candidates = beliefs
    .map(normalizeBeliefCandidate)
    .filter(Boolean)
    .sort((a, b) => a.cat.localeCompare(b.cat) || a.key.localeCompare(b.key));

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
    memoryRefreshRunId: memoryRefreshRun?.id ?? null,
  };
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
