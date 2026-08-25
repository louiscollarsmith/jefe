// @ts-check
//
// Generic, dimensional blast-radius calculation for any Shopify mutation — task §11. Built
// entirely from the operation stub's argument/input-object type metadata and the actual request
// variables; no per-operation code. Walks the variables tree once, classifying each scalar leaf
// by the *field name* it hangs off (e.g. a field literally named "price"/"amount" contributes to
// moneyAffected; a field named "quantity"/"count" contributes to quantityDelta) — the same
// generic-metadata-driven approach catalog.server.js's validateShopifyOperationVariables already
// uses for structural validation, applied to risk measurement instead.
//
// This supplements, not replaces, gateway.server.js's existing evaluateAcceptedIntent (resource
// count cap + destructive/pricing/inventory keyword-vs-accepted-intent match) — that check stays
// as the accepted-intent guard; this module adds the richer dimensional measurement and its own
// cap policy, both attached to the gateway's ledger for audit and exposed to preview generation.

const MONEY_FIELD_PATTERN = /price|amount|total|cost|value|fee|budget|subtotal|balance/i;
const MONEY_TYPE_PATTERN = /^Money$|MoneyInput|MoneyV2|CurrencyCode/;
const QUANTITY_FIELD_PATTERN = /quantity|qty|count(?!ry)/i;
const PERCENTAGE_FIELD_PATTERN = /percent/i;
const DESTRUCTIVE_NAME_PATTERN = /delete|erase|revoke|uninstall|merge|cancel|close|disable/i;
const BULK_DESTRUCTIVE_NAME_PATTERN = /bulkdelete|bulkremove/i;

// Domains whose writes are visible to the storefront, customers, or the public web, not just
// the merchant's own admin — used for publicSurfaceImpact. Kept small and reviewed, same
// discipline as mutation-safety.server.js's REVIEWED_FAMILY_POLICIES.
const PUBLIC_SURFACE_DOMAINS = new Set([
  "content",
  "publishing_channels",
  "navigation",
  "markets_international",
  "collections",
  "products",
  "variants",
  "metaobjects",
]);

/**
 * @param {{
 *   stub: import("./catalog.server.js").ShopifyApiOperationStub;
 *   variables: Record<string, unknown>;
 * }} input
 * @returns {{
 *   resourcesAffected: number;
 *   moneyAffected: number;
 *   quantityDelta: number;
 *   percentageChange: number;
 *   customerCount: number;
 *   orderCount: number;
 *   publicSurfaceImpact: boolean;
 *   destructiveCount: number;
 * }}
 */
