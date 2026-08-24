// @ts-check
//
// Merchant-relevant domain taxonomy for the full Shopify Admin API surface, plus structural
// (domain-driven, not per-operation) OAuth scope inference. Replaces the old 7-bucket
// inferDomain() that left 467/810 real operations in an undifferentiated "general" catch-all.
//
// Two separate concerns live here on purpose:
//   1. classifyShopifyOperationDomain — which merchant-relevant area an operation belongs to.
//      Ordered pattern rules (most specific first); anything unmatched is OTHER_UNKNOWN, never
//      silently folded into a bucket it doesn't belong to.
//   2. inferShopifyOperationScopes — Shopify's GraphQL schema introspection does not expose
//      required OAuth scopes at all (verified against real introspection: 810 operations, 0
//      scope hints in the schema itself). Scope is inferred structurally from domain + a small
//      set of name sub-patterns, sourced from Shopify's own public scope documentation — never
//      guessed per-operation. Confidence is tracked explicitly so "we don't know" is a real,
//      load-bearing state (see mutation-safety.server.js / gateway.server.js), not silently
//      treated as "no scope needed."

/** Every domain an operation can resolve to. OTHER_UNKNOWN is a real, expected bucket — not a bug. */
export const SHOPIFY_DOMAINS = Object.freeze([
  "products",
  "variants",
  "collections",
  "inventory",
  "inventory_transfers",
  "customers",
  "customer_segments",
  "discounts_promotions",
  "orders",
  "fulfillment",
  "returns",
  "refunds",
  "draft_orders",
  "order_edits",
  "content",
  "navigation",
  "markets_international",
  "marketing",
  "publishing_channels",
  "metafields",
  "metaobjects",
  "subscriptions",
  "gift_cards",
  "b2b_company",
  "app_platform",
  "privacy_compliance",
  "financial_payment",
  "other_unknown",
]);

const DOMAIN_SET = new Set(SHOPIFY_DOMAINS);

/** @param {string} domain */
export function isKnownShopifyDomain(domain) {
  return DOMAIN_SET.has(domain);
}

// Ordered rules: first match wins. More specific sub-domains are listed before the generic
// domain they'd otherwise fall into (e.g. inventory_transfers before inventory; order_edits,
// draft_orders, refunds, returns, fulfillment before the generic orders catch-all).
/** @type {Array<{ test: RegExp; domain: string }>} */
const DOMAIN_RULES = [
  { test: /segment/, domain: "customer_segments" },
  { test: /inventorytransfer|inventoryshipment/, domain: "inventory_transfers" },
  { test: /orderedit|calculatedorder/, domain: "order_edits" },
  { test: /draftorder/, domain: "draft_orders" },
  { test: /return|reversefulfillmentorder|exchange/, domain: "returns" },
  { test: /refund/, domain: "refunds" },
  { test: /fulfillment/, domain: "fulfillment" },
  { test: /sellingplan/, domain: "subscriptions" },
  { test: /discount|quantityrule/, domain: "discounts_promotions" },
  { test: /giftcard/, domain: "gift_cards" },
  { test: /metaobject/, domain: "metaobjects" },
  { test: /metafield/, domain: "metafields" },
  { test: /subscription/, domain: "subscriptions" },
  { test: /compan(y|ies)/, domain: "b2b_company" },
  { test: /variant/, domain: "variants" },
  { test: /combinedlisting|taxonomy/, domain: "products" },
  { test: /collection|catalog(?!ue)/, domain: "collections" },
  { test: /^marketing|abandonedcheckout|abandonment|pixel/, domain: "marketing" },
  { test: /webpresence|market(?!ing)|backupregion/, domain: "markets_international" },
  { test: /channel|publication|publishable|productpublish|productunpublish/, domain: "publishing_channels" },
  { test: /menu|urlredirect/, domain: "navigation" },
  { test: /article|blog|comment|^pages?$|^page[a-z]|onlinestore/, domain: "content" },
  { test: /privacy|erasure|consent|gdpr|datasale/, domain: "privacy_compliance" },
  {
    test: /payment|billing|cashdrawer|cashmanagement|cashtracking|storecredit|dispute|finance|checkout|pricelist|tender|transaction/,
    domain: "financial_payment",
  },
  {
    test: /^app[a-z]|appinstallation|previewinstall|webhook|bulkoperation|carrierservice|validation|delivery|shipping|theme|translat|locale|^files?$|report|analytics|^domain$|staffmember|^user|businessentity|businessentities|carttransform|accesstoken|deletionevent|^event|mobileplatform|^node|pointofsale|savedsearch|scripttag|^shop$|shoppolicy|shopresourcefeedback|shopifyfunction|shopifyql|stagedupload|storefrontaccesstoken|^job$|^flow/,
    domain: "app_platform",
  },
  { test: /inventory|location/, domain: "inventory" },
  { test: /customer/, domain: "customers" },
  { test: /order/, domain: "orders" },
  { test: /product/, domain: "products" },
];

