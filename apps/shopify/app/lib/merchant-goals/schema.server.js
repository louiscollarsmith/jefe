// @ts-nocheck

import { Type } from "@google/genai";
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
 * @param {{ allowedBeliefIds: Set<string>; suppliedBeliefs?: any[] }} context
 */
export function parseAndValidateMerchantGoalsOutput(raw, context) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");

  const goals = {};
  const seenTitles = new Set();
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
    goals[horizon.key] = goal;
  }

  return { ok: true, goals };
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
