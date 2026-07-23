// @ts-check

export const CONVERSATIONAL_CATEGORIES = [
  "business",
  "catalog",
  "orders",
  "customers",
  "inventory",
  "goals",
  "operations",
  "preferences",
  "policies",
];

export const CONVERSATIONAL_VALUE_TYPES = {
  string: "string",
  number: "number",
  boolean: "boolean",
  currencyCode: "currency_code",
  currencyAmount: "currency_amount",
  percentage: "percentage",
  timestamp: "timestamp",
  enum: "enum",
};

/** @type {Record<string, ConversationalBeliefDefinition>} */
const REGISTRY = {
  "business.store_name": {
    key: "business.store_name",
    category: "business",
    label: "Store name",
    description: "The business name Jefe should use for this merchant.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: false,
    merchantCorrectable: true,
    confirmable: true,
    kind: "observation",
    guidance: "Map direct corrections to the merchant's store name here.",
  },
  "business.primary_currency": {
    key: "business.primary_currency",
    category: "business",
    label: "Primary currency",
    description: "The currency Jefe should treat as primary for business reporting.",
    valueType: CONVERSATIONAL_VALUE_TYPES.currencyCode,
    merchantCreatable: false,
    merchantCorrectable: true,
    confirmable: true,
    kind: "observation",
    guidance: "Use ISO 4217 currency codes such as GBP, EUR or USD.",
  },
  "catalog.active_product_count": {
    key: "catalog.active_product_count",
    category: "catalog",
    label: "Active products",
    description: "Active products observed in Shopify.",
    valueType: CONVERSATIONAL_VALUE_TYPES.number,
    merchantCreatable: false,
    merchantCorrectable: false,
    confirmable: true,
    kind: "observation",
    guidance: "Do not overwrite raw catalogue counts with merchant interpretation.",
  },
  "catalog.total_product_count": {
    key: "catalog.total_product_count",
    category: "catalog",
    label: "Total products",
    description: "Retained products observed in Shopify.",
    valueType: CONVERSATIONAL_VALUE_TYPES.number,
    merchantCreatable: false,
    merchantCorrectable: false,
    confirmable: true,
    kind: "observation",
    guidance: "Do not overwrite raw catalogue counts with merchant interpretation.",
  },
  "catalog.out_of_stock_product_count": {
    key: "catalog.out_of_stock_product_count",
    category: "catalog",
    label: "Out-of-stock products",
    description: "Products Jefe currently observes as out of stock.",
    valueType: CONVERSATIONAL_VALUE_TYPES.number,
    merchantCreatable: false,
    merchantCorrectable: false,
    confirmable: true,
    kind: "observation",
    guidance:
      "If the merchant says preorder items are available, create a policy rather than changing the observed count.",
  },
  "orders.total_order_count": {
    key: "orders.total_order_count",
    category: "orders",
    label: "Total orders",
    description: "Commerce orders observed in stored Shopify history.",
    valueType: CONVERSATIONAL_VALUE_TYPES.number,
    merchantCreatable: false,
    merchantCorrectable: true,
    confirmable: true,
    kind: "observation",
    guidance: "Allow corrections only when the merchant clearly scopes the count.",
  },
  "orders.average_order_value.all_time": {
    key: "orders.average_order_value.all_time",
    category: "orders",
    label: "Average order value",
    description: "Average order value calculated from stored Shopify orders.",
    valueType: CONVERSATIONAL_VALUE_TYPES.currencyAmount,
    merchantCreatable: false,
    merchantCorrectable: true,
    confirmable: true,
    kind: "observation",
    guidance: "Preserve the amount and currency structure.",
  },
  "customers.repeat_customer_rate.all_time": {
    key: "customers.repeat_customer_rate.all_time",
    category: "customers",
    label: "Repeat customer rate",
    description: "Share of known customers who have ordered more than once.",
    valueType: CONVERSATIONAL_VALUE_TYPES.percentage,
    merchantCreatable: false,
    merchantCorrectable: true,
    confirmable: true,
    kind: "inference",
    guidance:
      "If the merchant disputes the meaning of repeat customer, store the policy separately unless a numeric replacement is supplied.",
  },
  "inventory.out_of_stock_variant_count": {
    key: "inventory.out_of_stock_variant_count",
    category: "inventory",
    label: "Out-of-stock variants",
    description: "Variants with zero or negative observed inventory.",
    valueType: CONVERSATIONAL_VALUE_TYPES.number,
    merchantCreatable: false,
    merchantCorrectable: false,
    confirmable: true,
    kind: "observation",
    guidance:
      "Keep raw inventory counts separate from policies such as preorder availability.",
  },
  "goals.primary_business_goal": {
    key: "goals.primary_business_goal",
    category: "goals",
    label: "Primary business goal",
    description: "The main outcome the merchant wants Jefe to help with.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "goal",
    guidance: "Use concise merchant language, without inventing extra strategy.",
  },
  "goals.current_priority": {
    key: "goals.current_priority",
    category: "goals",
    label: "Current priority",
    description: "The merchant's current operational or commercial priority.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "goal",
    guidance: "Use for quarter, month or immediate priority statements.",
  },
  "business.primary_sales_channel": {
    key: "business.primary_sales_channel",
    category: "business",
    label: "Primary sales channel",
    description: "The channel the merchant considers most important.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "preference",
    guidance: "Examples include online store, wholesale, retail or marketplace.",
  },
  "business.business_model": {
    key: "business.business_model",
    category: "business",
    label: "Business model",
    description: "How the merchant describes the business model.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "inference",
    guidance: "Keep the value short and merchant-authored.",
  },
  "customers.primary_customer_type": {
    key: "customers.primary_customer_type",
    category: "customers",
    label: "Primary customer type",
    description: "The customer type the merchant says matters most.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "inference",
    guidance: "Do not store customer PII. Use aggregate customer descriptions only.",
  },
  "operations.fulfilment_model": {
    key: "operations.fulfilment_model",
    category: "operations",
    label: "Fulfilment model",
    description: "How the merchant fulfils orders.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "policy",
    guidance: "Examples include one warehouse, dropshipped or mixed fulfilment.",
  },
  "preferences.optimisation_priority": {
    key: "preferences.optimisation_priority",
    category: "preferences",
    label: "Optimisation priority",
    description: "What Jefe should optimise for when tradeoffs arise.",
    valueType: CONVERSATIONAL_VALUE_TYPES.enum,
    allowedValues: ["growth", "profit", "cash_flow", "retention", "revenue"],
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "preference",
    guidance: "Map profit, growth, cash flow, retention or revenue priorities.",
  },
  "policies.low_stock_threshold": {
    key: "policies.low_stock_threshold",
    category: "policies",
    label: "Low-stock threshold",
    description: "The inventory level below which the merchant considers an item low stock.",
    valueType: CONVERSATIONAL_VALUE_TYPES.number,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "policy",
    min: 0,
    max: 100000,
    guidance: "Use whole units.",
  },
  "policies.preorder_zero_inventory_available": {
    key: "policies.preorder_zero_inventory_available",
    category: "policies",
    label: "Preorder availability",
    description: "Whether zero-inventory preorder products should still be treated as available.",
    valueType: CONVERSATIONAL_VALUE_TYPES.boolean,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "policy",
    guidance:
      "Use when merchant says zero inventory is not truly unavailable because preorder is allowed.",
  },
  "policies.never_discount_products": {
    key: "policies.never_discount_products",
    category: "policies",
    label: "Never discount products",
    description: "Products or product groups Jefe should not discount.",
    valueType: CONVERSATIONAL_VALUE_TYPES.string,
    merchantCreatable: true,
    merchantCorrectable: true,
    confirmable: true,
    kind: "policy",
    guidance: "Keep the merchant's product group description, not customer PII.",
  },
};

