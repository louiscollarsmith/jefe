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
 * never reads as "0%".
 *
 * MISSING is not zero. `Number(null)` is 0 and `Number("")` is 0, so a belief whose
 * percentage never got computed used to render as a confident "0%" — Jefe stating a figure it
 * does not have, which is worse than staying quiet. Only an actual number counts.
 * @param {any} n @returns {string | null} */
function pct(n) {
  if (typeof n !== "number") return null;
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) return n.toFixed(1);
  return String(Math.round(n));
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

/**
 * catalog.zero_price_variant_count → live variants priced at nothing.
 * Value (countOutcome): { count }.
 *
 * The registry's own caveat is "do not assume zero price is an error", and it is right —
 * samples, add-ons and gift lines are legitimately £0. So this states the fact and hands the
 * judgement back rather than calling it a mistake. Getting this wrong is expensive in trust:
 * a merchant told their deliberate sample line is broken stops believing the next thing.
 * @param {any} value
 */
function formatZeroPriceVariants(value) {
  const count = Number(value?.count);
  if (!Number.isFinite(count) || count < 1) return null;
  const verb = count === 1 ? "is" : "are";
  return `${plural(count, "live variant")} ${verb} priced at zero — deliberate for samples or add-ons, but anything else there is being given away.`;
}

/**
 * inventory.negative_inventory_variant_count → variants showing negative stock.
 * Value (countOutcome): { count }.
 *
 * Caveat: negative stock is normal for a store that keeps selling past zero. Named as a
 * symptom ("sold more than Shopify thought you had"), not as a fault.
 * @param {any} value
 */
function formatNegativeInventory(value) {
  const count = Number(value?.count);
  if (!Number.isFinite(count) || count < 1) return null;
  const verb = count === 1 ? "is" : "are";
  return `${plural(count, "variant")} ${verb} showing negative stock — normal if you let people keep buying past zero, otherwise it means more sold than Shopify thought you had.`;
}

/**
 * business.discount_depth.trailing_90d → how much of the price is being given away.
 * Value: { percentage, discountedOrderSharePercent, totalDiscount, currency }.
 *
 * Leads with the share of revenue rather than the cash, because the percentage is the part a
 * merchant can compare against their own margin; the money is the part that stings.
 * @param {any} value
 */
function formatDiscountDepth(value) {
  const p = pct(value?.percentage);
  if (!p || !(Number(value?.percentage) > 0)) return null;
  let s = `You're discounting about ${p}% of what you'd otherwise charge`;
  const given = money(value?.currency, value?.totalDiscount);
  if (given && Number(value?.totalDiscount) > 0) s += ` — ${given} over the last 90 days`;
  const orderShare = pct(value?.discountedOrderSharePercent);
  if (orderShare && Number(value?.discountedOrderSharePercent) > 0) {
    s += `, across ${orderShare}% of your orders`;
  }
  return `${s}.`;
}

/**
 * orders.single_item_order_share.trailing_90d → how often a basket is just one thing.
 * Value (shareOutcome): { percentage, numerator, denominator }.
 * @param {any} value
 */
function formatSingleItemShare(value) {
  const p = pct(value?.percentage);
  if (!p || !(Number(value?.percentage) > 0)) return null;
  return `${p}% of your orders are a single item — the rest of your basket is where the easier revenue is.`;
}

/**
 * customers.repeat_customer_rate.all_time → how many customers come back.
 * Value (shareOutcome): { percentage, numerator, denominator }.
 *
 * Deliberately NOT judged as high or low. The same number means opposite things for a
 * considered purchase and a habitual one, and the business-shape tranche that would let Jefe
 * say which is not merchant-facing yet. State it; don't grade it on nothing.
 * @param {any} value
 */
function formatRepeatCustomerRate(value) {
  const p = pct(value?.percentage);
  if (!p) return null;
  const repeat = Number(value?.numerator);
  let s = `${p}% of the customers I can see have bought more than once`;
  if (Number.isFinite(repeat) && repeat > 0) s += ` — ${plural(repeat, "person")} so far`;
  return `${s}.`;
}

/**
 * business.peak_sales_month.all_time → the shape of the merchant's year.
 * Value: { peakMonth, peakMonthSharePercent, peakMonthRevenue, monthsOfHistory, currency }.
 *
 * States its own scope. A "best month" drawn from thirteen months of history is a very
 * different claim from one drawn from three years, and the merchant is the one who knows
 * which of those is worth acting on.
 * @param {any} value
 */
function formatPeakSalesMonth(value) {
  const month = value?.peakMonth;
  if (typeof month !== "string" || !month) return null;
  let s = `${month} is your biggest month`;
  const share = pct(value?.peakMonthSharePercent);
  if (share && Number(value?.peakMonthSharePercent) > 0) s += ` — about ${share}% of your year's revenue`;
  const months = Number(value?.monthsOfHistory);
  if (Number.isFinite(months) && months > 0) {
    s += `, across the ${plural(Math.round(months), "month")} of history I hold`;
  }
  return `${s}.`;
}

/**
 * products.cost_coverage → the margin gap, framed as an invitation.
 * Value (shareOutcome): { percentage, variantsWithCost, activeVariants }.
 *
 * The one input Jefe cannot observe. Missing data is an invitation, not a blocker: say what
 * is missing, what it unlocks, and exactly where to put it — never a bare refusal to speak.
 * @param {any} value
 */
function formatCostCoverage(value) {
  // A real number, not a missing one. "I can't see cost prices" happens to be true when the
  // belief is absent, but it would be Jefe speaking from a belief it does not hold — and the
  // surface has its own fallback for that. A genuine 0% still gets the invitation.
  const raw = value?.percentage;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw >= 95) return `I have cost prices for nearly everything you sell, so I can talk about profit, not just revenue.`;
  const where = "Shopify → a product → Inventory → Cost per item";
  if (raw < 5) {
    return `I can't see cost prices for your products, so I can't work out margin or profit yet. Add cost-per-item (${where}) and I can tell you which of your bestsellers actually make money.`;
  }
  const p = pct(raw);
  return `I have cost prices for about ${p}% of what you sell, so I can't judge margin reliably yet. Fill in the rest (${where}) and I can tell you which of your bestsellers actually make money.`;
}

/** @type {Record<string, (value: any) => string | null>} */
const FORMATTERS = {
  "products.dead_stock.trailing_90d": formatDeadStock,
  "products.top_product_revenue_share.trailing_90d": formatTopProductShare,
  "products.top_returned_products.trailing_180d": formatTopReturned,
  "inventory.low_cover_products.trailing_30d": formatLowCover,
  "refunds.refunded_order_rate.all_time": formatRefundRate,
  // Roadmap #6, first tranche — chosen by what a merchant would act on, per
  // docs/what-jefe-can-say-today.md, not by walking the registry.
  "catalog.zero_price_variant_count": formatZeroPriceVariants,
  "inventory.negative_inventory_variant_count": formatNegativeInventory,
  "business.discount_depth.trailing_90d": formatDiscountDepth,
  "orders.single_item_order_share.trailing_90d": formatSingleItemShare,
  "customers.repeat_customer_rate.all_time": formatRepeatCustomerRate,
  "business.peak_sales_month.all_time": formatPeakSalesMonth,
  "products.cost_coverage": formatCostCoverage,
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
