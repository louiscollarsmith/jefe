// @ts-check

import { MEMORY_DERIVATION_VERSION } from "./constants.server.js";

export const EVIDENCE_TEMPLATE_VERSION = "v1";

export const EVIDENCE_TEMPLATES = {
  shopify_current_state_count: EVIDENCE_TEMPLATE_VERSION,
  shopify_windowed_order_aggregate: EVIDENCE_TEMPLATE_VERSION,
  shopify_customer_aggregate: EVIDENCE_TEMPLATE_VERSION,
  shopify_inventory_snapshot: EVIDENCE_TEMPLATE_VERSION,
  shopify_refund_aggregate: EVIDENCE_TEMPLATE_VERSION,
  shopify_currency_aggregate: EVIDENCE_TEMPLATE_VERSION,
  derived_ratio: EVIDENCE_TEMPLATE_VERSION,
  derived_trend: EVIDENCE_TEMPLATE_VERSION,
  data_quality_check: EVIDENCE_TEMPLATE_VERSION,
};

/**
 * @param {{
 *   definition: any;
 *   summary: string;
 *   observedAt?: Date | null;
 *   now: Date;
 *   metadata: Record<string, any>;
 * }} input
 */
export function buildDeterministicEvidence(input) {
  const evidenceTemplate = evidenceTemplateFor(input.definition);
  const derivationVersion = input.definition.derivationVersion ?? input.definition.version ?? "v1";
  return {
    sourceType: "system_derivation",
    sourceReference: `${MEMORY_DERIVATION_VERSION}:${input.definition.key}@${derivationVersion}`,
    evidenceType: "deterministic_calculation",
    summary: input.summary,
    observedAt: input.observedAt ?? input.now,
    metadata: {
      ...input.metadata,
      evidenceTemplate,
      evidenceTemplateVersion:
        EVIDENCE_TEMPLATES[evidenceTemplate] ?? EVIDENCE_TEMPLATE_VERSION,
      formulaIdentifier:
        input.metadata.formulaIdentifier ??
        `${input.definition.key}@${derivationVersion}`,
      derivationVersion,
      formulaSummary: input.definition.calculation,
      calculatedAt: input.now.toISOString(),
    },
  };
}

/** @param {{ key: string; category: string; valueType: string; window?: string }} definition */
export function evidenceTemplateFor(definition) {
  if (definition.category === "data") return "data_quality_check";
  if (definition.category === "inventory") return "shopify_inventory_snapshot";
  if (definition.category === "customers") return "shopify_customer_aggregate";
  if (definition.category === "refunds") return "shopify_refund_aggregate";
  if (definition.key.includes("currency")) return "shopify_currency_aggregate";
  if (definition.category === "orders" || definition.category === "business") {
    return "shopify_windowed_order_aggregate";
  }
  if (definition.valueType === "percentage") return "derived_ratio";
  if (String(definition.window ?? "").startsWith("trailing_")) {
    return "shopify_windowed_order_aggregate";
  }
  return "shopify_current_state_count";
}
