// @ts-check
//
// A small, hand-authored phrase -> related-term expansion table, generalizing the pattern
// already proven in app/lib/shopify/capabilities/search.server.js's SEMANTIC_QUERY_EXPANSIONS
// to the full ~28-domain taxonomy. This is retrieval recall, not eligibility: it lets
// retrieveShopifyApiOperations() match a phrase-y business question ("what could address
// declining repeat purchase") against the right domain's operations even when the query
// shares no exact keyword with an operation name or description. Keyword expansion, not
// embeddings — consistent with the rest of this codebase's "engineered, not trained" search.

/** @type {Record<string, string[]>} */
export const SHOPIFY_QUERY_EXPANSIONS = Object.freeze({
  shortage: ["inventory", "replenishment", "transfer", "stock"],
  "out of stock": ["inventory", "replenishment", "stock"],
  restock: ["replenishment", "inventory", "transfer", "location"],
  clearance: ["markdown", "price", "variant"],
  markdown: ["price", "discount", "variant"],
  discount: ["promotion", "checkout", "campaign", "code"],
  promotion: ["discount", "campaign"],
  navigation: ["menu", "collection", "redirect"],
  merchandising: ["collection", "catalogue", "taxonomy"],
  margin: ["cost", "price", "inventory item"],
  cost: ["inventory item"],
  "cost of goods": ["cost", "inventory item"],
  shipping: ["fulfillment", "delivery", "carrier"],
  delivery: ["fulfillment", "shipping", "carrier"],
  "repeat purchase": ["customer", "segment", "order"],
  retention: ["customer", "segment", "subscription"],
  loyalty: ["customer", "segment", "giftcard", "storecredit"],
  churn: ["customer", "subscription", "segment"],
  "abandoned cart": ["checkout", "abandoned checkout", "marketing"],
  refund: ["order", "return", "transaction"],
  "return": ["refund", "reverse fulfillment", "exchange"],
  exchange: ["return", "order"],
  "order edit": ["calculatedorder", "lineitem", "discount"],
  wholesale: ["company", "b2b", "pricelist", "quantityrule"],
  b2b: ["company", "pricelist", "quantityrule", "catalog"],
  international: ["market", "currency", "region", "localization"],
  currency: ["market", "region"],
  content: ["page", "blog", "article"],
  storefront: ["page", "menu", "theme", "publication"],
  "publish": ["publication", "channel"],
  subscription: ["sellingplan", "billing", "contract"],
  "gift card": ["giftcard", "storecredit"],
  custom: ["metafield", "metaobject"],
  "structured data": ["metafield", "metaobject", "definition"],
  privacy: ["consent", "erasure", "compliance"],
  compliance: ["privacy", "erasure", "consent"],
  fulfillment: ["order", "shipping", "location", "delivery"],
  fulfil: ["fulfillment", "order", "shipping"], // British spelling — Shopify's own API uses "fulfillment"
  fulfilment: ["fulfillment", "order", "shipping"],
  draft: ["draftorder", "invoice"],
  segmentation: ["segment", "customer"],
  offer: ["discount", "promotion", "code"],
  country: ["market", "region", "currency", "localization"],
  discovery: ["collection", "merchandising", "catalogue", "recommendation"],
  movement: ["transfer", "shipment", "location"],
  "stock movement": ["inventory transfer", "shipment"],
});

/**
 * @param {string} query
 * @returns {Set<string>} additional lowercase, alnum-only terms suggested by any phrase found
 *   in the query — union with the query's own tokens before scoring, never a replacement.
 */
export function expandShopifyQueryTerms(query) {
  const normalized = String(query ?? "").toLowerCase();
  const extra = new Set();
  for (const [phrase, terms] of Object.entries(SHOPIFY_QUERY_EXPANSIONS)) {
    if (normalized.includes(phrase)) {
      for (const term of terms) extra.add(term);
    }
  }
  return extra;
}