export function computeShopifyBlastRadius(input) {
  const { stub, variables } = input;
  const dims = {
    resourcesAffected: 0,
    moneyAffected: 0,
    quantityDelta: 0,
    percentageChange: 0,
    customerCount: 0,
    orderCount: 0,
    publicSurfaceImpact: PUBLIC_SURFACE_DOMAINS.has(stub.domain),
    destructiveCount: 0,
  };

  walk(variables, null, (value, fieldName) => {
    if (typeof value === "string" && value.startsWith("gid://shopify/")) {
      dims.resourcesAffected += 1;
      if (value.startsWith("gid://shopify/Customer/")) dims.customerCount += 1;
      if (value.startsWith("gid://shopify/Order/") || value.startsWith("gid://shopify/DraftOrder/")) {
        dims.orderCount += 1;
      }
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    if (fieldName && MONEY_FIELD_PATTERN.test(fieldName)) dims.moneyAffected += Math.abs(value);
    else if (fieldName && PERCENTAGE_FIELD_PATTERN.test(fieldName)) dims.percentageChange = Math.max(dims.percentageChange, Math.abs(value));
    else if (fieldName && QUANTITY_FIELD_PATTERN.test(fieldName)) dims.quantityDelta += Math.abs(value);
  });

  // Money-typed fields (Money/MoneyV2/MoneyInput scalars per the schema, even when the field's
  // own name doesn't say so, e.g. a nested `{ amount, currencyCode }` MoneyInput) are also
  // walked structurally via the stub's declared argument/input-object types.
  for (const argument of stub.arguments) {
    accumulateByDeclaredType(argument.type, variables[argument.name], stub.inputObjects, dims);
  }

  if (BULK_DESTRUCTIVE_NAME_PATTERN.test(stub.operation)) {
    dims.destructiveCount = Math.max(dims.destructiveCount, dims.resourcesAffected || 1);
  } else if (DESTRUCTIVE_NAME_PATTERN.test(stub.operation)) {
    dims.destructiveCount = Math.max(dims.destructiveCount, 1);
  }

  return dims;
}

/**
 * Structural walk driven by the schema's own declared types (not just field-name pattern
 * matching) — catches Money-typed values whose field is named e.g. "input"/"amount" nested
 * inside a MoneyInput, which name-pattern matching alone could miss if the leaf field itself
 * is named generically (e.g. `{ amount: { amount: "10.00", currencyCode: "USD" } }`).
 * @param {string} type
 * @param {unknown} value
 * @param {import("./catalog.server.js").ShopifyApiOperationStub["inputObjects"]} inputObjects
 * @param {ReturnType<typeof computeShopifyBlastRadius>} dims
 */
function accumulateByDeclaredType(type, value, inputObjects, dims) {
  if (value === null || value === undefined) return;
  const nullableType = type.endsWith("!") ? type.slice(0, -1) : type;
  const listMatch = nullableType.match(/^\[(.+)\]$/);
  if (listMatch) {
    if (Array.isArray(value)) {
      for (const item of value) accumulateByDeclaredType(listMatch[1], item, inputObjects, dims);
    }
    return;
  }
  if (MONEY_TYPE_PATTERN.test(nullableType)) {
    const numeric = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
    if (Number.isFinite(numeric)) dims.moneyAffected += Math.abs(numeric);
    if (typeof value === "object" && value && "amount" in value) {
      const amount = Number.parseFloat(String(/** @type {any} */ (value).amount));
      if (Number.isFinite(amount)) dims.moneyAffected += Math.abs(amount);
    }
    return;
  }
  const inputObject = inputObjects[nullableType];
  if (!inputObject || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of inputObject.fields) {
    accumulateByDeclaredType(field.type, /** @type {any} */ (value)[field.name], inputObjects, dims);
  }
}

/**
 * Reusable dimensional caps by risk tier — a second, richer layer over gateway.server.js's flat
 * resource-count cap (DEFAULT_MAX_AFFECTED_RESOURCES). Deliberately conservative for higher risk
 * tiers: the more confirmation an operation already requires, the less additional blast radius
 * it should be allowed before that confirmation is considered stale and must be re-obtained.
 * @type {Record<string, { resourcesAffected: number; moneyAffected: number; quantityDelta: number; customerCount: number; orderCount: number }>}
 */
export const DEFAULT_BLAST_RADIUS_CAPS = Object.freeze({
  NORMAL: { resourcesAffected: 200, moneyAffected: Infinity, quantityDelta: Infinity, customerCount: 200, orderCount: 200 },
  SENSITIVE: { resourcesAffected: 100, moneyAffected: 5000, quantityDelta: 5000, customerCount: 100, orderCount: 100 },
  DESTRUCTIVE: { resourcesAffected: 25, moneyAffected: 2000, quantityDelta: 2000, customerCount: 25, orderCount: 25 },
  PLATFORM_CRITICAL: { resourcesAffected: 5, moneyAffected: 500, quantityDelta: 500, customerCount: 5, orderCount: 5 },
});

/**
 * @param {ReturnType<typeof computeShopifyBlastRadius>} dims
 * @param {string} riskTier
 * @param {Partial<Record<keyof typeof DEFAULT_BLAST_RADIUS_CAPS["NORMAL"], number>>} [overrides]
 */
export function evaluateBlastRadiusCap(dims, riskTier, overrides = {}) {
  const caps = { ...(DEFAULT_BLAST_RADIUS_CAPS[riskTier] ?? DEFAULT_BLAST_RADIUS_CAPS.PLATFORM_CRITICAL), ...overrides };
  /** @type {Array<{ dimension: string; value: number; cap: number }>} */
  const exceeded = [];
  for (const dimension of /** @type {const} */ (["resourcesAffected", "moneyAffected", "quantityDelta", "customerCount", "orderCount"])) {
    const value = dims[dimension];
    const cap = caps[dimension];
    if (Number.isFinite(cap) && value > cap) exceeded.push({ dimension, value, cap });
  }
  return { ok: exceeded.length === 0, exceeded, caps };
}

/**
 * @param {unknown} value
 * @param {string | null} fieldName
 * @param {(value: unknown, fieldName: string | null) => void} visitor
 */
function walk(value, fieldName, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, fieldName, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, key, visitor);
    return;
  }
  visitor(value, fieldName);
}
