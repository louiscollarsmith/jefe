// @ts-nocheck

import { Type } from "@google/genai";
import { numericTextIsGrounded } from "../llm/numeric-grounding.server.js";
import { validateActionIntent } from "../actions/action-intent.server.js";
import { PLAN_CONFIDENCE } from "./constants.server.js";

export const MERCHANT_PLAN_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: ["candidates", "selectedRecommendation"],
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "id",
          "action",
          "goalAlignment",
          "whyRelevant",
          "supportingBeliefIds",
          "supportingInsightIds",
          "expectedEffort",
          "timeToUsefulSignal",
        ],
        properties: {
          id: { type: Type.STRING },
          action: { type: Type.STRING },
          goalAlignment: { type: Type.STRING },
          whyRelevant: { type: Type.STRING },
          supportingBeliefIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          supportingInsightIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          expectedEffort: { type: Type.STRING },
          timeToUsefulSignal: { type: Type.STRING },
          assumption: { type: Type.STRING, nullable: true },
          respectedConstraints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            nullable: true,
          },
        },
      },
    },
    selectedRecommendation: {
      type: Type.OBJECT,
      required: [
        "candidateId",
        "title",
        "summary",
        "primaryGoalId",
        "supportingGoalIds",
        "whyThisAction",
        "whyNow",
        "startToday",
        "executionSteps",
        "successSignal",
        "expectedBenefit",
        "supportingBeliefIds",
        "supportingInsightIds",
        "confidence",
      ],
      properties: {
        candidateId: { type: Type.STRING },
        title: { type: Type.STRING },
        summary: { type: Type.STRING },
        primaryGoalId: { type: Type.STRING },
        supportingGoalIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        whyThisAction: { type: Type.STRING },
        whyNow: { type: Type.STRING },
        startToday: { type: Type.STRING },
        executionSteps: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            required: ["title", "description"],
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
            },
          },
        },
        successSignal: {
          type: Type.OBJECT,
          required: ["description", "timeframe"],
          properties: {
            description: { type: Type.STRING },
            timeframe: { type: Type.STRING },
            target: { type: Type.STRING, nullable: true },
          },
        },
        expectedBenefit: { type: Type.STRING },
        supportingBeliefIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        supportingInsightIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        confidence: { type: Type.STRING, enum: PLAN_CONFIDENCE },
        assumption: { type: Type.STRING, nullable: true },
        caveat: { type: Type.STRING, nullable: true },
        // OPTIONAL: the typed action Jefe can carry out for this recommendation, from
        // the Action Capability Registry. Emitted ONLY when supplied memory directly
        // supports a registered capability; omitted otherwise. The magnitude is
        // advisory — the primitive computes the safe (floored, capped) parameters.
        actionIntent: {
          type: Type.OBJECT,
          nullable: true,
          required: ["actionType", "targetKind"],
          properties: {
            actionType: { type: Type.STRING },
            targetKind: { type: Type.STRING },
            markdownPercent: { type: Type.NUMBER, nullable: true },
            rationale: { type: Type.STRING, nullable: true },
          },
        },
      },
    },
  },
};

/**
 * @param {unknown} raw
 * @param {{ allowedBeliefIds: Set<string>; allowedInsightIds: Set<string>; allowedGoalIds: Set<string>; suppliedBeliefs?: any[]; suppliedInsights?: any[]; suppliedGoals?: any[]; previousRecommendations?: any[] }} context
 */
