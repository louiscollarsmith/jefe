// @ts-nocheck

import { Type } from "@google/genai";
import { getBeliefDefinition } from "../merchant-memory/conversational-belief-registry.server.js";

export const MERCHANT_INSIGHT_CORRECTION_PROMPT_VERSION =
  "merchant-insight-correction-v1";

export const MERCHANT_INSIGHT_CORRECTION_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "correctionType",
    "affectedBeliefIds",
    "merchantContext",
    "confidenceAdjustments",
    "followUpQuestion",
    "proposedMemoryChanges",
    "regenerateInsights",
    "rebuildMerchantMemory",
  ],
  properties: {
    correctionType: {
      type: Type.STRING,
      enum: [
        "fact_dispute",
        "interpretation",
        "missing_context",
        "mixed",
        "unclear",
      ],
    },
    affectedBeliefIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    merchantContext: { type: Type.STRING, nullable: true },
    confidenceAdjustments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["beliefId", "direction", "reason"],
        properties: {
          beliefId: { type: Type.STRING },
          direction: {
            type: Type.STRING,
            enum: ["lower", "unchanged", "needs_review"],
          },
          reason: { type: Type.STRING },
        },
      },
    },
    followUpQuestion: { type: Type.STRING, nullable: true },
    proposedMemoryChanges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["key", "category", "valueType", "value", "summary"],
        properties: {
          key: { type: Type.STRING },
          category: { type: Type.STRING },
          valueType: { type: Type.STRING },
          value: { type: Type.OBJECT },
          summary: { type: Type.STRING },
        },
      },
    },
    regenerateInsights: { type: Type.BOOLEAN },
    rebuildMerchantMemory: { type: Type.BOOLEAN },
  },
};

export function buildMerchantInsightCorrectionSystemPrompt() {
  return `You are Jefe's private correction processor.

A merchant is correcting Jefe's understanding in natural language. The merchant must never choose internal beliefs or understand evidence structure.

Your job is to decide what the merchant is actually correcting, which supporting beliefs are affected, whether the correction is about facts, interpretation or missing context, and what safe Merchant Memory updates should be made.

Do not overwrite deterministic Shopify facts. If the merchant adds context such as seasonality, wholesale revenue, preorder policy, or fulfilment constraints, store that as merchant context or policy. If the merchant disputes a deterministic fact such as last order date, order count, revenue or inventory count, mark the relevant belief as affected, request validation or follow-up where useful, and do not propose a direct overwrite.

Only propose Merchant Memory changes for merchant-defined context, preferences, policies, positioning, business model, channels, customer descriptions or operating rules. Every proposed key must be one of the supplied merchant-writable belief definitions.

Return only structured output. Do not include merchant-facing explanation.`;
}

export function buildMerchantInsightCorrectionPrompt(input) {
  return JSON.stringify({
    promptVersion: MERCHANT_INSIGHT_CORRECTION_PROMPT_VERSION,
    insight: input.insight,
    merchantCorrection: input.correction,
    supportingBeliefs: input.supportingBeliefs,
    merchantWritableBeliefs: input.merchantWritableBeliefs,
    outputGuidance: {
      correctionType:
        "fact_dispute | interpretation | missing_context | mixed | unclear",
      affectedBeliefIds: "subset of supportingBeliefs ids",
      merchantContext:
        "short private summary of merchant-provided context, or null",
      proposedMemoryChanges:
        "only merchant-writable context; never deterministic Shopify fact overwrites",
      regenerateInsights:
        "true when the current insight should not remain trusted as written",
      rebuildMerchantMemory:
        "true only when source validation or deterministic recalculation is needed",
    },
  });
}

export function parseAndValidateMerchantInsightCorrection(raw, context) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Correction output must be a JSON object.");

  const correctionType =
    typeof object.correctionType === "string" ? object.correctionType : "";
  const allowedTypes = [
    "fact_dispute",
    "interpretation",
    "missing_context",
    "mixed",
    "unclear",
  ];
  if (!allowedTypes.includes(correctionType)) {
    return invalid("Correction output used an unsupported correctionType.");
  }

  const affectedBeliefIds = uniqueStringArray(object.affectedBeliefIds);
  if (affectedBeliefIds.some((id) => !context.supportingBeliefIds.has(id))) {
    return invalid("Correction output referenced an unsupported belief.");
  }

  const confidenceAdjustments = normalizeConfidenceAdjustments(
    object.confidenceAdjustments,
    context,
  );
  if (!confidenceAdjustments.ok) return confidenceAdjustments;

  const proposedMemoryChanges = normalizeMemoryChanges(
    object.proposedMemoryChanges,
  );
  if (!proposedMemoryChanges.ok) return proposedMemoryChanges;

  return {
    ok: true,
    correction: {
      correctionType,
      affectedBeliefIds,
      merchantContext: cleanText(object.merchantContext, 500, true),
      confidenceAdjustments: confidenceAdjustments.items,
      followUpQuestion: cleanText(object.followUpQuestion, 240, true),
      proposedMemoryChanges: proposedMemoryChanges.items,
      regenerateInsights: object.regenerateInsights === true,
      rebuildMerchantMemory: object.rebuildMerchantMemory === true,
    },
  };
}

function normalizeConfidenceAdjustments(value, context) {
  if (!Array.isArray(value))
    return invalid("confidenceAdjustments must be an array.");
  const items = [];
  for (const item of value) {
    const object = asRecord(item);
    if (!object)
      return invalid("confidenceAdjustments entries must be objects.");
    const beliefId = typeof object.beliefId === "string" ? object.beliefId : "";
    if (!context.supportingBeliefIds.has(beliefId)) {
      return invalid("confidenceAdjustments referenced an unsupported belief.");
    }
    const direction =
      typeof object.direction === "string" ? object.direction : "";
    if (!["lower", "unchanged", "needs_review"].includes(direction)) {
      return invalid("confidenceAdjustments used an unsupported direction.");
    }
    items.push({
      beliefId,
      direction,
      reason:
        cleanText(object.reason, 180) ?? "Merchant correction changed context.",
    });
  }
  return { ok: true, items };
}

function normalizeMemoryChanges(value) {
  if (!Array.isArray(value))
    return invalid("proposedMemoryChanges must be an array.");
  const items = [];
  for (const item of value) {
    const object = asRecord(item);
    if (!object)
      return invalid("proposedMemoryChanges entries must be objects.");
    const key = typeof object.key === "string" ? object.key.trim() : "";
    const definition = getBeliefDefinition(key);
    if (
      !definition ||
      !definition.merchantCreatable ||
      definition.kind === "observation"
    ) {
      return invalid(
        "Correction tried to overwrite a non-merchant context belief.",
      );
    }
    if (
      object.category !== definition.category ||
      object.valueType !== definition.valueType
    ) {
      return invalid(
        "Correction memory change does not match the belief registry.",
      );
    }
    const valueObject = asRecord(object.value);
    if (!valueObject)
      return invalid("Correction memory change needs a structured value.");
    items.push({
      key,
      category: definition.category,
      valueType: definition.valueType,
      value: valueObject,
      summary:
        cleanText(object.summary, 220) ??
        `Merchant supplied context for ${definition.label}.`,
    });
  }
  return { ok: true, items };
}

function uniqueStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item) => typeof item === "string" && item.trim())),
  ];
}

function cleanText(value, max, nullable = false) {
  if (value === null || value === undefined) return nullable ? null : "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return nullable ? null : "";
  const redacted = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted]",
    );
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function invalid(error) {
  return { ok: false, error };
}
