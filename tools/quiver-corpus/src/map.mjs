// @ts-check
//
// Quiver Redshift rows -> Jefe canonical commerce records.
//
// This is the ONLY place the two schemas meet. Everything downstream of the
// canonical records — deterministic beliefs, evidence, insights, goals, plan,
// action chat — runs unchanged, which is the whole point: the simulation exercises
// the REAL pipeline, not a parallel one.
//
// Pure functions, no I/O, no database. That keeps the mapping testable without
// Redshift access, which is what let it be built before credentials existed.

import { createHash } from "node:crypto";
import {
  QUIVER_COVERAGE_GAPS,
  QUIVER_PRICE_TYPES,
} from "./quiver-schema.mjs";

/** Marks a corpus shop as structurally NOT a Shopify tenant. See safety.mjs. */
export const CORPUS_PLATFORM = "quiver_sim";

/**
 * Quiver's `orders.customer_journey` is `JSON.stringify(<entire platform order>)` —
 * an unbounded nested blob that re-contains the shipping address, email and phone.
 * It is never carried: no belief reads it, it would bloat every `raw_payload`, and
 * it would smuggle personal fields back in behind whatever the caller chose for
 * `includePersonalFields`. Excluded unconditionally, on purpose.
 */
export const NEVER_CARRIED_COLUMNS = Object.freeze(["customer_journey"]);

/**
 * Stable pseudonymous customer reference.
 *
 * Matches the app's existing PII posture (`CustomerIdentity.emailHash`) rather than
 * inventing one. Repeat-purchase behaviour survives the hash exactly — the same
 * customer hashes to the same ref — while the address book does not travel.
 * @param {string | null | undefined} email
 * @param {string} salt Per-corpus salt so refs cannot be rainbow-tabled back to emails.
 * @returns {string | null}
 */
export function hashCustomerRef(email, salt) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return createHash("sha256").update(`${salt}:${normalized}`).digest("hex").slice(0, 32);
}

/**
 * Convert Quiver pence (bigint-as-string) to a decimal currency-unit string.
 *
 * Integer/BigInt math throughout — a float divide by 100 loses exactness on large
 * revenue sums, and these numbers end up in merchant-facing beliefs where a penny
 * of drift reads as a wrong number rather than a rounding artefact.
 * @param {string | number | bigint | null | undefined} pence
 * @returns {string | null} e.g. "1234.56", or null when absent
 */