export function parseAndValidateMerchantPlanOutput(raw, context) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");
  if (!Array.isArray(object.candidates)) return invalid("Model output must include candidates.");
  if (object.candidates.length < 3 || object.candidates.length > 5) {
    return invalid("Plan generation must include three to five internal candidates.");
  }

  const candidates = [];
  const candidateIds = new Set();
  const candidateActions = new Set();
  for (const item of object.candidates) {
    const result = normalizeCandidate(item, context);
    if (!result.ok) return result;
    const duplicateKey = normalizeText(result.candidate.action);
    if (candidateIds.has(result.candidate.id)) return invalid("Candidate IDs must be unique.");
    if (candidateActions.has(duplicateKey)) return invalid("Candidates must be materially different.");
    candidateIds.add(result.candidate.id);
    candidateActions.add(duplicateKey);
    candidates.push(result.candidate);
  }

  const recommendation = normalizeRecommendation(object.selectedRecommendation, context);
  if (!recommendation.ok) return recommendation;
  if (!candidateIds.has(recommendation.recommendation.candidateId)) {
    return invalid("Selected recommendation must reference one supplied candidate.");
  }
  if (looksGeneric(recommendation.recommendation)) {
    return invalid("Recommendation is too generic.");
  }
  if (containsMultipleActions(recommendation.recommendation)) {
    return invalid("Recommendation appears to combine multiple unrelated actions.");
  }
  if (!numericClaimsAreGrounded(recommendation.recommendation, context)) {
    return invalid("Recommendation contains unsupported numerical claims.");
  }
  if (duplicatesPriorRecommendation(recommendation.recommendation, context.previousRecommendations ?? [])) {
    return invalid("Recommendation duplicates a previous accepted, rejected or completed Plan.");
  }

  return {
    ok: true,
    candidates,
    recommendation: recommendation.recommendation,
  };
}

function normalizeCandidate(value, context) {
  const item = asRecord(value);
  if (!item) return invalid("Every candidate must be an object.");
  const candidate = {
    id: cleanText(item.id, 50),
    action: cleanText(item.action, 180),
    goalAlignment: cleanText(item.goalAlignment, 220),
    whyRelevant: cleanText(item.whyRelevant, 260),
    supportingBeliefIds: uniqueStrings(item.supportingBeliefIds),
    supportingInsightIds: uniqueStrings(item.supportingInsightIds),
    expectedEffort: cleanText(item.expectedEffort, 80),
    timeToUsefulSignal: cleanText(item.timeToUsefulSignal, 80),
    assumption: cleanText(item.assumption, 180, true),
    respectedConstraints: uniqueStrings(item.respectedConstraints).slice(0, 5),
  };
  if (!candidate.id || !candidate.action || !candidate.goalAlignment || !candidate.whyRelevant) {
    return invalid("Every candidate needs an id, action, goal alignment and relevance.");
  }
  if (!candidate.expectedEffort || !candidate.timeToUsefulSignal) {
    return invalid("Every candidate needs effort and time to useful signal.");
  }
  if (candidate.supportingBeliefIds.length === 0) {
    return invalid("Every candidate must cite at least one belief.");
  }
  const ids = [...candidate.supportingBeliefIds, ...candidate.supportingInsightIds];
  const unsupportedBelief = candidate.supportingBeliefIds.find((id) => !context.allowedBeliefIds.has(id));
  if (unsupportedBelief) return invalid("Candidate cited a belief that was not supplied to the model.");
  const unsupportedInsight = candidate.supportingInsightIds.find((id) => !context.allowedInsightIds.has(id));
  if (unsupportedInsight) return invalid("Candidate cited an insight that was not supplied to the model.");
  if (ids.length === 0) return invalid("Candidate must cite support.");
  return { ok: true, candidate };
}