export function getConversationalBeliefRegistry() {
  return REGISTRY;
}

/**
 * @param {string} key
 */
export function getBeliefDefinition(key) {
  return REGISTRY[key] ?? null;
}

/**
 * @param {string} category
 */
export function isAllowedConversationalCategory(category) {
  return CONVERSATIONAL_CATEGORIES.includes(category);
}

/**
 * @param {unknown} value
 * @param {ConversationalBeliefDefinition} definition
 */
export function validateConversationalValue(value, definition) {
  const objectValue = asRecord(value);
  if (containsLikelyCustomerPii(value)) {
    return { ok: false, error: "This looks like customer personal information." };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.string) {
    const text = extractTextValue(value);
    if (!text) return { ok: false, error: "Expected a text value." };
    if (text.length > 300) return { ok: false, error: "Text value is too long." };
    return { ok: true, value: { text } };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.number) {
    const number = extractNumberValue(value);
    if (number === null) return { ok: false, error: "Expected a number." };
    if (definition.min !== undefined && number < definition.min) {
      return { ok: false, error: `Expected at least ${definition.min}.` };
    }
    if (definition.max !== undefined && number > definition.max) {
      return { ok: false, error: `Expected at most ${definition.max}.` };
    }
    return { ok: true, value: { number } };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.boolean) {
    if (typeof value === "boolean") return { ok: true, value: { boolean: value } };
    if (typeof objectValue?.boolean === "boolean") {
      return { ok: true, value: { boolean: objectValue.boolean } };
    }
    return { ok: false, error: "Expected true or false." };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.currencyCode) {
    const currency =
      typeof value === "string"
        ? value
        : typeof objectValue?.currency === "string"
          ? objectValue.currency
          : "";
    const normalized = normalizeCurrencyCode(currency);
    if (!normalized) return { ok: false, error: "Expected a valid currency code." };
    return { ok: true, value: { currency: normalized } };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.currencyAmount) {
    if (
      objectValue &&
      Number.isFinite(Number(objectValue.amount))
    ) {
      return {
        ok: true,
        value: {
          amount: Number(objectValue.amount),
          currency:
            typeof objectValue.currency === "string"
              ? normalizeCurrencyCode(objectValue.currency)
              : null,
        },
      };
    }
    return { ok: false, error: "Expected an amount and optional currency." };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.percentage) {
    const percentage =
      objectValue && Number.isFinite(Number(objectValue.percentage))
        ? Number(objectValue.percentage)
        : Number(value);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      return { ok: false, error: "Expected a percentage from 0 to 100." };
    }
    return { ok: true, value: { percentage } };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.enum) {
    const raw = extractTextValue(value);
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
    if (!definition.allowedValues?.includes(normalized)) {
      return {
        ok: false,
        error: `Expected one of ${definition.allowedValues?.join(", ")}.`,
      };
    }
    return { ok: true, value: { option: normalized } };
  }

  if (definition.valueType === CONVERSATIONAL_VALUE_TYPES.timestamp) {
    const raw = extractTextValue(value);
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, error: "Expected a timestamp." };
    }
    return { ok: true, value: { timestamp: date.toISOString() } };
  }

  return { ok: false, error: "Unsupported belief value type." };
}

