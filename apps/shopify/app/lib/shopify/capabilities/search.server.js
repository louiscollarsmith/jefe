// @ts-check

import { loadShopifyCapabilityCatalog } from "./catalog.server.js";

const SEMANTIC_QUERY_EXPANSIONS = Object.freeze({
  shortage: ["stock_shortage", "inventory", "replenishment", "transfer", "available_quantity"],
  "out of stock": ["stock_shortage", "inventory", "replenishment"],
  restock: ["replenishment", "inventory", "transfer", "locations"],
  clearance: ["markdown", "price", "slow_moving", "variants"],
  discount: ["promotion", "checkout", "campaign", "conversion"],
  presentation: ["catalogue", "product_metadata", "taxonomy", "collections", "merchandising"],
  navigation: ["collections", "merchandising", "catalogue"],
  margin: ["cost", "price", "discounts", "margin"],
  shipping: ["fulfillment", "orders", "customer_notification"],
  customer: ["customers", "crm", "segmentation"],
  custom: ["metafields", "custom_data", "structured_metadata"],
});

/**
 * @typedef {import("./catalog.server.js").ShopifyCapabilityCatalog} ShopifyCapabilityCatalog
 */

/**
 * @param {string} condition
 * @param {{ catalog?: ShopifyCapabilityCatalog; limit?: number; writeOnly?: boolean }} [input]
 */
export function searchShopifyCapabilities(condition, input = {}) {
  const catalog = input.catalog ?? loadShopifyCapabilityCatalog();
  const queryTerms = expandTerms(condition);
  const rows = catalog.operations
    .filter((operation) => !input.writeOnly || operation.operationKind === "MUTATION")
    .map((operation) => {
      const haystack = capabilitySearchText(operation);
      const matchedTerms = [...queryTerms].filter((term) => haystack.includes(term));
      const entityBoost = operation.semantic.affectedEntities.some((entity) =>
        queryTerms.has(entity.toLowerCase()),
      )
        ? 2
        : 0;
      const score = matchedTerms.length + entityBoost;
      return {
        capabilityId: operation.id,
        providerRef: operation.providerRef,
        operation: operation.operation,
        operationKind: operation.operationKind,
        domain: operation.domain,
        score,
        matchedTerms,
        qualificationRequirements: operation.semantic.qualificationRequirements.map((requirement) => ({
          id: requirement.id,
          evidenceKey: requirement.evidenceKey,
          reason: requirement.reason,
        })),
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.operation.localeCompare(right.operation));
  return rows.slice(0, input.limit ?? 5);
}

/**
 * @param {string} condition
 */
function expandTerms(condition) {
  const normalized = normalize(condition);
  const terms = new Set(tokenize(normalized));
  for (const [phrase, expansions] of Object.entries(SEMANTIC_QUERY_EXPANSIONS)) {
    if (normalized.includes(phrase)) {
      terms.add(normalize(phrase));
      for (const expansion of expansions) terms.add(normalize(expansion));
    }
  }
  return terms;
}

/** @param {any} operation */
function capabilitySearchText(operation) {
  return normalize(
    [
      operation.operation,
      operation.domain,
      operation.description,
      ...(operation.semantic?.semanticEffects ?? []),
      ...(operation.semantic?.affectedEntities ?? []),
      ...(operation.semantic?.requiredEntities ?? []),
      ...(operation.semantic?.tags ?? []),
      ...(operation.semantic?.outcomes ?? []),
    ].join(" "),
  );
}

/** @param {string} value */
function tokenize(value) {
  return normalize(value)
    .split(/[^a-z0-9_]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

/** @param {string} value */
function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9_ ]+/g, " ");
}