function normalizeRecommendation(value, context) {
  const item = asRecord(value);
  if (!item) return invalid("selectedRecommendation must be an object.");
  const executionSteps = Array.isArray(item.executionSteps)
    ? item.executionSteps.map(normalizeStep).filter(Boolean).slice(0, 5)
    : [];
  const successSignal = normalizeSuccessSignal(item.successSignal);
  const recommendation = {
    candidateId: cleanText(item.candidateId, 50),
    title: cleanText(item.title, 90),
    summary: cleanText(item.summary, 320),
    primaryGoalId: cleanText(item.primaryGoalId, 80),
    supportingGoalIds: uniqueStrings(item.supportingGoalIds),
    whyThisAction: cleanText(item.whyThisAction, 420),
    whyNow: cleanText(item.whyNow, 320),
    startToday: cleanText(item.startToday, 320),
    executionSteps,
    successSignal,
    expectedBenefit: cleanText(item.expectedBenefit, 320),
    supportingBeliefIds: uniqueStrings(item.supportingBeliefIds),
    supportingInsightIds: uniqueStrings(item.supportingInsightIds),
    confidence: typeof item.confidence === "string" ? item.confidence : "",
    assumption: cleanText(item.assumption, 220, true),
    caveat: cleanText(item.caveat, 220, true),
    // Advisory + best-effort: null when absent/malformed/unknown/mismatched (never fails the plan).
    actionIntent: null,
  };
  recommendation.actionIntent = normalizeActionIntent(item.actionIntent, recommendation);
  for (const field of [
    "candidateId",
    "title",
    "summary",
    "primaryGoalId",
    "whyThisAction",
    "whyNow",
    "startToday",
    "expectedBenefit",
  ]) {
    if (!recommendation[field]) return invalid(`Recommendation needs ${field}.`);
  }
  if (!context.allowedGoalIds.has(recommendation.primaryGoalId)) {
    return invalid("Recommendation cited a goal that was not supplied to the model.");
  }
  for (const goalId of recommendation.supportingGoalIds) {
    if (!context.allowedGoalIds.has(goalId)) return invalid("Recommendation cited a supporting goal that was not supplied to the model.");
  }
  if (recommendation.executionSteps.length === 0) {
    return invalid("Recommendation needs execution steps.");
  }
  if (!recommendation.successSignal) return invalid("Recommendation needs a success signal.");
  if (recommendation.supportingBeliefIds.length === 0) {
    return invalid("Recommendation must cite at least one belief.");
  }
  for (const beliefId of recommendation.supportingBeliefIds) {
    if (!context.allowedBeliefIds.has(beliefId)) {
      return invalid("Recommendation cited a belief that was not supplied to the model.");
    }
  }
  for (const insightId of recommendation.supportingInsightIds) {
    if (!context.allowedInsightIds.has(insightId)) {
      return invalid("Recommendation cited an insight that was not supplied to the model.");
    }
  }
  if (!PLAN_CONFIDENCE.includes(recommendation.confidence)) {
    return invalid("Recommendation used an unsupported confidence label.");
  }
  return { ok: true, recommendation };
}

/**
 * Normalize an OPTIONAL LLM-emitted action-intent against the Action Capability
 * Registry. Advisory + best-effort: a missing, malformed, or unknown intent returns
 * null and the plan still stands — the recommendation prose is the product, and the
 * typed primitive re-validates + floors the parameters before anything is proposed.
 * The LLM's magnitude (markdownPercent) is a suggestion the primitive is free to floor.
 * @param {unknown} value
 */
function normalizeActionIntent(value, recommendation) {
  const item = asRecord(value);
  if (!item) return null;
  const markdownPercent = Number(item.markdownPercent);
  const candidate = {
    actionType: cleanText(item.actionType, 50),
    targetKind: cleanText(item.targetKind, 50),
    params: Number.isFinite(markdownPercent) ? { markdownPercent } : undefined,
    rationale: cleanText(item.rationale, 220, true) ?? undefined,
  };
  const validation = validateActionIntent(candidate);
  if (!validation.ok) return null;
  return actionIntentMatchesRecommendation(validation.intent, recommendation)
    ? validation.intent
    : null;
}

function actionIntentMatchesRecommendation(intent, recommendation) {
  if (intent.actionType !== "price_markdown" || intent.targetKind !== "dead_stock") {
    return true;
  }
  const text = normalizeText([
    recommendation.title,
    recommendation.summary,
    recommendation.whyThisAction,
    recommendation.whyNow,
    recommendation.startToday,
    recommendation.expectedBenefit,
    ...(recommendation.executionSteps ?? []).flatMap((step) => [
      step.title,
      step.description,
    ]),
  ].filter(Boolean).join(" "));

  const mentionsClearance =
    /\b(clearance|markdown|mark down|marked down|discount|reduce prices?|lower prices?)\b/.test(text);
  const mentionsDeadStock =
    /\b(dead stock|old stock|stale stock|slow moving|slow mover|unsold|hasn t sold|haven t sold|cash tied up|trapped capital)\b/.test(text);
  const mentionsStockWithClearanceVerb =
    /\bstock\b/.test(text) &&
    /\b(clear|clear out|free|recover|release|move)\b/.test(text);

  return mentionsClearance || mentionsDeadStock || mentionsStockWithClearanceVerb;
}

