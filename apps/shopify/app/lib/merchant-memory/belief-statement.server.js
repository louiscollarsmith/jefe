// @ts-check

// Plain-English per-belief STATEMENT rendering — turns a belief's structured value into a sentence
// in Jefe's voice ("3 products have stock but no sales in the last 90 days — about £4,200 tied up.
// The biggest is Winback Seasonal Bundle."), so the Memory surface states what Jefe UNDERSTANDS,
// not the raw value. Deterministic (in code, not prompts): a per-belief-key formatter registry +
// a null fallback — no formatter for a key ⇒ null, and the surface keeps its own status-derived
// fallback (honest degradation, never a blank). A statement is exactly as strong as its belief:
// it describes inference the same as the belief's own provenance/confidence, never beyond it.
//
// This is increment 1 of the Memory-voice pass: the seam + the highest-value exemplar (dead stock,
// the belief the clearance action operates on). Add formatters key-by-key; each is pure and
// value-shape-specific, wrapped so a bad/absent value degrades to null rather than throwing.

/** @param {string | undefined} currency @param {any} amount */
function money(currency, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n)}`;
  }
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A percentage the way a person says it: whole numbers, but keep a decimal for sub-1% so it
 * never reads as "0%". @param {any} n @returns {string | null} */
function pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v > 0 && v < 1) return v.toFixed(1);
  return String(Math.round(v));
}

/**
 * products.dead_stock.trailing_90d → the dead-stock summary in plain English.
 * Value shape (from the deadStock derivation): { deadStockProductCount, totalTrappedCapital,
 * currency, topDeadProduct: { title, trappedCapital } }.
 * @param {any} value
 */
function formatDeadStock(value) {
  const count = Number(value?.deadStockProductCount);
  if (!Number.isFinite(count) || count < 1) return null;
  const verb = count === 1 ? "has" : "have";
  let s = `${plural(count, "product")} ${verb} stock but no sales in the last 90 days`;
  const tied = money(value?.currency, value?.totalTrappedCapital);
  if (tied && Number(value?.totalTrappedCapital) > 0) s += `, about ${tied} tied up`;
  const topTitle = value?.topDeadProduct?.title;
  if (topTitle) s += `. The biggest is ${topTitle}`;
  return `${s}.`;
}

/**
 * products.top_product_revenue_share.trailing_90d → revenue concentration.
 * Value (shareOutcome): { percentage, topN, ... }. @param {any} value
 */
function formatTopProductShare(value) {
  const p = pct(value?.percentage);
  if (!p || !(Number(value?.percentage) > 0)) return null;
  const topN = Number(value?.topN);
  if (topN === 1) return `Your top product brings in ${p}% of your revenue.`;
  const n = Number.isFinite(topN) && topN > 0 ? `top ${topN} products` : "top few products";
  return `Your ${n} bring in ${p}% of your revenue.`;
}

/**
 * products.top_returned_products.trailing_180d → the most-returned product.
 * Value: { topReturnedProduct: { title, returnRatePercent, returnedUnits } }. @param {any} value
 */
function formatTopReturned(value) {
  const top = value?.topReturnedProduct;
  if (!top?.title) return null;
  const rate = pct(top.returnRatePercent);
  if (rate && Number(top.returnRatePercent) > 0) {
    return `${top.title} comes back most — about ${rate}% of the ones you sell get returned.`;
  }
  const units = Number(top.returnedUnits);
  if (Number.isFinite(units) && units > 0) {
    return `${top.title} has the most returns lately — ${plural(units, "unit")} sent back.`;
  }
  return null;
}

/**
 * inventory.low_cover_products.trailing_30d → the product closest to running out.
 * Value: { topAtRiskProduct: { title, daysOfCover }, atRiskProductCount }. @param {any} value
 */
function formatLowCover(value) {
  const top = value?.topAtRiskProduct;
  if (!top?.title) return null;
  const days = Number(top.daysOfCover);
  if (!Number.isFinite(days)) return null;
  let s = `${top.title} runs low soon — about ${plural(Math.max(0, Math.round(days)), "day")} of stock left at the current pace`;
  const count = Number(value?.atRiskProductCount);
  if (Number.isFinite(count) && count > 1) s += `, and ${plural(count - 1, "other")} running low`;
  return `${s}.`;
}

/** refunds.refunded_order_rate.all_time → refund rate. Value (shareOutcome): { percentage }. @param {any} value */
function formatRefundRate(value) {
  const p = pct(value?.percentage);
  if (!p) return null;
  return `About ${p}% of your orders get refunded.`;
}

/** @type {Record<string, (value: any) => string | null>} */
const FORMATTERS = {
  "products.dead_stock.trailing_90d": formatDeadStock,
  "products.top_product_revenue_share.trailing_90d": formatTopProductShare,
  "products.top_returned_products.trailing_180d": formatTopReturned,
  "inventory.low_cover_products.trailing_30d": formatLowCover,
  "refunds.refunded_order_rate.all_time": formatRefundRate,
};

/** Belief keys that have a statement formatter (for coverage checks / roadmap). */
export const STATEMENT_FORMATTED_KEYS = Object.freeze(Object.keys(FORMATTERS));

/**
 * Render a belief as a plain-English statement, or null when there is no formatter for its key
 * (the surface then keeps its own status-derived fallback). Never throws — a bad value ⇒ null.
 * @param {{ key?: string, value?: any } | null | undefined} belief
 * @returns {string | null}
 */
export function renderBeliefStatement(belief) {
  if (!belief || typeof belief.key !== "string") return null;
  const fmt = FORMATTERS[belief.key];
  if (!fmt) return null;
  try {
    return fmt(belief.value) ?? null;
  } catch {
    return null;
  }
}
