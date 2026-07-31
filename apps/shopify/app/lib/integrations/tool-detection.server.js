// @ts-check

// Tool-stack detection — recognize the third-party tools a merchant runs WITHOUT them
// telling us, from Shopify signals we already ingest. Pure + deterministic; the derivation
// that gathers the live signals and writes the `business.tool_stack` Merchant Memory belief
// wraps this (next step — this module is unwired, nothing calls it yet).
//
// This is the Shopify-SIGNAL half (behind-the-scenes tools: subscriptions, reviews,
// fulfillment, loyalty, payments). The storefront-FINGERPRINT half (visible tools: email,
// analytics, support, pixels — detected via a bought fingerprint API off the public site)
// is a separate feeder into the SAME belief. See docs/integrations-strategy.md.
//
// The registry is a SEED — mappings are the well-known ones, but each must be verified
// against real stores before it's trusted (a wrong signature = a false detection, worse than
// a miss). Curated + extensible, never generated — same discipline as the action capability
// registry (context/13). Detection is INFERENCE: everything downstream carries confidence and
// is merchant-correctable (the standard memory provenance ladder), never asserted as fact.

/**
 * @typedef {"subscriptions"|"reviews"|"loyalty"|"fulfillment"|"payments"|"support"|"email_marketing"|"upsell"|"other"} ToolCategory
 * @typedef {Object} ToolSignature
 * @property {string} id
 * @property {string} name
 * @property {ToolCategory} category
 * @property {string[]} [metafieldNamespaces]  // app-owned metafield namespaces (exact, lower-cased)
 * @property {string[]} [fulfillmentServices]  // fulfillment service handle/name substrings
 * @property {string[]} [gateways]             // transaction gateway name substrings
 * @property {RegExp[]}  [orderTagPatterns]    // order-tag patterns
 * @property {RegExp[]}  [customerTagPatterns] // customer-tag patterns
 */

/** @type {ToolSignature[]} — SEED. Verify each signature against real stores at build. */
export const TOOL_SIGNATURES = [
  { id: "recharge", name: "Recharge", category: "subscriptions", metafieldNamespaces: ["subscriptions", "recharge"], orderTagPatterns: [/(^|\b)subscription/i, /recharge/i] },
  { id: "bold_subscriptions", name: "Bold Subscriptions", category: "subscriptions", metafieldNamespaces: ["bold"], orderTagPatterns: [/bold[_-]?subscription/i] },
  { id: "judgeme", name: "Judge.me", category: "reviews", metafieldNamespaces: ["judgeme"] },
  { id: "loox", name: "Loox", category: "reviews", metafieldNamespaces: ["loox"] },
  { id: "yotpo", name: "Yotpo", category: "reviews", metafieldNamespaces: ["yotpo"] },
  { id: "okendo", name: "Okendo", category: "reviews", metafieldNamespaces: ["okendo"] },
  { id: "stamped", name: "Stamped", category: "reviews", metafieldNamespaces: ["stamped"] },
  { id: "smile", name: "Smile.io", category: "loyalty", metafieldNamespaces: ["smile"] },
  { id: "shipstation", name: "ShipStation", category: "fulfillment", fulfillmentServices: ["shipstation"] },
  { id: "shipbob", name: "ShipBob", category: "fulfillment", fulfillmentServices: ["shipbob"] },
  { id: "amazon_mcf", name: "Amazon MCF", category: "fulfillment", fulfillmentServices: ["amazon"] },
  { id: "paypal", name: "PayPal", category: "payments", gateways: ["paypal"] },
  { id: "afterpay", name: "Afterpay/Clearpay", category: "payments", gateways: ["afterpay", "clearpay"] },
  { id: "klarna", name: "Klarna", category: "payments", gateways: ["klarna"] },
  // --- phase-2 seed additions (2026-07-31): distinctive namespaces / gateway ids / fulfillment
  // handles, chosen to avoid generic-substring false positives. Still SEED — verify each against
  // a real store before the belief is trusted (same discipline as the entries above).
  { id: "skio", name: "Skio", category: "subscriptions", metafieldNamespaces: ["skio"] },
  { id: "appstle", name: "Appstle Subscriptions", category: "subscriptions", metafieldNamespaces: ["appstle"] },
  { id: "fera", name: "Fera", category: "reviews", metafieldNamespaces: ["fera"] },
  { id: "junip", name: "Junip", category: "reviews", metafieldNamespaces: ["junip"] },
  { id: "loyaltylion", name: "LoyaltyLion", category: "loyalty", metafieldNamespaces: ["loyaltylion"] },
  { id: "shiphero", name: "ShipHero", category: "fulfillment", fulfillmentServices: ["shiphero"] },
  { id: "deliverr", name: "Deliverr (Flexport)", category: "fulfillment", fulfillmentServices: ["deliverr"] },
  { id: "sezzle", name: "Sezzle", category: "payments", gateways: ["sezzle"] },
  { id: "affirm", name: "Affirm", category: "payments", gateways: ["affirm"] },
  // NOTE: email/analytics/support tools (Klaviyo, GA/Meta pixels, Gorgias) are detected by the
  // storefront-fingerprint feeder, not here — they leave little Shopify-signal footprint.
];

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