function normalizeStep(value) {
  const item = asRecord(value);
  if (!item) return null;
  const title = cleanText(item.title, 90);
  const description = cleanText(item.description, 220);
  return title && description ? { title, description } : null;
}

function normalizeSuccessSignal(value) {
  const item = asRecord(value);
  if (!item) return null;
  const description = cleanText(item.description, 220);
  const timeframe = cleanText(item.timeframe, 90);
  const target = cleanText(item.target, 120, true);
  return description && timeframe ? { description, timeframe, target } : null;
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    : [];
}

function looksGeneric(recommendation) {
  const text = normalizeText(`${recommendation.title} ${recommendation.summary} ${recommendation.startToday}`);
  return [
    "increase revenue",
    "grow revenue",
    "improve retention",
    "increase sales",
    "improve customer experience",
    "optimize marketing",
    "fix inventory",
    "business plan",
  ].some((phrase) => text === phrase || text.startsWith(`${phrase} `));
}

function containsMultipleActions(recommendation) {
  const text = normalizeText(`${recommendation.title} ${recommendation.summary} ${recommendation.startToday}`);
  const broadJoiners = [" and launch ", " and build ", " and renegotiate ", " and redesign ", " and create "];
  return broadJoiners.some((joiner) => text.includes(joiner.trim()));
}

function numericClaimsAreGrounded(recommendation, context) {
  const text = [
    recommendation.title,
    recommendation.summary,
    recommendation.whyThisAction,
    recommendation.whyNow,
    recommendation.expectedBenefit,
    recommendation.startToday,
    ...recommendation.executionSteps.flatMap((step) => [
      step.title,
      step.description,
    ]),
    recommendation.successSignal?.description,
    recommendation.successSignal?.target,
  ]
    .filter(Boolean)
    .join(" ");
  const citedGoals = [
    recommendation.primaryGoalId,
    ...recommendation.supportingGoalIds,
  ];
  // Ground a number against the VALUES of the beliefs, insights and goals the
  // recommendation cites. The shared guard excludes ids/confidence and keeps
  // distinct numbers and units apart.
  const supportObjects = [
    ...recommendation.supportingBeliefIds.map((id) =>
      (context.suppliedBeliefs ?? []).find((belief) => belief.id === id),
    ),
    ...recommendation.supportingInsightIds.map((id) =>
      (context.suppliedInsights ?? []).find((insight) => insight.id === id),
    ),
    ...citedGoals.map((id) =>
      (context.suppliedGoals ?? []).find((goal) => goal.id === id),
    ),
  ].filter(Boolean);
  if (supportObjects.some(isBoundedCoverageMetric)) {
    supportObjects.push({ value: { percentage: 100, ratio: 1 } });
  }
  return numericTextIsGrounded(text, supportObjects);
}

function isBoundedCoverageMetric(item) {
  const key = String(item?.key ?? "").toLowerCase();
  const value =
    item?.val && typeof item.val === "object" && !Array.isArray(item.val)
      ? item.val
      : item?.value && typeof item.value === "object" && !Array.isArray(item.value)
        ? item.value
        : null;
  return (
    key.includes("coverage") &&
    value &&
    ("percentage" in value || "ratio" in value) &&
    ("denominator" in value || "activeVariants" in value)
  );
}

function duplicatesPriorRecommendation(recommendation, previousRecommendations) {
  const current = normalizeDuplicateKey(`${recommendation.title} ${recommendation.summary}`);
  return previousRecommendations
    .filter((item) =>
      ["accepted", "rejected", "refinement_requested", "completed"].includes(item.reviewStatus),
    )
    .some((item) => {
      const prior = normalizeDuplicateKey(`${item.title ?? ""} ${item.summary ?? ""}`);
      return prior && (prior === current || current.includes(prior) || prior.includes(current));
    });
}

function normalizeDuplicateKey(value) {
  return normalizeText(value).split(" ").filter((word) => !["the", "a", "an", "to", "for", "with", "and"].includes(word)).join(" ");
}

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanText(value, max, optional = false) {
  if (typeof value !== "string") return optional ? null : "";
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || (optional ? null : "");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

function invalid(error) {
  return { ok: false, error };
}