/**
 * @param {string} operation the GraphQL field name, e.g. "productVariantsBulkUpdate"
 * @returns {string} one of SHOPIFY_DOMAINS
 */
export function classifyShopifyOperationDomain(operation) {
  const value = String(operation ?? "").toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (rule.test.test(value)) return rule.domain;
  }
  return "other_unknown";
}

/**
 * Domain -> base { read, write } scope pair, sourced from Shopify's own Admin API scope
 * documentation (shopify.dev/docs/api/usage/access-scopes), not derived from introspection
 * (introspection carries no scope data at all). `confidence: "high"` means the domain maps
 * cleanly to one scope pair; `"inferred"` means a reasonable but not Shopify-confirmed mapping;
 * domains absent from this table (or resolving to null) get `"unknown"` — see
 * inferShopifyOperationScopes below.
 * @type {Record<string, { read?: string; write?: string; confidence: "high" | "inferred" }>}
 */
const DOMAIN_SCOPES = {
  products: { read: "read_products", write: "write_products", confidence: "high" },
  variants: { read: "read_products", write: "write_products", confidence: "high" },
  // Shopify's own scope docs list collections explicitly under this scope pair ("Access to
  // product, variant, collection, and selling plan data") — this is a documented mapping, not
  // a guess, so it earns "high" rather than "inferred".
  collections: { read: "read_products", write: "write_products", confidence: "high" },
  inventory: { read: "read_inventory", write: "write_inventory", confidence: "high" },
  inventory_transfers: {
    read: "read_inventory_transfers",
    write: "write_inventory_transfers",
    confidence: "high",
  },
  customers: { read: "read_customers", write: "write_customers", confidence: "high" },
  customer_segments: { read: "read_customers", write: "write_customers", confidence: "inferred" },
  discounts_promotions: { read: "read_discounts", write: "write_discounts", confidence: "high" },
  orders: { read: "read_orders", write: "write_orders", confidence: "high" },
  refunds: { read: "read_orders", write: "write_orders", confidence: "inferred" },
  returns: { read: "read_returns", write: "write_returns", confidence: "high" },
  draft_orders: { read: "read_draft_orders", write: "write_draft_orders", confidence: "high" },
  order_edits: { read: "read_order_edits", write: "write_order_edits", confidence: "high" },
  content: { read: "read_content", write: "write_content", confidence: "inferred" },
  navigation: {
    read: "read_online_store_navigation",
    write: "write_online_store_navigation",
    confidence: "high",
  },
  markets_international: { read: "read_markets", write: "write_markets", confidence: "high" },
  marketing: { read: "read_marketing_events", write: "write_marketing_events", confidence: "inferred" },
  publishing_channels: { read: "read_publications", write: "write_publications", confidence: "inferred" },
  metaobjects: { read: "read_metaobjects", write: "write_metaobjects", confidence: "high" },
  subscriptions: {
    read: "read_own_subscription_contracts",
    write: "write_own_subscription_contracts",
    confidence: "inferred",
  },
  gift_cards: { read: "read_gift_cards", write: "write_gift_cards", confidence: "high" },
  b2b_company: { read: "read_customers", write: "write_customers", confidence: "inferred" },
  // fulfillment, metafields, app_platform, privacy_compliance, financial_payment, and
  // other_unknown are deliberately absent: each domain spans multiple distinct real Shopify
  // scopes (fulfillment alone has at least four: assigned/merchant-managed/third-party/
  // marketplace fulfillment orders) or has no reliable single scope at all (metafields ride
  // whichever scope owns the parent resource). Per-name sub-rules below cover the ones that
  // can be inferred with reasonable confidence; everything else is scopeConfidence "unknown"
  // by design, which the gateway treats as not-satisfied regardless of requiredScopes being [].
};

