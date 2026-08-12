// @ts-check

import { Type } from "@google/genai";
import { OPERATION_TYPES } from "../merchant-memory/conversation-constants.server.js";

const OPERATION_TYPE_VALUES = Object.values(OPERATION_TYPES);

export const STRUCTURED_OPERATION_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "operationType",
    "reason",
    "merchantStatement",
    "confidence",
    "requiresConfirmation",
  ],
  properties: {
    operationType: {
      type: Type.STRING,
      enum: OPERATION_TYPE_VALUES,
    },
    targetBeliefKey: {
      type: Type.STRING,
      nullable: true,
    },
    targetBeliefId: {
      type: Type.STRING,
      nullable: true,
    },
    category: {
      type: Type.STRING,
      nullable: true,
    },
    proposedValue: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        text: { type: Type.STRING, nullable: true },
        number: { type: Type.NUMBER, nullable: true },
        count: { type: Type.NUMBER, nullable: true },
        currency: { type: Type.STRING, nullable: true },
        amount: { type: Type.NUMBER, nullable: true },
        percentage: { type: Type.NUMBER, nullable: true },
        boolean: { type: Type.BOOLEAN, nullable: true },
        option: { type: Type.STRING, nullable: true },
        timestamp: { type: Type.STRING, nullable: true },
      },
    },
    valueType: {
      type: Type.STRING,
      nullable: true,
    },
    reason: {
      type: Type.STRING,
    },
    merchantStatement: {
      type: Type.STRING,
    },
    // What to SAY BACK to the merchant, in their own second person, for operations
    // that produce a spoken reply rather than a memory write — clarification_required
    // (a direct question naming what's missing) and no_memory_change (a short human
    // acknowledgement). `reason` above is the model's private justification and is
    // never shown to the merchant; this is. Optional so the deterministic fallback and
    // older persisted operations still parse.
    merchantReply: {
      type: Type.STRING,
      nullable: true,
      description:
        "The exact words to show the merchant, addressed to them in the second person (you/your), warm and plain. Never write 'the merchant' or narrate your reasoning here. Set this whenever operationType is clarification_required (make it a direct question that names what you need) or no_memory_change (a brief human acknowledgement).",
    },
    confidence: {
      type: Type.NUMBER,
      minimum: 0,
      maximum: 1,
    },
    requiresConfirmation: {
      type: Type.BOOLEAN,
    },
    relatedOpenQuestionId: {
      type: Type.STRING,
      nullable: true,
    },
    relatedBeliefKeys: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING },
    },
    relatedBeliefIds: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING },
    },
  },
};

/**
 * @param {unknown} raw
 */
export function parseAndValidateStructuredOperation(raw) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const operation = asRecord(parsed);
  if (!operation) return invalid("Model output must be a JSON object.");
  if (!OPERATION_TYPE_VALUES.includes(operation.operationType)) {
    return invalid("Model output used an unsupported operation type.");
  }
  if (typeof operation.reason !== "string" || operation.reason.length < 3) {
    return invalid("Model output must include a short reason.");
  }
  if (
    typeof operation.merchantStatement !== "string" ||
    operation.merchantStatement.length < 1
  ) {
    return invalid("Model output must include the merchant statement.");
  }
  if (
    !Number.isFinite(Number(operation.confidence)) ||
    Number(operation.confidence) < 0 ||
    Number(operation.confidence) > 1
  ) {
    return invalid("Model output confidence must be between 0 and 1.");
  }
  if (typeof operation.requiresConfirmation !== "boolean") {
    return invalid("Model output must include a confirmation decision.");
  }

  const normalized = {
    operationType: operation.operationType,
    targetBeliefKey: nullableString(operation.targetBeliefKey),
    targetBeliefId: nullableString(operation.targetBeliefId),
    category: nullableString(operation.category),
    proposedValue:
      operation.proposedValue === undefined ? null : operation.proposedValue,
    valueType: nullableString(operation.valueType),
    reason: operation.reason.slice(0, 500),
    merchantStatement: operation.merchantStatement.slice(0, 1000),
    merchantReply: nullableString(operation.merchantReply)?.slice(0, 600) ?? null,
    confidence: Number(operation.confidence),
    requiresConfirmation: operation.requiresConfirmation,
    relatedOpenQuestionId: nullableString(operation.relatedOpenQuestionId),
    relatedBeliefKeys: stringArray(operation.relatedBeliefKeys),
    relatedBeliefIds: stringArray(operation.relatedBeliefIds),
  };

  if (
    requiresTarget(normalized.operationType) &&
    !normalized.targetBeliefKey
  ) {
    return invalid("Model output must include a target belief key.");
  }
  if (
    requiresValue(normalized.operationType) &&
    normalized.proposedValue === null
  ) {
    return invalid("Model output must include a proposed value.");
  }

  return { ok: true, operation: normalized };
}

/**
 * @param {string} type
 */
function requiresTarget(type) {
  return [
    OPERATION_TYPES.confirmBelief,
    OPERATION_TYPES.correctBelief,
    // Obsolete takes a target but NO value — it names what to forget, not what to change it
    // to. Absent from requiresValue below for that reason, and rejected outright here without
    // a target key: a destructive op with no stated subject must never reach validation.
    OPERATION_TYPES.obsoleteBelief,
    OPERATION_TYPES.createMerchantBelief,
    OPERATION_TYPES.answerOpenQuestion,
    OPERATION_TYPES.requestExplanation,
  ].includes(type);
}

/**
 * @param {string} type
 */
function requiresValue(type) {
  return [
    OPERATION_TYPES.correctBelief,
    OPERATION_TYPES.createMerchantBelief,
    OPERATION_TYPES.answerOpenQuestion,
  ].includes(type);
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
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

/**
 * @param {unknown} value
 */
function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

/**
 * @param {string} error
 */
function invalid(error) {
  return { ok: false, error };
}
