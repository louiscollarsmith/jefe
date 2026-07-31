// @ts-check

// Tool-stack SIGNAL feeder (the Shopify-signal half of "detect the merchant's stack without
// asking"). One cheap Admin GraphQL query gathers the behind-the-scenes signals that
// `detectToolStack()` consumes, and a PURE mapper turns the response into its input shape.
//
// Split on purpose: the pure mapper (`signalsFromShopifyResponse`) is fully testable with
// fixtures; the live query lives in the orchestrator (`tool-stack-detection.server.js`) and is
// dark behind `ENABLE_TOOL_STACK_DETECTION`. The storefront-FINGERPRINT half (Klaviyo, GA/Meta
// pixels, Gorgias — visible tools with little Shopify footprint) is a separate feeder into the
// SAME belief; see docs/integrations-strategy.md.
//
// Only long-stable Admin API fields are used (order.paymentGatewayNames, order.tags,
// customer.tags, metafieldDefinitions.namespace). Fulfillment-service signals are a follow-up
// (the shape carries an empty `fulfillmentServices` so the detector's fulfillment rules simply
// don't fire yet). Detection is INFERENCE — everything downstream carries confidence and is
// merchant-correctable; a signature must be verified against real stores before it's trusted.

/**
 * One shop-level query: recent orders' gateways+tags, recent customers' tags, and the app-owned
 * metafield namespaces across the owner types that tools actually write to. Cheap and bounded.
 */
export const TOOL_STACK_SIGNALS_QUERY = `#graphql
  query ToolStackSignals($orders: Int!, $customers: Int!, $defs: Int!) {
    orders(first: $orders, sortKey: CREATED_AT, reverse: true) {
      nodes { paymentGatewayNames tags }
    }
    customers(first: $customers, sortKey: UPDATED_AT, reverse: true) {
      nodes { tags }
    }
    productDefs: metafieldDefinitions(first: $defs, ownerType: PRODUCT) { nodes { namespace } }
    variantDefs: metafieldDefinitions(first: $defs, ownerType: PRODUCTVARIANT) { nodes { namespace } }
    orderDefs: metafieldDefinitions(first: $defs, ownerType: ORDER) { nodes { namespace } }
    customerDefs: metafieldDefinitions(first: $defs, ownerType: CUSTOMER) { nodes { namespace } }
    shopDefs: metafieldDefinitions(first: $defs, ownerType: SHOP) { nodes { namespace } }
  }
`;

/** Bounded page sizes — a sample is plenty to spot a tool's footprint. */
export const TOOL_STACK_SIGNAL_LIMITS = { orders: 50, customers: 50, defs: 100 };

/** @param {(string|null|undefined)[]|undefined} xs */
const uniqLower = (xs) => [
  ...new Set((xs ?? []).map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean)),
];
/** @param {(string|null|undefined)[]|undefined} xs */
const uniq = (xs) => [
  ...new Set((xs ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)),
];

/**
 * Pure: map a `ToolStackSignals` GraphQL response into `detectToolStack()`'s signals input.
 * Defensive against missing/partial data — any field may be absent (a fresh store, a partial
 * page, a null node). Gateways + namespaces are lower-cased (the detector matches lower-cased);
 * tags keep their original case (patterns are case-insensitive).
 *
 * @param {any} data - the `data` object from the GraphQL response (accepts the raw response too)
 * @returns {{ metafieldNamespaces: string[], gateways: string[], orderTags: string[], customerTags: string[], fulfillmentServices: string[] }}
 */
export function signalsFromShopifyResponse(data) {
  const d = data?.data ?? data ?? {};
  const orderNodes = Array.isArray(d.orders?.nodes) ? d.orders.nodes : [];
  const customerNodes = Array.isArray(d.customers?.nodes) ? d.customers.nodes : [];

  const gateways = uniqLower(orderNodes.flatMap((/** @type {any} */ o) => o?.paymentGatewayNames ?? []));
  const orderTags = uniq(orderNodes.flatMap((/** @type {any} */ o) => o?.tags ?? []));
  const customerTags = uniq(customerNodes.flatMap((/** @type {any} */ c) => c?.tags ?? []));

  const nsNodes = [
    ...(d.productDefs?.nodes ?? []),
    ...(d.variantDefs?.nodes ?? []),
    ...(d.orderDefs?.nodes ?? []),
    ...(d.customerDefs?.nodes ?? []),
    ...(d.shopDefs?.nodes ?? []),
  ];
  const metafieldNamespaces = uniqLower(nsNodes.map((/** @type {any} */ n) => n?.namespace));

  return { metafieldNamespaces, gateways, orderTags, customerTags, fulfillmentServices: [] };
}
