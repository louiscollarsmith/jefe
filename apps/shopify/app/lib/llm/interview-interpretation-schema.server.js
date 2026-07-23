// @ts-check

import { Type } from "@google/genai";

export const INTERVIEW_ANSWER_STATUSES = {
  accepted: "accepted",
  partiallyUnderstood: "partially_understood",
  clarificationRequired: "clarification_required",
  declined: "declined",
  notApplicable: "not_applicable",
  noMemoryChange: "no_memory_change",
};

export const INTERVIEW_INTERPRETATION_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "answer_status",
    "candidate_beliefs",
    "covered_topics",
    "needs_clarification",
    "merchant_visible_acknowledgement",
  ],
  properties: {
    answer_status: {
      type: Type.STRING,
      enum: Object.values(INTERVIEW_ANSWER_STATUSES),
    },
    candidate_beliefs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "belief_key",
          "value",
          "value_type",
          "merchant_statement_summary",
          "confidence",
        ],
        properties: {
          belief_key: { type: Type.STRING },
          value: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, nullable: true },
              option: { type: Type.STRING, nullable: true },
              number: { type: Type.NUMBER, nullable: true },
              boolean: { type: Type.BOOLEAN, nullable: true },
            },
          },
          value_type: { type: Type.STRING },
          merchant_statement_summary: { type: Type.STRING },
          confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
        },
      },
    },
    covered_topics: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    needs_clarification: { type: Type.BOOLEAN },
    clarification_question: { type: Type.STRING, nullable: true },
    merchant_visible_acknowledgement: { type: Type.STRING },
    suggested_next_topic: { type: Type.STRING, nullable: true },
  },
};

/**
 * @param {unknown} raw
 */
export function parseAndValidateInterviewInterpretation(raw) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");
  if (!Object.values(INTERVIEW_ANSWER_STATUSES).includes(object.answer_status)) {
    return invalid("Model output used an unsupported answer status.");
  }
  if (!Array.isArray(object.candidate_beliefs)) {
    return invalid("Model output must include candidate beliefs.");
  }
  if (!Array.isArray(object.covered_topics)) {
    return invalid("Model output must include covered topics.");
  }
  if (typeof object.needs_clarification !== "boolean") {
    return invalid("Model output must include a clarification decision.");
  }
  if (typeof object.merchant_visible_acknowledgement !== "string") {
    return invalid("Model output must include a merchant-visible acknowledgement.");
  }

  const candidateBeliefs = [];
  for (const item of object.candidate_beliefs.slice(0, 6)) {
    const candidate = asRecord(item);
    if (!candidate) return invalid("Each candidate belief must be an object.");
    if (typeof candidate.belief_key !== "string" || !candidate.belief_key) {
      return invalid("Each candidate belief must include a belief key.");
    }
    if (!asRecord(candidate.value)) {
      return invalid("Each candidate belief must include an object value.");
    }
    if (typeof candidate.value_type !== "string" || !candidate.value_type) {
      return invalid("Each candidate belief must include a value type.");
    }
    if (
      typeof candidate.merchant_statement_summary !== "string" ||
      candidate.merchant_statement_summary.length < 3
    ) {
      return invalid("Each candidate belief must include a statement summary.");
    }
    if (
      !Number.isFinite(Number(candidate.confidence)) ||
      Number(candidate.confidence) < 0 ||
      Number(candidate.confidence) > 1
    ) {
      return invalid("Each candidate belief confidence must be between 0 and 1.");
    }

    candidateBeliefs.push({
      belief_key: candidate.belief_key.trim(),
      value: candidate.value,
      value_type: candidate.value_type.trim(),
      merchant_statement_summary: candidate.merchant_statement_summary.slice(0, 240),
      confidence: Number(candidate.confidence),
    });
  }

  return {
    ok: true,
    interpretation: {
      answer_status: object.answer_status,
      candidate_beliefs: candidateBeliefs,
      covered_topics: object.covered_topics
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 10),
      needs_clarification: object.needs_clarification,
      clarification_question: nullableString(object.clarification_question),
      merchant_visible_acknowledgement:
        object.merchant_visible_acknowledgement.slice(0, 280),
      suggested_next_topic: nullableString(object.suggested_next_topic),
    },
  };
}

/**
 * @param {string} value
 */
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

/**
 * @param {unknown} value
 */
function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {string} error
 */
function invalid(error) {
  return { ok: false, error };
}
