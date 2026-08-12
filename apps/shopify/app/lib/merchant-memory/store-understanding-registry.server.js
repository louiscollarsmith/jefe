// @ts-check

export const STORE_UNDERSTANDING_DERIVATION_VERSION =
  "store-understanding-v2-context";
export const STORE_UNDERSTANDING_INPUT_VERSION = "store-summary-v2-context";

export const STORE_UNDERSTANDING_RUN_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  modelDisabled: "model_disabled",
};

export const STORE_UNDERSTANDING_VALUE_TYPES = {
  string: "string",
  enum: "enum",
  stringList: "string_list",
};

/** @type {Record<string, StoreUnderstandingBeliefDefinition>} */
const REGISTRY = {
  "business.description": {
    key: "business.description",
    category: "business",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.string,
    description:
      "A concise, cautious description of what the store appears to sell.",
    minimumEvidence: { products: 3 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.72,
    highConfidenceThreshold: 0.68,
    mediumConfidenceThreshold: 0.45,
    promptGuidance:
      "Infer only from catalogue names, product types, tags, vendors and safe aggregate metrics.",
  },
  "business.category": {
    key: "business.category",
    category: "business",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.string,
    description: "The apparent top-level store category.",
    minimumEvidence: { products: 5 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.85,
    highConfidenceThreshold: 0.75,
    mediumConfidenceThreshold: 0.5,
    promptGuidance:
      "Use broad merchant-safe categories, not a generated ontology.",
  },
  "business.catalogue_strategy": {
    key: "business.catalogue_strategy",
    category: "business",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.enum,
    allowedValues: [
      "specialist",
      "broad_assortment",
      "category_led",
      "single_product_focus",
    ],
    description:
      "Whether the catalogue appears specialist, broad, category-led or single-product-led.",
    minimumEvidence: { products: 3 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.85,
    highConfidenceThreshold: 0.72,
    mediumConfidenceThreshold: 0.48,
    promptGuidance:
      "Use product/category concentration and assortment spread. Do not infer merchant strategy objectives.",
  },
  "business.business_model": {
    key: "business.business_model",
    category: "business",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.string,
    description:
      "A cautious apparent business model such as DTC retail, wholesale-led, or mixed.",
    minimumEvidence: { products: 3 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.65,
    highConfidenceThreshold: 0.58,
    mediumConfidenceThreshold: 0.4,
    promptGuidance:
      "Infer only when catalogue and commerce aggregates support it. Avoid claims about channels not present in Shopify data.",
  },
  "customers.likely_primary_customer_type": {
    key: "customers.likely_primary_customer_type",
    category: "customers",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.string,
    description:
      "A low-authority hypothesis about the likely aggregate customer type.",
    minimumEvidence: { products: 5 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.6,
    highConfidenceThreshold: 0.56,
    mediumConfidenceThreshold: 0.38,
    promptGuidance:
      "Never use customer PII. Infer only aggregate customer type from product wording and baskets.",
  },
  "customers.purchase_pattern": {
    key: "customers.purchase_pattern",
    category: "customers",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.string,
    description:
      "A cautious interpretation of purchase behaviour from order aggregates.",
    minimumEvidence: { orders: 5 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.65,
    highConfidenceThreshold: 0.58,
    mediumConfidenceThreshold: 0.4,
    promptGuidance:
      "Use aggregate order count, repeat rate, AOV and items per order only.",
  },
  "catalog.assortment_character": {
    key: "catalog.assortment_character",
    category: "catalog",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.string,
    description:
      "A concise description of the catalogue's apparent assortment character.",
    minimumEvidence: { products: 3 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.75,
    highConfidenceThreshold: 0.68,
    mediumConfidenceThreshold: 0.45,
    promptGuidance:
      "Ground in product counts, active statuses, vendors, product types and sampled titles.",
  },
  "brand.apparent_positioning": {
    key: "brand.apparent_positioning",
    category: "brand",
    valueType: STORE_UNDERSTANDING_VALUE_TYPES.enum,
    allowedValues: ["premium", "value", "specialist", "convenience", "unclear"],
    description: "A low-authority hypothesis about apparent brand positioning.",
    minimumEvidence: { products: 5 },
    merchantConfirmable: true,
    merchantCorrectable: true,
    confidenceCeiling: 0.65,
    highConfidenceThreshold: 0.58,
    mediumConfidenceThreshold: 0.4,
    promptGuidance:
      "Use price distribution and product language. Do not overstate subjective positioning.",
  },
};

export function getStoreUnderstandingRegistry() {
  return REGISTRY;
}

/** @param {string} key */
export function getStoreUnderstandingDefinition(key) {
  return REGISTRY[key] ?? null;
}

/**
 * @param {unknown} value
 * @param {StoreUnderstandingBeliefDefinition} definition
 */
export function validateStoreUnderstandingValue(value, definition) {
  if (containsLikelyCustomerPii(value)) {
    return {
      ok: false,
      error: "Candidate value contains likely customer PII.",
    };
  }

  const objectValue = asRecord(value);
  if (!objectValue) return { ok: false, error: "Expected an object value." };

  if (definition.valueType === STORE_UNDERSTANDING_VALUE_TYPES.string) {
    const text =
      typeof objectValue.text === "string" ? cleanText(objectValue.text) : "";
    if (!text) return { ok: false, error: "Expected a text value." };
    return { ok: true, value: { text: text.slice(0, 300) } };
  }

  if (definition.valueType === STORE_UNDERSTANDING_VALUE_TYPES.enum) {
    const raw =
      typeof objectValue.option === "string"
        ? objectValue.option
        : typeof objectValue.text === "string"
          ? objectValue.text
          : "";
    const option = raw
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (!definition.allowedValues?.includes(option)) {
      return {
        ok: false,
        error: `Expected one of ${definition.allowedValues?.join(", ")}.`,
      };
    }
    return { ok: true, value: { option } };
  }

  if (definition.valueType === STORE_UNDERSTANDING_VALUE_TYPES.stringList) {
    const items = Array.isArray(objectValue.items)
      ? objectValue.items
          .filter((item) => typeof item === "string")
          .map(cleanText)
          .filter(Boolean)
          .slice(0, 8)
      : [];
    if (items.length === 0) return { ok: false, error: "Expected list items." };
    return { ok: true, value: { items } };
  }

  return { ok: false, error: "Unsupported value type." };
}

/**
 * @param {StoreUnderstandingBeliefDefinition} definition
 * @param {any} summary
 */
export function hasMinimumEvidence(definition, summary) {
  const productCount = Number(
    summary?.aggregateMetrics?.catalogue?.productCount ?? 0,
  );
  const orderCount = Number(summary?.aggregateMetrics?.orders?.orderCount ?? 0);
  if ((definition.minimumEvidence.products ?? 0) > productCount) return false;
  if ((definition.minimumEvidence.orders ?? 0) > orderCount) return false;
  return true;
}

/**
 * @param {StoreUnderstandingBeliefDefinition} definition
 * @param {number} modelConfidence
 * @param {any} summary
 */
export function cappedStoreUnderstandingConfidence(
  definition,
  modelConfidence,
  summary,
) {
  const productCount = Number(
    summary?.aggregateMetrics?.catalogue?.productCount ?? 0,
  );
  const orderCount = Number(summary?.aggregateMetrics?.orders?.orderCount ?? 0);
  let datasetCap = 0.85;
  if (productCount < 5) datasetCap = Math.min(datasetCap, 0.55);
  if ((definition.minimumEvidence.orders ?? 0) > 0 && orderCount < 10) {
    datasetCap = Math.min(datasetCap, 0.55);
  }
  if (orderCount === 0 && definition.category === "customers") {
    datasetCap = Math.min(datasetCap, 0.48);
  }
  return Math.max(
    0,
    Math.min(
      Number(modelConfidence) || 0,
      definition.confidenceCeiling,
      datasetCap,
    ),
  );
}

/** @param {any} value */
export function formatInferenceValue(value) {
  const objectValue = asRecord(value);
  if (!objectValue) return "unclear";
  if (typeof objectValue.text === "string") return objectValue.text;
  if (typeof objectValue.option === "string")
    return humanize(objectValue.option);
  if (Array.isArray(objectValue.items)) return objectValue.items.join(", ");
  return JSON.stringify(value);
}

/** @param {unknown} value */
function cleanText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

/** @param {unknown} value */
function containsLikelyCustomerPii(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /\+?\d[\d\s().-]{8,}\d/.test(text)
  );
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

/** @param {string} value */
function humanize(value) {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @typedef {{
 *   key: string;
 *   category: string;
 *   valueType: string;
 *   allowedValues?: string[];
 *   description: string;
 *   minimumEvidence: { products?: number; orders?: number };
 *   merchantConfirmable: boolean;
 *   merchantCorrectable: boolean;
 *   confidenceCeiling: number;
 *   highConfidenceThreshold: number;
 *   mediumConfidenceThreshold: number;
 *   promptGuidance: string;
 * }} StoreUnderstandingBeliefDefinition
 */
