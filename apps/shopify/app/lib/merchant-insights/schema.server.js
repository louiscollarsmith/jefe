// @ts-nocheck

import { Type } from "@google/genai";
import { numericTextIsGrounded } from "../llm/numeric-grounding.server.js";
import {
  INSIGHT_CATEGORIES,
  INSIGHT_CONFIDENCE,
  MAX_INSIGHTS,
} from "./constants.server.js";

export const MERCHANT_INSIGHT_COPY_LIMITS = {
  title: 70,
  finding: 190,
  whyItMatters: 130,
  caveat: 180,
};

const MAX_INSIGHT_TITLE_LENGTH = MERCHANT_INSIGHT_COPY_LIMITS.title;
const MAX_INSIGHT_FINDING_LENGTH = MERCHANT_INSIGHT_COPY_LIMITS.finding;
const MAX_INSIGHT_WHY_LENGTH = MERCHANT_INSIGHT_COPY_LIMITS.whyItMatters;
const MAX_INSIGHT_CAVEAT_LENGTH = MERCHANT_INSIGHT_COPY_LIMITS.caveat;

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
  const suppliedBeliefs = context.suppliedBeliefs ?? [];
  const beliefsById = new Map(
    suppliedBeliefs.map((belief) => [belief.id, belief]),
  );
  const searchableByBeliefId = new Map(
    suppliedBeliefs.map((belief) => [belief.id, searchableBeliefText(belief)]),
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
    if (!numericClaimsAreGrounded(normalized, beliefsById)) {
      return invalid("Insight contains unsupported numerical claims.");
    }
    const interpretation = validateInterpretationGrounding(
      normalized,
      searchableByBeliefId,
    );
    if (!interpretation.ok) {
      return invalid(interpretation.error);
    }
    valid.push(normalized);
  }

  return { ok: true, insights: valid.slice(0, MAX_INSIGHTS) };
}

/** @param {unknown} value */
function normalizeInsight(value) {
  const item = asRecord(value);
  if (!item) return invalid("Every insight must be an object.");
  const title = cleanText(item.title, false);
  const finding = cleanText(item.finding, false);
  const whyItMatters = cleanText(item.whyItMatters, false);
  const caveat = cleanText(item.caveat, true);
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
  if (title.length > MAX_INSIGHT_TITLE_LENGTH) {
    return invalid("Insight title is too long.");
  }
  if (finding.length > MAX_INSIGHT_FINDING_LENGTH) {
    return invalid("Insight finding is too long.");
  }
  if (whyItMatters.length > MAX_INSIGHT_WHY_LENGTH) {
    return invalid("Insight whyItMatters explanation is too long.");
  }
  if (caveat && caveat.length > MAX_INSIGHT_CAVEAT_LENGTH) {
    return invalid("Insight caveat is too long.");
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
 * A number stated in an insight must appear in the VALUES of the beliefs it
 * cites. Grounding is delegated to the shared numeric guard so identifiers,
 * confidence scores and merged array numbers cannot spuriously support a claim.
 * @param {any} insight
 * @param {Map<string, any>} beliefsById
 */
function numericClaimsAreGrounded(insight, beliefsById) {
  const text = [
    insight.title,
    insight.finding,
    insight.whyItMatters,
    insight.caveat,
  ]
    .filter(Boolean)
    .join(" ");
  const supportBeliefs = insight.supportingBeliefIds
    .map((id) => beliefsById.get(id))
    .filter(Boolean);
  return numericTextIsGrounded(text, supportBeliefs);
}

/**
 * @param {any} insight
 * @param {Map<string, string>} searchableByBeliefId
 */
export function validateInterpretationGrounding(insight, searchableByBeliefId) {
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
    {
      pattern: /speciali[sz]ed .*retail model/,
      label: "specialized retail model",
    },
    { pattern: /suggests? (?:a )?strategy/, label: "suggests strategy" },
    {
      pattern: /likely influences? (?:the )?(?:customer base|marketing approach)/,
      label: "likely influences customer base or marketing approach",
    },
    { pattern: /relatively high/, label: "relatively high" },
  ];
  for (const item of weakGenericPatterns) {
    if (item.pattern.test(text)) {
      return invalid(
        `Insight contains generic or unsupported interpretation language: "${item.label}".`,
      );
    }
  }

  const claimsThatNeedDirectSupport = [
    "premium",
    "curation",
    "curated",
    "expertise",
    "supply chain",
    "consumer demand",
    "customer base",
    "marketing approach",
    "operational risk",
  ];
  for (const claim of claimsThatNeedDirectSupport) {
    if (text.includes(claim) && !supportText.includes(claim)) {
      return invalid(
        `Insight contains generic or unsupported interpretation language: unsupported "${claim}" claim.`,
      );
    }
  }

  return { ok: true };
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
 * @param {boolean} nullable
 */
function cleanText(value, nullable) {
  if (value === null || value === undefined) return nullable ? null : "";
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return nullable ? null : "";
  return cleaned;
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
