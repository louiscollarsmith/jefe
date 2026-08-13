// @ts-check

export const SHOPIFY_INTELLIGENCE_COVERAGE_VERSION = "shopify_intelligence_coverage_v1";

export const ACCESS_STRATEGY = Object.freeze({
  mirror: "MIRROR",
  onDemand: "ON_DEMAND",
  ignore: "IGNORE",
});

export const AVAILABILITY_STATE = Object.freeze({
  known: "KNOWN",
  unknown: "UNKNOWN",
  notIngested: "NOT_INGESTED",
  insufficientEvidence: "INSUFFICIENT_EVIDENCE",
  unavailable: "UNAVAILABLE",
});

export const USE_CASE = Object.freeze({
  belief: "BELIEF",
  recommendation: "RECOMMENDATION",
  investigation: "INVESTIGATION",
  outcomeMeasurement: "OUTCOME_MEASUREMENT",
});

const P0 = "P0";
const P1 = "P1";
const MIRROR = ACCESS_STRATEGY.mirror;
const ON_DEMAND = ACCESS_STRATEGY.onDemand;
const IGNORE = ACCESS_STRATEGY.ignore;
const KNOWN = AVAILABILITY_STATE.known;
const UNKNOWN = AVAILABILITY_STATE.unknown;
const NOT_INGESTED = AVAILABILITY_STATE.notIngested;
const INSUFFICIENT = AVAILABILITY_STATE.insufficientEvidence;
const UNAVAILABLE = AVAILABILITY_STATE.unavailable;
const BELIEF = USE_CASE.belief;
const RECOMMENDATION = USE_CASE.recommendation;
const INVESTIGATION = USE_CASE.investigation;
const OUTCOME = USE_CASE.outcomeMeasurement;

/**
 * Shopify evidence requirements are deliberately Jefe-shaped. The denominator is
 * the evidence Jefe's current intelligence needs, not Shopify's total schema.
 */
