// @ts-nocheck

import { Type } from "@google/genai";
import { numericTextIsGrounded } from "../llm/numeric-grounding.server.js";
import { GOAL_HORIZONS } from "./constants.server.js";

export const MERCHANT_GOALS_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: ["threeMonths", "sixMonths", "twelveMonths"],
  properties: Object.fromEntries(
    GOAL_HORIZONS.map((horizon) => [
      horizon.key,
      {
        type: Type.OBJECT,
        required: ["title", "description", "supportingBeliefIds"],
        properties: {
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          supportingBeliefIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
      },
    ]),
  ),
};

/**
 * @param {unknown} raw
 * @param {{ allowedBeliefIds: Set<string>; suppliedBeliefs?: any[]; goalCoaching?: any[] }} context
 */
export function parseAndValidateMerchantGoalsOutput(raw, context) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");

  const goals = {};
  const seenTitles = new Set();
  const beliefsById = new Map(
    (context.suppliedBeliefs ?? []).map((belief) => [belief.id, belief]),
  );
  const targetRequirements = explicitMerchantTargetRequirements(
    context.goalCoaching ?? [],
  );
  for (const horizon of GOAL_HORIZONS) {
    const result = normalizeGoal(object[horizon.key], horizon.key);
    if (!result.ok) return result;
    const goal = result.goal;
    const duplicateKey = normalizeText(goal.title);
    if (seenTitles.has(duplicateKey)) {
      return invalid("Goals must not repeat the same title.");
    }
    seenTitles.add(duplicateKey);
    if (goal.supportingBeliefIds.length === 0) {
      return invalid("Every goal must cite at least one belief.");
    }
    for (const beliefId of goal.supportingBeliefIds) {
      if (!context.allowedBeliefIds.has(beliefId)) {
        return invalid("Goal cited a belief that was not supplied to the model.");
      }
    }
    const requiredTarget = targetRequirements.get(horizon.key);
    if (requiredTarget && !goalPreservesMerchantTarget(goal, requiredTarget)) {
      return invalid(
        `${horizon.key} must preserve the merchant-supplied ${requiredTarget.targetLabel} ${requiredTarget.metricLabel} target.`,
      );
    }
    if (
      !numericClaimsAreGrounded(goal, beliefsById, context.goalCoaching ?? [])
    ) {
      return invalid("Goal contains unsupported numerical claims.");
    }
    goals[horizon.key] = goal;
  }

  return { ok: true, goals };
}

/**
 * A number stated in a goal title or description (goals are persisted as target
 * beliefs) must appear in the VALUES of the beliefs the goal cites. Delegates to
 * the shared numeric guard so identifiers and confidence scores cannot ground a
 * fabricated target.
 * @param {any} goal
 * @param {Map<string, any>} beliefsById
 * @param {any[]} merchantNumericSupport
 */
function numericClaimsAreGrounded(goal, beliefsById, merchantNumericSupport = []) {
  const text = [goal.title, goal.description].filter(Boolean).join(" ");
  const supportBeliefs = goal.supportingBeliefIds
    .map((id) => beliefsById.get(id))
    .filter(Boolean);
  return numericTextIsGrounded(text, [...supportBeliefs, ...merchantNumericSupport]);
}

/**
 * @param {unknown} value
 * @param {string} horizon
 */
function normalizeGoal(value, horizon) {
  const item = asRecord(value);
  if (!item) return invalid(`${horizon} must be an object.`);
  const title = cleanText(item.title, 90);
  const description = cleanText(item.description, 260);
  const supportingBeliefIds = Array.isArray(item.supportingBeliefIds)
    ? [
        ...new Set(
          item.supportingBeliefIds.filter(
            (id) => typeof id === "string" && id.trim(),
          ),
        ),
      ]
    : [];

  if (!title || title.length < 4) {
    return invalid(`${horizon} needs a useful title.`);
  }
  if (!description || description.length < 12) {
    return invalid(`${horizon} needs a useful description.`);
  }
  if (!hasCommercialOutcomeTitle(title)) {
    return invalid(`${horizon} title must name a commercial outcome.`);
  }
  if (looksGeneric(title, description)) {
    return invalid(`${horizon} is too generic.`);
  }

  return {
    ok: true,
    goal: { title, description, supportingBeliefIds },
  };
}

/** @param {string} title */
function hasCommercialOutcomeTitle(title) {
  const text = normalizeText(title);
  return [
    "revenue",
    "sales",
    "grow",
    "growth",
    "expand",
    "repeat",
    "retention",
    "margin",
    "profit",
    "cash",
    "customer",
    "customers",
    "conversion",
    "order value",
  ].some((term) => text.includes(term));
}

