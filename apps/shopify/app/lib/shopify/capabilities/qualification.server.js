// @ts-check

/**
 * @typedef {import("./catalog.server.js").ShopifyCapabilityManifest} ShopifyCapabilityManifest
 */

/**
 * @param {ShopifyCapabilityManifest} manifest
 */
export function buildShopifyCapabilityQualificationPlan(manifest) {
  return {
    capabilityId: manifest.id,
    providerRef: manifest.providerRef,
    operation: manifest.operation,
    operationKind: manifest.operationKind,
    source: "semantic_manifest",
    evidenceRequirements: manifest.semantic.qualificationRequirements.map((requirement) => ({
      id: requirement.id,
      evidenceKey: requirement.evidenceKey,
      operator: requirement.operator,
      reason: requirement.reason,
    })),
    readHints: buildReadHints(manifest),
  };
}

/**
 * @param {ReturnType<typeof buildShopifyCapabilityQualificationPlan>} plan
 * @param {Record<string, unknown>} evidence
 */
export function evaluateShopifyCapabilityQualification(plan, evidence) {
  const checks = plan.evidenceRequirements.map((requirement) => {
    const value = readEvidence(evidence, requirement.evidenceKey);
    const passed = evaluateOperator(requirement.operator, value);
    return {
      ...requirement,
      value,
      status:
        passed === true
          ? /** @type {const} */ ("passed")
          : passed === false
            ? /** @type {const} */ ("failed")
            : /** @type {const} */ ("unknown"),
    };
  });
  const failed = checks.filter((check) => check.status === "failed");
  const unknown = checks.filter((check) => check.status === "unknown");
  const status =
    failed.length > 0
      ? /** @type {const} */ ("rejected")
      : unknown.length > 0
        ? /** @type {const} */ ("needs_evidence")
        : /** @type {const} */ ("qualified");
  return { status, checks };
}

/**
 * @param {ShopifyCapabilityManifest} manifest
 */
function buildReadHints(manifest) {
  const tags = new Set(manifest.semantic.tags);
  const hints = [];
  if (tags.has("inventory") || tags.has("stock") || tags.has("transfer")) {
    hints.push({
      source: "canonical_mirror_first",
      providerRef: "shopify.inventory_items.read",
      gives: ["inventory.item.tracked", "inventory.source.available_quantity"],
    });
  }
  if (tags.has("locations") || tags.has("transfer") || tags.has("fulfillment")) {
    hints.push({
      source: "canonical_mirror_first",
      providerRef: "shopify.locations.read",
      gives: ["location.exists", "inventory.locations.different"],
    });
  }
  if (tags.has("catalogue") || tags.has("products") || tags.has("variants")) {
    hints.push({
      source: "canonical_mirror_first",
      providerRef: "shopify.products.read",
      gives: ["product.exists", "variant.ids.present", "target.field.differs"],
    });
  }
  return hints;
}

/**
 * @param {Record<string, unknown>} evidence
 * @param {string} key
 */
function readEvidence(evidence, key) {
  if (Object.prototype.hasOwnProperty.call(evidence, key)) return evidence[key];
  return key.split(".").reduce((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return /** @type {Record<string, unknown>} */ (value)[part];
  }, /** @type {unknown} */ (evidence));
}

/**
 * @param {string} operator
 * @param {unknown} value
 * @returns {boolean | null}
 */
function evaluateOperator(operator, value) {
  if (operator === "equals_true") return typeof value === "boolean" ? value === true : null;
  if (operator === "equals_false") return typeof value === "boolean" ? value === false : null;
  if (operator === "positive_number") {
    const number = Number(value);
    return Number.isFinite(number) ? number > 0 : null;
  }
  if (operator === "present") return value === undefined || value === null || value === "" ? false : true;
  if (operator === "differs") return typeof value === "boolean" ? value === true : null;
  if (operator === "all_present") {
    if (Array.isArray(value)) return value.length > 0 && value.every((item) => item !== null && item !== undefined && item !== "");
    if (value && typeof value === "object") {
      const entries = Object.values(/** @type {Record<string, unknown>} */ (value));
      return entries.length > 0 && entries.every((item) => item !== null && item !== undefined && item !== "");
    }
    return null;
  }
  return null;
}
