// @ts-nocheck

import { Type } from "@google/genai";
import {
  INSIGHT_CATEGORIES,
  INSIGHT_CONFIDENCE,
  MAX_INSIGHTS,
} from "./constants.server.js";

export const MERCHANT_INSIGHTS_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: ["insights"],
  properties: {
    insights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "title",
          "finding",
          "whyItMatters",
          "supportingBeliefIds",
          "confidence",
          "category",
        ],
        properties: {
          title: { type: Type.STRING },
          finding: { type: Type.STRING },
          whyItMatters: { type: Type.STRING },
          supportingBeliefIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          confidence: { type: Type.STRING, enum: INSIGHT_CONFIDENCE },
          category: { type: Type.STRING, enum: INSIGHT_CATEGORIES },
          caveat: { type: Type.STRING, nullable: true },
        },
      },
    },
  },
};

/**
 * @param {unknown} raw
 * @param {{ allowedBeliefIds: Set<string>; suppliedBeliefs: any[] }} context
 */
export function parseAndValidateMerchantInsightsOutput(raw, context) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");
  if (!Array.isArray(object.insights)) {
    return invalid("Model output must include an insights array.");
  }
  if (object.insights.length > MAX_INSIGHTS) {
    return invalid("Model output returned too many insights.");
  }

  const valid = [];
  const seenTitles = new Set();
  const searchableByBeliefId = new Map(
    context.suppliedBeliefs.map((belief) => [
      belief.id,
      searchableBeliefText(belief),
    ]),
  );

  for (const item of object.insights) {
    const insight = normalizeInsight(item);
    if (!insight.ok) return insight;
    const normalized = insight.insight;
    const duplicateKey = normalizeDuplicateKey(
      normalized.title,
      normalized.finding,
    );
    if (seenTitles.has(duplicateKey)) continue;
    seenTitles.add(duplicateKey);

    if (normalized.supportingBeliefIds.length === 0) {
      return invalid("Every insight must cite at least one belief.");
    }
    for (const beliefId of normalized.supportingBeliefIds) {
      if (!context.allowedBeliefIds.has(beliefId)) {
        return invalid(
          "Insight cited a belief that was not supplied to the model.",
        );
      }
    }
    if (!numericClaimsAreGrounded(normalized, searchableByBeliefId)) {
      return invalid("Insight contains unsupported numerical claims.");
    }
    if (
      !interpretationIsSpecificAndGrounded(normalized, searchableByBeliefId)
    ) {
      return invalid(
        "Insight contains generic or unsupported interpretation language.",
      );
    }
    valid.push(normalized);
  }

  return { ok: true, insights: valid.slice(0, MAX_INSIGHTS) };
}

/** @param {unknown} value */
function normalizeInsight(value) {
  const item = asRecord(value);
  if (!item) return invalid("Every insight must be an object.");
  const title = cleanText(item.title, 80);
  const finding = cleanText(item.finding, 280);
  const whyItMatters = cleanText(item.whyItMatters, 180);
  const caveat = cleanText(item.caveat, 220, true);
  const supportingBeliefIds = Array.isArray(item.supportingBeliefIds)
    ? [
        ...new Set(
          item.supportingBeliefIds.filter(
            (id) => typeof id === "string" && id.trim(),
          ),
        ),
      ]
    : [];
  const confidence = typeof item.confidence === "string" ? item.confidence : "";
  const category = typeof item.category === "string" ? item.category : "";

  if (!title || title.length < 4)
    return invalid("Every insight needs a useful title.");
  if (!finding || finding.length < 12)
    return invalid("Every insight needs a useful finding.");
  if (!whyItMatters || whyItMatters.length < 12) {
    return invalid("Every insight needs a useful whyItMatters explanation.");
  }
  if (!INSIGHT_CONFIDENCE.includes(confidence)) {
    return invalid("Insight used an unsupported confidence label.");
  }
  if (!INSIGHT_CATEGORIES.includes(category)) {
    return invalid("Insight used an unsupported category.");
  }

  return {
    ok: true,
    insight: {
      title,
      finding,
      whyItMatters,
      supportingBeliefIds,
      confidence,
      category,
      caveat,
    },
  };
}

/**
 * @param {any} insight
 * @param {Map<string, string>} searchableByBeliefId
 */
function numericClaimsAreGrounded(insight, searchableByBeliefId) {
  const text = [
    insight.title,
    insight.finding,
    insight.whyItMatters,
    insight.caveat,
  ]
    .filter(Boolean)
    .join(" ");
  const claims = numericFragments(text);
  if (claims.length === 0) return true;
  const supportText = insight.supportingBeliefIds
    .map((id) => searchableByBeliefId.get(id) ?? "")
    .join(" ");
  return claims.every((claim) => supportText.includes(claim));
}

/**
 * @param {any} insight
 * @param {Map<string, string>} searchableByBeliefId
 */
function interpretationIsSpecificAndGrounded(insight, searchableByBeliefId) {
  const text = normalizeSearchText(
    [insight.title, insight.finding, insight.whyItMatters, insight.caveat]
      .filter(Boolean)
      .join(" "),
  );
  const supportText = normalizeSearchText(
    insight.supportingBeliefIds
      .map((id) => searchableByBeliefId.get(id) ?? "")
      .join(" "),
  );

  const weakGenericPatterns = [
    /speciali[sz]ed .*retail model/,
    /suggests? (?:a )?strategy/,
    /likely influences? (?:the )?(?:customer base|marketing approach)/,
    /relatively high/,
  ];
  if (weakGenericPatterns.some((pattern) => pattern.test(text))) return false;

  const claimsThatNeedDirectSupport = [
    "premium",
    "curation",
    "expertise",
    "supply chain",
    "consumer demand",
    "customer base",
    "marketing approach",
    "operational risk",
  ];
  return claimsThatNeedDirectSupport.every(
    (claim) => !text.includes(claim) || supportText.includes(claim),
  );
}

/** @param {string} text */
function numericFragments(text) {
  const matches = text.match(/\b\d+(?:,\d{3})*(?:\.\d+)?%?\b/g) ?? [];
  return [
    ...new Set(
      matches.map((match) => match.replace(/,/g, "").replace(/%$/, "")),
    ),
  ];
}

/** @param {any} belief */
function searchableBeliefText(belief) {
  return JSON.stringify(belief).replace(/,/g, "").toLowerCase();
}

/** @param {string} text */
function normalizeSearchText(text) {
  return text.replace(/,/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** @param {string} title @param {string} finding */
function normalizeDuplicateKey(title, finding) {
  return `${title} ${finding}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @param {boolean} [nullable]
 */
function cleanText(value, max, nullable = false) {
  if (value === null || value === undefined) return nullable ? null : "";
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return nullable ? null : "";
  return cleaned.slice(0, max);
}

/** @param {string} value */
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {string} error */
function invalid(error) {
  return { ok: false, error };
}