const toLowerList = (/** @type {string[]|undefined} */ xs) => (xs ?? []).map((s) => String(s).toLowerCase());

/**
 * Detect the merchant's tool stack from observed Shopify signals. Pure — no I/O.
 * Confidence reflects signal strength: an app-owned metafield namespace or a named
 * fulfillment service is a strong tell; a tag pattern is weaker (merchants also tag by hand).
 * @param {{ metafieldNamespaces?: string[], fulfillmentServices?: string[], gateways?: string[], orderTags?: string[], customerTags?: string[] }} [signals]
 * @param {ToolSignature[]} [registry]
 * @returns {Array<{ id: string, name: string, category: ToolCategory, matchedBy: string[], confidence: number }>}
 */
export function detectToolStack(signals = {}, registry = TOOL_SIGNATURES) {
  const ns = new Set(toLowerList(signals.metafieldNamespaces));
  const fulfil = toLowerList(signals.fulfillmentServices);
  const gw = toLowerList(signals.gateways);
  const orderTags = signals.orderTags ?? [];
  const customerTags = signals.customerTags ?? [];

  const detected = [];
  for (const sig of registry) {
    const matchedBy = [];
    let confidence = 0;
    for (const n of sig.metafieldNamespaces ?? []) {
      if (ns.has(n.toLowerCase())) { matchedBy.push(`metafield:${n}`); confidence = Math.max(confidence, 0.9); }
    }
    for (const f of sig.fulfillmentServices ?? []) {
      if (fulfil.some((x) => x.includes(f.toLowerCase()))) { matchedBy.push(`fulfillment:${f}`); confidence = Math.max(confidence, 0.95); }
    }
    for (const g of sig.gateways ?? []) {
      if (gw.some((x) => x.includes(g.toLowerCase()))) { matchedBy.push(`gateway:${g}`); confidence = Math.max(confidence, 0.9); }
    }
    for (const p of sig.orderTagPatterns ?? []) {
      if (orderTags.some((t) => p.test(String(t)))) { matchedBy.push(`orderTag:${p.source}`); confidence = Math.max(confidence, 0.6); }
    }
    for (const p of sig.customerTagPatterns ?? []) {
      if (customerTags.some((t) => p.test(String(t)))) { matchedBy.push(`customerTag:${p.source}`); confidence = Math.max(confidence, 0.6); }
    }
    if (matchedBy.length) {
      detected.push({ id: sig.id, name: sig.name, category: sig.category, matchedBy, confidence: round2(confidence) });
    }
  }
  return detected.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}