/**
 * @param {unknown} value
 */
export function formatBeliefValue(value) {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value !== "object") return String(value);
  const objectValue = asRecord(value);
  if (!objectValue) return String(value);
  if (typeof objectValue.text === "string") return objectValue.text;
  if (
    typeof objectValue.currency === "string" &&
    objectValue.amount === undefined
  ) {
    return objectValue.currency;
  }
  if (Number.isFinite(Number(objectValue.amount))) {
    const currency =
      typeof objectValue.currency === "string" ? ` ${objectValue.currency}` : "";
    return `${Number(objectValue.amount).toLocaleString("en-GB", {
      maximumFractionDigits: 2,
    })}${currency}`;
  }
  if (Number.isFinite(Number(objectValue.percentage))) {
    return `${Number(objectValue.percentage).toLocaleString("en-GB", {
      maximumFractionDigits: 1,
    })}%`;
  }
  if (Number.isFinite(Number(objectValue.count))) {
    return Number(objectValue.count).toLocaleString("en-GB");
  }
  if (Number.isFinite(Number(objectValue.number))) {
    return Number(objectValue.number).toLocaleString("en-GB");
  }
  if (typeof objectValue.boolean === "boolean") {
    return objectValue.boolean ? "Yes" : "No";
  }
  if (typeof objectValue.option === "string") return humanize(objectValue.option);
  if (typeof objectValue.timestamp === "string") {
    return new Date(objectValue.timestamp).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }
  return JSON.stringify(value);
}

/**
 * @param {string} key
 */
export function labelForBeliefKey(key) {
  return REGISTRY[key]?.label ?? humanize(key.split(".").slice(-1)[0] ?? key);
}

/**
 * @param {unknown} value
 */
function extractTextValue(value) {
  if (typeof value === "string") return value.trim();
  const objectValue = asRecord(value);
  if (typeof objectValue?.text === "string") {
    return objectValue.text.trim();
  }
  if (typeof objectValue?.option === "string") {
    return objectValue.option.trim();
  }
  return "";
}

/**
 * @param {unknown} value
 */
function extractNumberValue(value) {
  const objectValue = asRecord(value);
  const raw =
    typeof value === "number"
      ? value
      : objectValue && Number.isFinite(Number(objectValue.number))
        ? Number(objectValue.number)
        : objectValue && Number.isFinite(Number(objectValue.count))
          ? Number(objectValue.count)
          : Number.NaN;
  return Number.isFinite(raw) ? raw : null;
}

/**
 * @param {string} value
 */
function normalizeCurrencyCode(value) {
  const normalized = value.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(normalized)) return normalized;
  /** @type {Record<string, string>} */
  const words = {
    pounds: "GBP",
    pound: "GBP",
    sterling: "GBP",
    euros: "EUR",
    euro: "EUR",
    dollars: "USD",
    dollar: "USD",
  };
  return words[normalized.toLowerCase()] ?? null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function asRecord(value) {
  return typeof value === "object" && value !== null
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 */
function containsLikelyCustomerPii(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
}

/**
 * @param {string} value
 */
function humanize(value) {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @typedef {{
 *   key: string;
 *   category: string;
 *   label: string;
 *   description: string;
 *   valueType: string;
 *   allowedValues?: string[];
 *   merchantCreatable: boolean;
 *   merchantCorrectable: boolean;
 *   confirmable: boolean;
 *   kind: "observation" | "inference" | "policy" | "preference" | "goal";
 *   min?: number;
 *   max?: number;
 *   guidance: string;
 * }} ConversationalBeliefDefinition
 */
