// @ts-check

import { Type } from "@google/genai";

export const STORE_UNDERSTANDING_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "storeSummary",
    "candidateBeliefs",
    "uncertainties",
    "suggestedInterviewConfirmations",
  ],
  properties: {
    storeSummary: { type: Type.STRING },
    candidateBeliefs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "beliefKey",
          "value",
          "confidence",
          "reason",
          "supportingEvidence",
        ],
        properties: {
          beliefKey: { type: Type.STRING },
          value: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, nullable: true },
              option: { type: Type.STRING, nullable: true },
              items: {
                type: Type.ARRAY,
                nullable: true,
                items: { type: Type.STRING },
              },
            },
          },
          confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
          reason: { type: Type.STRING },
          supportingEvidence: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ["type", "reference", "summary"],
              properties: {
                type: { type: Type.STRING },
                reference: { type: Type.STRING },
                summary: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
    uncertainties: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["topic", "reason"],
        properties: {
          topic: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
      },
    },
    suggestedInterviewConfirmations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["beliefKey", "question"],
        properties: {
          beliefKey: { type: Type.STRING },
          question: { type: Type.STRING },
        },
      },
    },
  },
};

/**
 * @param {unknown} raw
 */
export function parseAndValidateStoreUnderstandingOutput(raw) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");
  if (typeof object.storeSummary !== "string" || object.storeSummary.length < 5) {
    return invalid("Model output must include a store summary.");
  }
  if (!Array.isArray(object.candidateBeliefs)) {
    return invalid("Model output must include candidate beliefs.");
  }
  if (!Array.isArray(object.uncertainties)) {
    return invalid("Model output must include uncertainties.");
  }
  if (!Array.isArray(object.suggestedInterviewConfirmations)) {
    return invalid("Model output must include suggested confirmations.");
  }

  const candidateBeliefs = [];
  for (const item of object.candidateBeliefs.slice(0, 10)) {
    const candidate = asRecord(item);
    if (!candidate) return invalid("Each candidate belief must be an object.");
    if (typeof candidate.beliefKey !== "string" || !candidate.beliefKey.trim()) {
      return invalid("Each candidate belief must include a belief key.");
    }
    if (!asRecord(candidate.value)) {
      return invalid("Each candidate belief must include an object value.");
    }
    if (
      !Number.isFinite(Number(candidate.confidence)) ||
      Number(candidate.confidence) < 0 ||
      Number(candidate.confidence) > 1
    ) {
      return invalid("Each candidate belief confidence must be between 0 and 1.");
    }
    if (typeof candidate.reason !== "string" || candidate.reason.length < 5) {
      return invalid("Each candidate belief must include a concise reason.");
    }
    if (!Array.isArray(candidate.supportingEvidence)) {
      return invalid("Each candidate belief must include supporting evidence.");
    }

    candidateBeliefs.push({
      beliefKey: candidate.beliefKey.trim(),
      value: candidate.value,
      confidence: Number(candidate.confidence),
      reason: candidate.reason.trim().slice(0, 360),
      supportingEvidence: candidate.supportingEvidence
        .map(normalizeEvidence)
        .filter(Boolean)
        .slice(0, 5),
    });
  }

  return {
    ok: true,
    output: {
      storeSummary: object.storeSummary.trim().slice(0, 500),
      candidateBeliefs,
      uncertainties: object.uncertainties
        .map(normalizeUncertainty)
        .filter(Boolean)
        .slice(0, 8),
      suggestedInterviewConfirmations: object.suggestedInterviewConfirmations
        .map(normalizeConfirmation)
        .filter(Boolean)
        .slice(0, 8),
    },
  };
}

/** @param {unknown} value */
function normalizeEvidence(value) {
  const evidence = asRecord(value);
  if (!evidence) return null;
  if (
    typeof evidence.type !== "string" ||
    typeof evidence.reference !== "string" ||
    typeof evidence.summary !== "string"
  ) {
    return null;
  }
  return {
    type: evidence.type.trim().slice(0, 80),
    reference: evidence.reference.trim().slice(0, 120),
    summary: evidence.summary.trim().slice(0, 240),
  };
}

/** @param {unknown} value */
function normalizeUncertainty(value) {
  const uncertainty = asRecord(value);
  if (!uncertainty) return null;
  if (typeof uncertainty.topic !== "string" || typeof uncertainty.reason !== "string") {
    return null;
  }
  return {
    topic: uncertainty.topic.trim().slice(0, 120),
    reason: uncertainty.reason.trim().slice(0, 240),
  };
}

/** @param {unknown} value */
function normalizeConfirmation(value) {
  const confirmation = asRecord(value);
  if (!confirmation) return null;
  if (
    typeof confirmation.beliefKey !== "string" ||
    typeof confirmation.question !== "string"
  ) {
    return null;
  }
  return {
    beliefKey: confirmation.beliefKey.trim().slice(0, 120),
    question: confirmation.question.trim().slice(0, 300),
  };
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
