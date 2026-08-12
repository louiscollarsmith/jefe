// @ts-check
//
// The Quiver Redshift schema this tool reads from.
//
// PROVENANCE — every column below was read from Quiver's OWN TypeORM entities:
//   /Users/mb/quiver/etl-task/src/entities/{Order,OrderLineItem,OrderPrice,MerchantOrderStats}.ts
//   /Users/mb/quiver/lambdas/shared/redshift_database.py            (query shapes)
//   /Users/mb/quiver/lambdas/functions/merchant_order_stats_generator/main.py
// and then VERIFIED against the live warehouse via Metabase on 2026-08-12 (database
// id 5, "Redshift"): the column list matches exactly, and one real order was mapped
// end-to-end. Re-verify before trusting this module — Quiver's ETL is a separate
// repo on its own release cadence, so this is a COPY of a contract we do not own. A
// column that quietly changes there shows up here as a wrong number, not an error.
//
// Live shape as of 2026-08-12: 247 merchants / 21.6M orders, first order 2021-01-01,
// current to yesterday. By platform: shopify 239 merchants / 21.19M orders,
// bigcommerce 4 / 420k, magento 4 / 1,574.
//
// Multi-currency is REAL and must not be assumed away: GBP, EUR, USD, AED, AUD, CAD
// all appear, and an order can be entirely non-GBP (the verification order was AED).
//
// Money: Quiver stores every `order_prices.amount` as an INTEGER NUMBER OF PENCE
// (confirmed by `get_merchant_aov` in redshift_database.py, which divides by 100).
// Jefe's canonical commerce records use decimal currency units. `map.mjs` owns
// that conversion; nothing else should divide by 100.

/** Redshift table names, so a typo is a failed import rather than a silent empty result. */
export const QUIVER_TABLES = Object.freeze({
  orders: "orders",
  orderPrices: "order_prices",
  orderLineItems: "order_line_items",
  merchantOrderStats: "merchant_order_stats",
});

/**
 * `order_prices.type` enum — Quiver's `OrderPriceType`.
 * REFUND is an order-level refunded TOTAL, not Shopify's per-refund line detail.
 * There is NO tax type, so Jefe's `Order.totalTax` stays null from this source.
 */
export const QUIVER_PRICE_TYPES = Object.freeze({
  TOTAL: "TOTAL",
  SUBTOTAL: "SUBTOTAL",
  SHIPPING: "SHIPPING",
  DISCOUNT: "DISCOUNT",
  REFUND: "REFUND",
});

/**
 * Columns on `orders` that carry END-CUSTOMER PII.
 *
 * The founder ruled (2026-08-12) that Quiver owns this data and Jefe may use it.
 * This list is therefore NOT a prohibition — it is the explicit inventory of which
 * columns are personal, so a decision to carry them is deliberate and visible
 * rather than accidental. `map.mjs` drops them by default because the harness has
 * no use for them: the belief layer reads order timing, value, channel and SKU
 * velocity, none of which need a customer's name or address. Pass
 * `includePersonalFields: true` to carry them.
 *
 * `email` is the exception — it is HASHED into a stable pseudonymous customer ref
 * (never stored raw), because repeat-customer behaviour is a real signal the
 * belief layer uses and a hash preserves it exactly.
 */
export const QUIVER_ORDER_PERSONAL_COLUMNS = Object.freeze([
  "first_name",
  "last_name",
  "email",
  "phone_number",
  "address",
  "postcode",
  "latitude",
  "longitude",
]);

/**
 * Columns on `orders` that are safe commerce shape — the ones the simulation
 * actually feeds to the model. `city`/`postcode_prefix`/`country` are coarse
 * geography, retained because delivery-geography is a genuine Quiver signal.
 */
export const QUIVER_ORDER_COMMERCE_COLUMNS = Object.freeze([
  "id",
  "merchant_id",
  "merchant_name",
  "platform",
  "order_id",
  "order_name",
  "order_created_at",
  "channel",
  "retail_location_id",
  "city",
  "postcode_prefix",
  "country",
  "company",
  "quiver",
  "shipping_title",
  "shipping_code",
  "tags",
  "payment_gateway_name",
]);

/** Source platforms Quiver ingests from. `shopify` rows are the highest-fidelity simulation. */
export const QUIVER_PLATFORMS = Object.freeze({
  shopify: "shopify",
  bigcommerce: "bigcommerce",
  magento: "magento",
});

/**
 * What Quiver CANNOT tell us, stated once so no caller infers silence means zero.
 *
 * A belief that needs any of these must not be derived from a corpus shop — it
 * would be built on absence, and an insight grounded in absence reads exactly like
 * one grounded in evidence. `map.mjs` marks every corpus shop with these gaps so
 * the limitation travels with the data instead of living only in this comment.
 */
export const QUIVER_COVERAGE_GAPS = Object.freeze([
  "inventory_levels", // no stock on hand → dead-stock beliefs and the clearance action cannot fire
  "product_catalog", // products exist only where they appear on a line item; never-sold SKUs are invisible
  "unit_cost", // no COGS → no true margin, only revenue
  "tax", // order_prices has no TAX type
  "refund_line_detail", // REFUND is an order-level total, not per-line restocking detail
  "customer_lifecycle", // no created-at/marketing-consent per customer, only a per-order pseudonymous ref
]);