export function penceToAmount(pence) {
  if (pence === null || pence === undefined || pence === "") return null;
  let value;
  try {
    value = BigInt(typeof pence === "number" ? Math.trunc(pence) : pence);
  } catch {
    return null;
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const units = absolute / 100n;
  const remainder = absolute % 100n;
  return `${negative ? "-" : ""}${units}.${String(remainder).padStart(2, "0")}`;
}

/**
 * Deterministic external id for a Quiver order.
 *
 * NOT `orders.id` — that is a `uuidv4()` minted at ETL time, so it changes every
 * time Quiver re-runs its import and would make re-imports create duplicate orders
 * instead of updating them. `orders.order_id` is the source platform's own id and
 * is stable; platform-qualifying it keeps two platforms' id spaces from colliding.
 * @param {{ platform?: string | null, order_id?: string | null }} row
 * @returns {string}
 */
export function orderExternalId(row) {
  const platform = String(row?.platform ?? "unknown").trim().toLowerCase();
  const orderId = String(row?.order_id ?? "").trim();
  return `${platform}:${orderId}`;
}

/**
 * Deterministic external id for a line item.
 *
 * Quiver mints `order_line_items.id` as a per-run uuid too, so it cannot key an
 * idempotent import. Composing (order, position, sku|name) is stable for a given
 * Quiver snapshot and keeps the `@@unique([orderId, externalId])` constraint honest.
 * Position is included because one order legitimately carries the same SKU twice.
 * @param {string} orderKey
 * @param {{ sku?: string | null, name?: string | null }} line
 * @param {number} index
 */
export function lineItemExternalId(orderKey, line, index) {
  const discriminator = String(line?.sku || line?.name || "unknown").trim().toLowerCase();
  return `${orderKey}#${index}:${discriminator}`;
}

/**
 * Pick the currency to read an order's prices in.
 *
 * An order can carry rows in more than one currency. Rather than summing across
 * them (which would invent a number that is not money in any currency), pick ONE
 * and read only its rows. Preference order is deterministic so the same input
 * always yields the same output: the preferred currency, then the one with the
 * most rows, then alphabetical.
 * @param {Array<{ currency_code?: string | null }>} prices
 * @param {string} preferred
 * @returns {string}
 */
export function selectCurrency(prices, preferred = "GBP") {
  const counts = new Map();
  for (const price of prices ?? []) {
    const code = String(price?.currency_code ?? "").trim().toUpperCase();
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (counts.size === 0) return preferred;
  if (counts.has(preferred)) return preferred;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * Reduce an order's price rows to the canonical money fields.
 * @param {Array<{ type?: string | null, currency_code?: string | null, amount?: string | null }>} prices
 * @param {string} currency
 */
function reducePrices(prices, currency) {
  /** @type {Record<string, string | null>} */
  const byType = {};
  for (const price of prices ?? []) {
    const code = String(price?.currency_code ?? "").trim().toUpperCase();
    if (code && code !== currency) continue;
    const type = String(price?.type ?? "").trim().toUpperCase();
    if (!type) continue;
    // Last write wins is wrong if a type repeats; sum instead, which is the only
    // reading that stays correct when Quiver splits a type across rows.
    const existing = byType[type];
    byType[type] = existing === null || existing === undefined
      ? penceToAmount(price?.amount)
      : addAmounts(existing, penceToAmount(price?.amount));
  }
  return byType;
}

/**
 * Add two decimal-string amounts without going through float.
 * @param {string | null} a
 * @param {string | null} b
 * @returns {string | null}
 */
function addAmounts(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const toPence = (/** @type {string} */ value) => {
    const negative = value.startsWith("-");
    const [units, fraction = "0"] = (negative ? value.slice(1) : value).split(".");
    const pence = BigInt(units) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
    return negative ? -pence : pence;
  };
  return penceToAmount(toPence(a) + toPence(b));
}

/**
 * Amount (in currency units) above which a single order component is treated as
 * implausible rather than merely large.
 *
 * Measured against live Redshift on 2026-08-12, over 4,880,522 GBP orders in the
 * trailing 12 months: only 15 orders carry a subtotal above £100k (plausible B2B),
 * but 3 carry a DISCOUNT above £100k — the largest £212,755,177. £1m is set above
 * the real B2B tail and below the garbage.
 */
export const IMPLAUSIBLE_AMOUNT = 1_000_000;

/**
 * Flag orders whose money does not make sense, WITHOUT dropping them here.
 *
 * Measured on the same 4.88M orders: **43,873 (0.9%) have a DISCOUNT greater than
 * their SUBTOTAL.** Small enough to ignore per-order, far too large to ignore in an
 * aggregate — a 0.9% tail of nonsense discounts skews any "average discount rate"
 * belief, and the three £100m+ rows would wreck a mean outright.
 *
 * Flagging rather than silently dropping is the point: "Jefe ignored 0.9% of your
 * orders" is a fact a reviewer needs to see, and a filter that quietly removes rows
 * makes a corpus look cleaner than the merchant's real data actually is.
 *
 * @param {Record<string, string | null>} money Canonical amounts, from reducePrices.
 * @returns {string[]} Anomaly codes, empty when the order looks sane.
 */
export function orderAnomalies(money) {
  const anomalies = [];
  const subtotal = toNumber(money?.[QUIVER_PRICE_TYPES.SUBTOTAL]);
  const total = toNumber(money?.[QUIVER_PRICE_TYPES.TOTAL]);
  const discount = toNumber(money?.[QUIVER_PRICE_TYPES.DISCOUNT]);

  if (subtotal !== null && subtotal < 0) anomalies.push("subtotal_negative");
  if (subtotal !== null && discount !== null && subtotal > 0 && discount > subtotal) {
    anomalies.push("discount_exceeds_subtotal");
  }
  for (const [type, value] of [
    [QUIVER_PRICE_TYPES.SUBTOTAL, subtotal],
    [QUIVER_PRICE_TYPES.TOTAL, total],
    [QUIVER_PRICE_TYPES.DISCOUNT, discount],
  ]) {
    if (value !== null && Math.abs(value) > IMPLAUSIBLE_AMOUNT) {
      anomalies.push(`implausible_${String(type).toLowerCase()}`);
    }
  }
  if (subtotal === null && total === null) anomalies.push("no_order_value");

  return anomalies;
}

/** @param {string | null | undefined} amount */
function toNumber(amount) {
  if (amount === null || amount === undefined) return null;
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Map one Quiver order (plus its price and line rows) to canonical Jefe records.
 *
 * @param {{
 *   order: Record<string, any>,
 *   prices?: Array<Record<string, any>>,
 *   lineItems?: Array<Record<string, any>>,
 * }} source
 * @param {{
 *   merchantId: string,
 *   shopId: string,
 *   customerSalt: string,
 *   includePersonalFields?: boolean,
 *   preferredCurrency?: string,
 * }} context
 */
export function mapQuiverOrder(source, context) {
  const row = source?.order ?? {};
  const prices = source?.prices ?? [];
  const lines = source?.lineItems ?? [];
  const {
    merchantId,
    shopId,
    customerSalt,
    includePersonalFields = false,
    preferredCurrency = "GBP",
  } = context;

  const externalId = orderExternalId(row);
  const currency = selectCurrency(prices, preferredCurrency);
  const money = reducePrices(prices, currency);
  const placedAt = toDate(row.order_created_at);
  const anomalies = orderAnomalies(money);

  const order = {
    merchantId,
    shopId,
    externalId,
    orderName: nullableString(row.order_name),
    customerExternalId: hashCustomerRef(row.email, customerSalt),
    // Quiver carries no payment or fulfilment state. Left null rather than inferred:
    // a guessed "paid" would enter the belief layer indistinguishable from an
    // observed one, which is exactly the failure the provenance rules exist to stop.
    financialStatus: null,
    fulfillmentStatus: null,
    sourceName: nullableString(row.channel),
    shippingCountry: nullableString(row.country),
    currency,
    subtotalPrice: money[QUIVER_PRICE_TYPES.SUBTOTAL] ?? null,
    totalPrice: money[QUIVER_PRICE_TYPES.TOTAL] ?? null,
    totalDiscount: money[QUIVER_PRICE_TYPES.DISCOUNT] ?? null,
    totalTax: null, // Quiver has no TAX price type — see QUIVER_COVERAGE_GAPS.
    totalShipping: money[QUIVER_PRICE_TYPES.SHIPPING] ?? null,
    sourceCreatedAt: placedAt,
    sourceUpdatedAt: toDate(row.updated_at),
    processedAt: placedAt,
    rawPayload: {
      ...buildRawPayload(row, { includePersonalFields }),
      // Travels with the row so the loader can quarantine it and a reviewer can see
      // what was excluded, rather than the corpus silently looking cleaner than the
      // merchant's real data.
      dataQualityAnomalies: anomalies,
    },
  };

  const lineItems = lines.map((line, index) => ({
    merchantId,
    shopId,
    externalId: lineItemExternalId(externalId, line, index),
    sku: nullableString(line.sku),
    title: nullableString(line.name),
    quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : 0,
    // Quiver line items carry NO price. Allocating the order subtotal across lines
    // would fabricate per-product revenue, so these stay null and product-level
    // revenue is simply unavailable from this source (units sold still works).
    unitPrice: null,
    totalPrice: null,
    discount: null,
    productExternalId: productExternalId(line),
    variantExternalId: variantExternalId(line),
    rawPayload: {
      quiver_product_id: nullableString(line.product_id),
      quiver_variant_id: nullableString(line.variant_id),
      subscription_name: nullableString(line.subscription_name),
    },
  }));

  // Quiver's REFUND price type is an order-level refunded TOTAL, not per-line
  // detail — enough to know an order was refunded and by how much, which is what
  // the return-rate beliefs read.
  const refundAmount = money[QUIVER_PRICE_TYPES.REFUND] ?? null;
  const refund = refundAmount && refundAmount !== "0.00"
    ? {
        merchantId,
        shopId,
        externalId: `${externalId}:refund`,
        amount: refundAmount,
        currency,
        reason: null, // Quiver records no refund reason.
        sourceCreatedAt: placedAt,
        processedAt: placedAt,
        rawPayload: { source: "quiver_order_prices.REFUND" },
      }
    : null;

  return { order, lineItems, refund, anomalies };
}

/**
 * Derive the product/variant catalog from the line items that reference it.
 *
 * Quiver has no product table, so the catalog is only ever what was SOLD. A SKU
 * that never sold does not exist here — which is precisely why dead-stock beliefs
 * cannot be derived from a corpus shop (see QUIVER_COVERAGE_GAPS).
 *
 * @param {Array<Record<string, any>>} lineItems Canonical line items from mapQuiverOrder.
 * @param {{ merchantId: string, shopId: string }} context
 */
export function deriveCatalog(lineItems, context) {
  const { merchantId, shopId } = context;
  const products = new Map();
  const variants = new Map();

  for (const line of lineItems ?? []) {
    const productKey = line.productExternalId;
    if (productKey && !products.has(productKey)) {
      products.set(productKey, {
        merchantId,
        shopId,
        externalId: productKey,
        title: line.title || productKey,
        handle: null,
        status: null,
        vendor: null,
        productType: null,
        rawPayload: { derived_from: "quiver_order_line_items" },
      });
    }
    const variantKey = line.variantExternalId;
    if (variantKey && !variants.has(variantKey)) {
      variants.set(variantKey, {
        merchantId,
        shopId,
        externalId: variantKey,
        productExternalId: productKey,
        sku: line.sku,
        title: line.title,
        // No price and no cost: Quiver line items carry neither. Left null so a
        // margin calculation reports "unavailable" instead of computing from zero.
        price: null,
        unitCost: null,
        rawPayload: { derived_from: "quiver_order_line_items" },
      });
    }
  }

  return { products: [...products.values()], variants: [...variants.values()] };
}

/**
 * The coverage gaps a corpus shop carries, stamped onto the Shop so the limitation
 * travels with the data. An insight built on absent data reads exactly like one
 * built on evidence — this is what lets a reviewer tell them apart.
 * @param {{ platform?: string | null, merchantName?: string | null }} meta
 */
export function corpusShopMetadata(meta = {}) {
  return {
    source: "quiver_redshift",
    sourcePlatform: String(meta.platform ?? "unknown").toLowerCase(),
    sourceMerchantName: meta.merchantName ?? null,
    coverageGaps: [...QUIVER_COVERAGE_GAPS, "line_item_prices"],
    simulation: true,
  };
}

/** @param {Record<string, any>} line */
function productExternalId(line) {
  const productId = nullableString(line?.product_id);
  if (productId) return `product:${productId}`;
  const sku = nullableString(line?.sku);
  if (sku) return `sku:${sku}`;
  const name = nullableString(line?.name);
  return name ? `title:${name.toLowerCase()}` : null;
}

/** @param {Record<string, any>} line */
function variantExternalId(line) {
  const variantId = nullableString(line?.variant_id);
  if (variantId) return `variant:${variantId}`;
  const product = productExternalId(line);
  const sku = nullableString(line?.sku);
  if (!product) return null;
  return sku ? `${product}/sku:${sku}` : `${product}/default`;
}

/**
 * @param {Record<string, any>} row
 * @param {{ includePersonalFields: boolean }} options
 */
function buildRawPayload(row, { includePersonalFields }) {
  /** @type {Record<string, any>} */
  const payload = {
    quiver_row_id: nullableString(row.id),
    platform: String(row.platform ?? "").toLowerCase() || null,
    order_id: nullableString(row.order_id),
    channel: nullableString(row.channel),
    retail_location_id: nullableString(row.retail_location_id),
    city: nullableString(row.city),
    postcode_prefix: nullableString(row.postcode_prefix),
    country: nullableString(row.country),
    company: nullableString(row.company),
    delivered_by_quiver: typeof row.quiver === "boolean" ? row.quiver : null,
    shipping_title: nullableString(row.shipping_title),
    shipping_code: nullableString(row.shipping_code),
    tags: nullableString(row.tags),
    payment_gateway_name: nullableString(row.payment_gateway_name),
  };

  if (includePersonalFields) {
    // Founder ruling 2026-08-12: Quiver owns this data and Jefe may use it. Carried
    // only on an explicit opt-in so it is never an accident, and `customer_journey`
    // stays excluded regardless — see NEVER_CARRIED_COLUMNS.
    payload.personal = {
      first_name: nullableString(row.first_name),
      last_name: nullableString(row.last_name),
      email: nullableString(row.email),
      phone_number: nullableString(row.phone_number),
      address: nullableString(row.address),
      postcode: nullableString(row.postcode),
      latitude: Number.isFinite(Number(row.latitude)) ? Number(row.latitude) : null,
      longitude: Number.isFinite(Number(row.longitude)) ? Number(row.longitude) : null,
    };
  }

  return payload;
}

/** @param {unknown} value */
function nullableString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** @param {unknown} value */
function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