/** @param {string} title @param {string} description */
function looksGeneric(title, description) {
  const text = normalizeText(`${title} ${description}`);
  const titleText = normalizeText(title);
  const generic = [
    "increase revenue",
    "grow revenue",
    "grow customers",
    "reduce refunds",
    "improve retention",
    "increase sales",
  ];
  const vague = [
    "across the business",
    "through better marketing",
    "with better marketing",
    "over the next year",
    "over time",
  ];
  return generic.some(
    (phrase) =>
      titleText === phrase ||
      text === phrase ||
      vague.some((tail) => text.includes(`${phrase} ${tail}`)),
  );
}

/** @param {unknown} value @param {number} max */
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {string} value */
function normalizeText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** @param {any[]} goalCoaching */
function explicitMerchantTargetRequirements(goalCoaching) {
  const requirements = new Map();
  for (const item of goalCoaching) {
    const text = [item?.summary, item?.metadata?.interpretedDirection]
      .filter(Boolean)
      .join(" ");
    const target = detectMerchantTarget(text);
    const metric = detectMerchantMetric(text);
    const horizonKey = detectMerchantTargetHorizon(text);
    if (!target || !metric || !horizonKey) continue;
    requirements.set(horizonKey, { ...target, ...metric });
  }
  return requirements;
}

/** @param {string} text */
function detectMerchantTargetHorizon(text) {
  const explicitUse = text.match(/\buse\s+the\s+(3|6|12)\s*month\s+horizon\b/i);
  if (explicitUse) return horizonKeyForMonths(explicitUse[1]);
  if (/\b3\s*(?:month|months|mo|mos|m)\b/i.test(text)) return "threeMonths";
  if (/\b6\s*(?:month|months|mo|mos|m)\b/i.test(text)) return "sixMonths";
  if (/\b12\s*(?:month|months|mo|mos|m)\b/i.test(text)) return "twelveMonths";
  return null;
}

/** @param {string} months */
function horizonKeyForMonths(months) {
  if (months === "3") return "threeMonths";
  if (months === "6") return "sixMonths";
  if (months === "12") return "twelveMonths";
  return null;
}

/** @param {string} text */
function detectMerchantTarget(text) {
  if (/\b2x\b|\bdouble\b|\btwo\s+times\b/i.test(text)) {
    return {
      targetLabel: "2x",
      targetPattern: /\b(?:2x|double|two\s+times)\b/i,
    };
  }
  if (/\b3x\b|\btriple\b|\bthree\s+times\b/i.test(text)) {
    return {
      targetLabel: "3x",
      targetPattern: /\b(?:3x|triple|three\s+times)\b/i,
    };
  }
  const percentMatch = text.match(/\b(\d{1,3})\s?%\b/);
  if (percentMatch) {
    const percent = percentMatch[1];
    return {
      targetLabel: `${percent}%`,
      targetPattern: new RegExp(`\\b${escapeRegExp(percent)}\\s?%`, "i"),
    };
  }
  return null;
}

/** @param {string} text */
function detectMerchantMetric(text) {
  if (/\brevenue\b|\bsales\b|\bturnover\b/i.test(text)) {
    return {
      metricLabel: "revenue",
      metricPattern: /\b(?:revenue|sales|turnover)\b/i,
    };
  }
  if (/\bmargin\b|\bprofit\b|\bprofitability\b|\bgross profit\b/i.test(text)) {
    return {
      metricLabel: "margin",
      metricPattern: /\b(?:margin|profit|profitability|gross profit)\b/i,
    };
  }
  if (/\bconversion\b|\bconvert\b/i.test(text)) {
    return {
      metricLabel: "conversion",
      metricPattern: /\b(?:conversion|convert)\b/i,
    };
  }
  if (
    /\brepeat\b.*\bpurchase\b|\bpurchase rate\b|\bretention\b|\blifetime value\b|\bltv\b/i.test(
      text,
    )
  ) {
    return {
      metricLabel: "repeat purchase",
      metricPattern:
        /\b(?:repeat\s+purchase|purchase rate|retention|lifetime value|ltv)\b/i,
    };
  }
  if (
    /\b(customer spend|spend per customer|buyer spend|order value|aov|average order)\b/i.test(
      text,
    )
  ) {
    return {
      metricLabel: "customer spend",
      metricPattern:
        /\b(?:customer spend|spend per customer|buyer spend|order value|aov|average order)\b/i,
    };
  }
  return null;
}

/**
 * @param {{ title: string; description?: string | null }} goal
 * @param {{ targetPattern: RegExp; metricPattern: RegExp }} requirement
 */
function goalPreservesMerchantTarget(goal, requirement) {
  const text = [goal.title, goal.description].filter(Boolean).join(" ");
  return requirement.targetPattern.test(text) && requirement.metricPattern.test(text);
}

/** @param {string} value */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {unknown} value */
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {string} error */
function invalid(error) {
  return { ok: false, error };
}