export const SHOPIFY_INTELLIGENCE_REQUIREMENTS = Object.freeze([
  req("orders.core_totals", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Order totals, currency, dates and status used by revenue, AOV and action-outcome reads."),
  req("orders.line_items", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Product/variant-level sold units and realized line revenue."),
  req("orders.financial_state", P0, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION, OUTCOME], "Paid/cancelled/refunded state so non-commerce orders do not become evidence."),
  req("orders.fulfilment_state", P0, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION, OUTCOME], "Core fulfilment state and current fulfilment status."),
  req("orders.discount_amount", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "How much revenue is given away in discounts."),
  req("orders.discount_identity", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Codes/titles behind discounts; older orders may need re-backfill for full coverage."),
  req("orders.discount_allocation", P0, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION, OUTCOME], "Line-level discount allocation for product and margin impact."),
  req("orders.source_name", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Sales-channel/source proxy available on canonical orders."),
  req("orders.acquisition_journey", P0, MIRROR, NOT_INGESTED, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "First/last touch source, UTM and landing path.", "Protected customer-data approval and ORDER_ATTRIBUTION_INGEST_ENABLED are required before this is requested."),
  req("orders.shipping_region", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION], "Country/region footprint for demand and margin/geography reads."),
  req("returns.refund_amounts", P0, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION, OUTCOME], "Refund value and timing."),
  req("returns.refund_line_items", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Returned units mapped back to products where Shopify supplies line items."),
  req("returns.reasons", P0, ON_DEMAND, UNKNOWN, false, [INVESTIGATION, OUTCOME], "Return reason/detail when a returns investigation needs context."),
  req("customers.identity_hash", P0, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION], "Hash-only customer identity for repeat/customer-cohort aggregates."),
  req("customers.order_counts", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "First/returning/loyal split and customer purchase rhythm."),
  req("customers.spend", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Customer aggregate value without exposing customer PII."),
  req("customers.native_segments", P0, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Shopify native segments for cohort/action exploration.", "No V1 write path; read availability depends on granted/approved customer access."),
  req("customers.product_relationships", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION], "Which products customers bought, from line items joined to hash-only identities."),
  req("products.core_catalog", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Product title, handle, status, vendor and type."),
  req("products.variant_pricing", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Current variant price and SKU."),
  req("products.unit_cost", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Cost-per-item where Shopify exposes it; coverage may be incomplete."),
  req("products.inventory_levels", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Available, committed and incoming stock by location."),
  req("products.collections", P0, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Merchant's own catalogue grouping and language."),
  req("products.tags", P0, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Merchant-authored product grouping useful for metadata and promotion decisions."),
  req("products.metafields", P0, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Richer product metadata without mirroring arbitrary metafields."),
  req("products.publication_state", P0, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION, OUTCOME], "Where a product is actually published or hidden."),
  req("sales.channel_definitions", P0, ON_DEMAND, UNKNOWN, false, [BELIEF, RECOMMENDATION, INVESTIGATION, OUTCOME], "Shopify channel/publication context beyond sourceName regex."),
  req("store.identity", P0, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION], "Store name, domain and merchant tenant identity."),
  req("store.timezone", P0, MIRROR, KNOWN, true, [BELIEF, RECOMMENDATION, OUTCOME], "Local calendar interpretation for daily/weekly comparisons."),
  req("store.scopes", P0, MIRROR, KNOWN, true, [INVESTIGATION], "Granted scopes so tools can explain missing access."),
  req("actions.execution_ledger", P0, MIRROR, KNOWN, true, [RECOMMENDATION, INVESTIGATION, OUTCOME], "Jefe action previews, writes and measured outcomes."),
  req("marketing.ad_spend", P0, IGNORE, UNAVAILABLE, true, [RECOMMENDATION, INVESTIGATION, OUTCOME], "Ad platform spend is not in Shopify; needs ad connector, not Shopify.", "Unavailable from Shopify Admin evidence."),

  req("orders.taxes_shipping", P1, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION, OUTCOME], "Tax and shipping totals for more precise net economics."),
  req("orders.payment_gateway", P1, ON_DEMAND, UNKNOWN, false, [INVESTIGATION], "Gateway/tender context when payment mix matters."),
  req("orders.abandoned_checkout", P1, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION, OUTCOME], "Abandonment investigation without default mirror growth."),
  req("customers.lifetime_duration", P1, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Shopify-computed lifetime/customer statistics."),
  req("customers.locations", P1, IGNORE, UNAVAILABLE, false, [INVESTIGATION], "Individual customer address detail is not needed for V1 aggregate memory.", "Avoid customer PII unless a future approved use case needs it."),
  req("products.options", P1, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Variant option names/values for merchandising context."),
  req("products.media", P1, ON_DEMAND, UNKNOWN, false, [RECOMMENDATION, INVESTIGATION], "Product media quality/context when listing work needs it."),
  req("inventory.location_names", P1, MIRROR, KNOWN, true, [BELIEF, INVESTIGATION], "Location-level inventory context."),
  req("fulfilment.tracking_detail", P1, IGNORE, UNAVAILABLE, false, [INVESTIGATION], "Carrier tracking numbers are operational PII/noise for V1 memory.", "Do not expose shipment tracking details to LLM tools."),
  req("finance.payouts", P1, IGNORE, UNAVAILABLE, true, [OUTCOME], "Payout and settlement fees are useful later but outside current Shopify intelligence.", "Requires a finance-focused connector/design."),
]);

export const REPRESENTATIVE_INVESTIGATIONS = Object.freeze([
  investigation("revenue_decline", "Why did revenue fall last month?", ["orders.core_totals", "orders.line_items", "orders.discount_amount", "orders.discount_identity", "orders.source_name", "orders.acquisition_journey", "returns.refund_amounts", "products.core_catalog"], ["shopify_analyse_sales_mix", "shopify_analyse_product_performance", "shopify_analyse_discount_usage", "shopify_analyse_acquisition_quality", "shopify_analyse_returns"]),
  investigation("repeat_purchase_drivers", "Which products are driving repeat purchasing?", ["customers.identity_hash", "customers.order_counts", "customers.product_relationships", "products.core_catalog", "orders.line_items"], ["shopify_analyse_customer_retention", "shopify_analyse_product_performance"]),
  investigation("discount_incrementality", "Are discounts creating incremental demand or subsidising existing customers?", ["orders.discount_amount", "orders.discount_identity", "customers.order_counts", "customers.product_relationships", "orders.acquisition_journey"], ["shopify_analyse_discount_usage", "shopify_analyse_customer_retention", "shopify_analyse_acquisition_quality"]),
  investigation("acquisition_quality", "Which acquisition channels produce the highest-quality customers?", ["orders.acquisition_journey", "customers.order_counts", "customers.spend", "returns.refund_amounts"], ["shopify_analyse_acquisition_quality", "shopify_analyse_customer_retention"]),
  investigation("return_increase", "What is causing the increase in returns?", ["returns.refund_amounts", "returns.refund_line_items", "returns.reasons", "orders.line_items", "products.core_catalog"], ["shopify_analyse_returns", "shopify_get_order_context"]),
  investigation("promotion_candidates", "Which products should the merchant promote?", ["products.core_catalog", "products.variant_pricing", "products.unit_cost", "products.inventory_levels", "orders.line_items", "returns.refund_line_items", "products.collections", "products.tags"], ["shopify_analyse_product_performance", "shopify_get_product_metadata"]),
  investigation("stock_risk", "Which stock is becoming risky?", ["products.inventory_levels", "orders.line_items", "products.unit_cost", "products.variant_pricing"], ["shopify_analyse_product_performance"]),
  investigation("action_outcome", "Is a recommendation we made three weeks ago working?", ["actions.execution_ledger", "orders.core_totals", "orders.line_items", "returns.refund_amounts", "products.inventory_levels"], ["shopify_analyse_action_outcome", "shopify_analyse_sales_mix"]),
]);

export const SHOPIFY_BELIEF_EVIDENCE_REQUIREMENTS = Object.freeze({
  "business.primary_currency": ["orders.core_totals", "products.variant_pricing", "returns.refund_amounts"],
  "business.store_name": ["store.identity"],
  "business.acquisition_mix.trailing_90d": ["orders.acquisition_journey"],
  "business.discount_depth.trailing_90d": ["orders.discount_amount", "orders.core_totals"],
  "business.discount_code_mix.trailing_90d": ["orders.discount_identity", "orders.discount_amount"],
  "customers.repeat_customer_rate.all_time": ["customers.identity_hash", "customers.order_counts"],
  "customers.customer_cohort_mix.all_time": ["customers.identity_hash", "customers.order_counts", "customers.spend"],
  "products.top_returned_products.trailing_180d": ["returns.refund_line_items", "orders.line_items", "products.core_catalog"],
  "products.product_momentum.trailing_60d": ["orders.line_items", "products.core_catalog"],
  "products.cost_coverage": ["products.unit_cost", "products.variant_pricing"],
  "products.gross_margin.trailing_90d": ["products.unit_cost", "orders.line_items", "products.variant_pricing"],
  "inventory.low_cover_products.trailing_30d": ["products.inventory_levels", "orders.line_items"],
  "inventory.at_risk_stockout_count.trailing_30d": ["products.inventory_levels", "orders.line_items"],
  "business.channel_mix.trailing_90d": ["orders.source_name", "sales.channel_definitions"],
});

/** @param {string} id @param {string} priority @param {string} accessStrategy @param {string} availabilityState @param {boolean} historicalTruthRequired @param {string[]} useCases @param {string} description @param {string | null} [blockingReason] */
function req(id, priority, accessStrategy, availabilityState, historicalTruthRequired, useCases, description, blockingReason = null) {
  return Object.freeze({
    id,
    priority,
    accessStrategy,
    availabilityState,
    historicalTruthRequired,
    useCases,
    description,
    blockingReason,
  });
}

/** @param {string} id @param {string} question @param {string[]} requiredEvidence @param {string[]} candidateTools */
function investigation(id, question, requiredEvidence, candidateTools) {
  return Object.freeze({ id, question, requiredEvidence, candidateTools });
}

export function listShopifyIntelligenceRequirements() {
  return [...SHOPIFY_INTELLIGENCE_REQUIREMENTS];
}

export function listRepresentativeInvestigations() {
  return [...REPRESENTATIVE_INVESTIGATIONS];
}

/** @param {string} id */
export function getShopifyEvidenceRequirement(id) {
  return SHOPIFY_INTELLIGENCE_REQUIREMENTS.find((item) => item.id === id) ?? null;
}

/** @param {string} priority */
export function buildShopifyIntelligenceCoverageReport(priority = P0) {
  const requirements = SHOPIFY_INTELLIGENCE_REQUIREMENTS.filter(
    (item) => item.priority === priority && item.accessStrategy !== IGNORE,
  );
  const accessible = requirements.filter(isAccessible);
  const byStrategy = countBy(requirements, (item) => item.accessStrategy);
  const byAvailability = countBy(requirements, (item) => item.availabilityState);
  return {
    version: SHOPIFY_INTELLIGENCE_COVERAGE_VERSION,
    priority,
    requiredEvidenceCount: requirements.length,
    accessibleViaMirror: requirements.filter((item) => item.accessStrategy === MIRROR && isAccessible(item)).length,
    accessibleViaOnDemand: requirements.filter((item) => item.accessStrategy === ON_DEMAND && isAccessible(item)).length,
    unavailableOrBlocked: requirements.length - accessible.length,
    effectiveCoveragePercent: requirements.length
      ? Math.round((accessible.length / requirements.length) * 1000) / 10
      : 100,
    byStrategy,
    byAvailability,
    remainingGaps: requirements
      .filter((item) => !isAccessible(item))
      .map((item) => ({
        id: item.id,
        availabilityState: item.availabilityState,
        blockingReason: item.blockingReason ?? item.description,
      })),
  };
}

/** @param {string} key @param {{ dependencies?: string[]; category?: string }} [definition] */
export function evidenceRequirementsForBelief(key, definition = {}) {
  const explicit = /** @type {Record<string, string[]>} */ (SHOPIFY_BELIEF_EVIDENCE_REQUIREMENTS)[key];
  if (explicit) return [...explicit];
  const dependencies = new Set(definition.dependencies ?? []);
  /** @type {string[]} */
  const evidence = [];
  if (dependencies.has("orders")) evidence.push("orders.core_totals");
  if (dependencies.has("line_items")) evidence.push("orders.line_items");
  if (dependencies.has("products")) evidence.push("products.core_catalog");
  if (dependencies.has("variants")) evidence.push("products.variant_pricing");
  if (dependencies.has("inventory_levels")) evidence.push("products.inventory_levels");
  if (dependencies.has("refunds")) evidence.push("returns.refund_amounts");
  if (dependencies.has("customer_identities")) evidence.push("customers.identity_hash", "customers.order_counts");
  return [...new Set(evidence)];
}

export function shopifyIntelligenceAvailabilityLegend() {
  return {
    [KNOWN]: "Jefe has access to this evidence for the relevant scope.",
    [UNKNOWN]: "Jefe can ask for this evidence, but the result may be empty or shop-dependent.",
    [NOT_INGESTED]: "Jefe has not asked for or mirrored this evidence yet; absence is not a negative fact.",
    [INSUFFICIENT]: "Some evidence exists, but coverage/sample is too thin for a confident conclusion.",
    [UNAVAILABLE]: "This evidence cannot be obtained from Shopify in V1, or is intentionally excluded.",
  };
}

export function getShopifyIntelligenceCoverageHealth() {
  return {
    status: "ok",
    version: SHOPIFY_INTELLIGENCE_COVERAGE_VERSION,
    requirementCount: SHOPIFY_INTELLIGENCE_REQUIREMENTS.length,
    p0: buildShopifyIntelligenceCoverageReport(P0),
    p1: buildShopifyIntelligenceCoverageReport(P1),
  };
}

/** @param {any} requirement */
function isAccessible(requirement) {
  return requirement.availabilityState === KNOWN || requirement.availabilityState === UNKNOWN;
}

/** @param {any[]} rows @param {(row: any) => string} keyFor */
function countBy(rows, keyFor) {
  return rows.reduce((acc, row) => {
    const key = keyFor(row);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
}
