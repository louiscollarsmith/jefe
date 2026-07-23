// @ts-check

import { Type } from "@google/genai";

export const INTERVIEW_QUESTION_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "topic_key",
    "question",
    "question_intent",
    "answer_suggestions",
    "rationale",
  ],
  properties: {
    topic_key: { type: Type.STRING },
    question: { type: Type.STRING },
    question_intent: {
      type: Type.STRING,
      enum: ["open_question", "confirm_inference", "correct_inference"],
    },
    answer_suggestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    rationale: { type: Type.STRING },
  },
};

/**
 * @param {unknown} raw
 */
export function parseAndValidateInterviewQuestion(raw) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Question planner output must be an object.");
  if (typeof object.topic_key !== "string" || !object.topic_key.trim()) {
    return invalid("Question planner must choose a topic.");
  }
  if (typeof object.question !== "string" || object.question.trim().length < 10) {
    return invalid("Question planner must write a merchant-facing question.");
  }
  if (
    !["open_question", "confirm_inference", "correct_inference"].includes(
      String(object.question_intent),
    )
  ) {
    return invalid("Question planner used an unsupported question intent.");
  }
  if (!Array.isArray(object.answer_suggestions)) {
    return invalid("Question planner must include answer suggestions.");
  }
  if (typeof object.rationale !== "string" || object.rationale.trim().length < 3) {
    return invalid("Question planner must include a rationale.");
  }

  return {
    ok: true,
    plan: {
      topicKey: object.topic_key.trim(),
      question: normalizeQuestion(object.question),
      questionIntent: String(object.question_intent),
      answerSuggestions: object.answer_suggestions
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 4),
      rationale: object.rationale.trim().slice(0, 240),
    },
  };
}

/** @param {string} value */
function normalizeQuestion(value) {
  const question = value.replace(/\s+/g, " ").trim().slice(0, 320);
  return question.endsWith("?") ? question : `${question}?`;
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