// Sub-domain name patterns that need a scope more specific than their domain's default —
// checked before falling back to DOMAIN_SCOPES. Kept small and structural, not per-operation.
/** @type {Array<{ test: RegExp; read?: string; write?: string; confidence: "high" | "inferred" }>} */
const OPERATION_SCOPE_OVERRIDES = [
  {
    test: /assignedfulfillmentorder/i,
    read: "read_assigned_fulfillment_orders",
    write: "write_assigned_fulfillment_orders",
    confidence: "high",
  },
  {
    test: /thirdpartyfulfillmentorder/i,
    read: "read_third_party_fulfillment_orders",
    write: "write_third_party_fulfillment_orders",
    confidence: "high",
  },
  { test: /marketplacefulfillmentorder/i, read: "read_marketplace_fulfillment_orders", confidence: "high" },
  {
    test: /fulfillmentorder|fulfillmentconstraintrule|fulfillmentevent/i,
    read: "read_merchant_managed_fulfillment_orders",
    write: "write_merchant_managed_fulfillment_orders",
    confidence: "inferred",
  },
  { test: /^fulfillment(create|update|cancel)/i, read: "read_fulfillments", write: "write_fulfillments", confidence: "inferred" },
  {
    test: /metaobjectdefinition/i,
    read: "read_metaobject_definitions",
    write: "write_metaobject_definitions",
    confidence: "high",
  },
  { test: /pricerule/i, read: "read_price_rules", write: "write_price_rules", confidence: "high" },
  // The specific mutation Jefe's curated override table targets — metafields in general vary
  // scope by parent resource, but this one's real-world usage (product/variant/collection
  // structured data) is documented against write_products in the 2026-07 capability manifest.
  { test: /^metafieldsSet$/, read: "read_products", write: "write_products", confidence: "high" },
  { test: /paymentterm/i, read: "read_payment_terms", write: "write_payment_terms", confidence: "high" },
];

/**
 * @param {string} operation
 * @param {string} domain
 * @param {"QUERY" | "MUTATION"} operationKind
 * @returns {{ requiredScopes: string[]; scopeConfidence: "high" | "inferred" | "unknown" }}
 */
export function inferShopifyOperationScopes(operation, domain, operationKind) {
  const name = String(operation ?? "");
  const preferred = (/** @type {{ read?: string; write?: string }} */ pair) =>
    operationKind === "QUERY" ? (pair.read ?? pair.write) : (pair.write ?? pair.read);
  for (const rule of OPERATION_SCOPE_OVERRIDES) {
    if (rule.test.test(name)) {
      return scopeResult(preferred(rule), rule.confidence);
    }
  }
  const base = DOMAIN_SCOPES[domain];
  if (!base) return { requiredScopes: [], scopeConfidence: "unknown" };
  return scopeResult(preferred(base), base.confidence);
}

/** @param {string | undefined} scope @param {"high" | "inferred"} confidence */
function scopeResult(scope, confidence) {
  return scope ? { requiredScopes: [scope], scopeConfidence: confidence } : { requiredScopes: [], scopeConfidence: "unknown" };
}
