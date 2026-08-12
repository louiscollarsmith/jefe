import assert from "node:assert/strict";
import test from "node:test";

import {
  STATEMENT_FORMATTED_KEYS,
  renderBeliefStatement,
} from "../app/lib/merchant-memory/belief-statement.server.js";
import {
  DETERMINISTIC_BELIEF_REGISTRY,
  isMerchantVisibleBeliefKey,
} from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";

// Roadmap #6, first tranche. Before this, 5 of 114 merchant-facing beliefs could be said in
// plain English, so Jefe's recommendations read as "Order Value Mean To Median Ratio ·
// Trailing 90d". These assert the sentences, not just that a formatter exists — a formatter
// returning "" or a number would satisfy a presence check and still be unreadable.
//
// The value shapes below are the real ones from shopify-derivations (countOutcome →
// { count }, shareOutcome → { percentage, numerator, denominator }), so a derivation change
// that alters the shape fails here rather than silently returning null in production.

const say = (key, value) => renderBeliefStatement({ key, value });

test("every formatted key is a real, merchant-facing belief", () => {
  const byKey = new Map(DETERMINISTIC_BELIEF_REGISTRY.map((b) => [b.key, b]));
  for (const key of STATEMENT_FORMATTED_KEYS) {
    assert.ok(byKey.has(key), `${key} is not in the registry`);
    // A statement is something Jefe SAYS. Writing one for an internal diagnostic would be a
    // category error, and would put it in front of a merchant the moment it rendered.
    assert.ok(isMerchantVisibleBeliefKey(key), `${key} is not merchant-facing`);
  }
});

test("zero-price variants are reported without being called a mistake", () => {
  const s = say("catalog.zero_price_variant_count", { count: 3 });
  assert.match(s, /3 live variants/);
  // The registry caveat is "do not assume zero price is an error" — samples and add-ons are
  // legitimately free. Telling a merchant their deliberate sample line is broken costs trust.
  assert.match(s, /deliberate/i);
  assert.doesNotMatch(s, /error|wrong|broken|mistake/i);
});

test("negative stock is named as a symptom, not a fault", () => {
  const s = say("inventory.negative_inventory_variant_count", { count: 1 });
  assert.match(s, /1 variant is/); // singular agreement
  assert.match(s, /normal if/i); // continuing to sell past zero is legitimate
});

test("discount depth leads with the share and backs it with the money", () => {
  const s = say("business.discount_depth.trailing_90d", {
    percentage: 18.4,
    discountedOrderSharePercent: 62,
    totalDiscount: 9400,
    currency: "GBP",
  });
  assert.match(s, /18%/);
  assert.match(s, /£9,400/);
  assert.match(s, /62% of your orders/);
});

test("repeat-customer rate is stated, never graded", () => {
  const s = say("customers.repeat_customer_rate.all_time", {
    percentage: 22,
    numerator: 44,
    denominator: 200,
  });
  assert.match(s, /22%/);
  // The same number means opposite things for a considered purchase and a habitual one, and
  // the business-shape tranche that would let Jefe tell them apart is not merchant-facing yet.
  assert.doesNotMatch(s, /good|bad|low|high|healthy|poor/i);
});

test("the peak month states how much history it is drawn from", () => {
  const s = say("business.peak_sales_month.all_time", {
    peakMonth: "November",
    peakMonthSharePercent: 21,
    monthsOfHistory: 14,
  });
  assert.match(s, /November/);
  // "Your biggest month" off 14 months is a different claim from off three years.
  assert.match(s, /14 months/);
});

test("missing cost data is an invitation with the exact place to put it", () => {
  const none = say("products.cost_coverage", { percentage: 0 });
  assert.match(none, /can't see cost prices/i);
  assert.match(none, /Cost per item/); // where, precisely
  assert.match(none, /make money/); // and what it unlocks
  // No dead ends: never a bare refusal.
  assert.doesNotMatch(none, /^I can't help/i);

  const partial = say("products.cost_coverage", { percentage: 41 });
  assert.match(partial, /41%/);
  assert.match(partial, /Cost per item/);

  // Nothing to invite once the data is there.
  const full = say("products.cost_coverage", { percentage: 99 });
  assert.doesNotMatch(full, /Cost per item/);
  assert.match(full, /profit/);
});

test("single-item share reads as an opportunity, not a metric", () => {
  const s = say("orders.single_item_order_share.trailing_90d", {
    percentage: 71,
    numerator: 710,
    denominator: 1000,
  });
  assert.match(s, /71%/);
  assert.match(s, /basket/i);
});

test("a missing, empty or malformed value degrades to null rather than a broken sentence", () => {
  for (const key of STATEMENT_FORMATTED_KEYS) {
    assert.equal(say(key, undefined), null, `${key} on undefined`);
    assert.equal(say(key, {}), null, `${key} on {}`);
    assert.equal(say(key, { count: 0, percentage: null }), null, `${key} on empties`);
  }
});

test("no statement ends up with a stray zero, NaN or undefined in it", () => {
  const samples = {
    "catalog.zero_price_variant_count": { count: 2 },
    "inventory.negative_inventory_variant_count": { count: 2 },
    "business.discount_depth.trailing_90d": { percentage: 5, currency: "GBP" },
    "orders.single_item_order_share.trailing_90d": { percentage: 50 },
    "customers.repeat_customer_rate.all_time": { percentage: 30 },
    "business.peak_sales_month.all_time": { peakMonth: "March" },
    "products.cost_coverage": { percentage: 10 },
  };
  for (const [key, value] of Object.entries(samples)) {
    const s = say(key, value);
    assert.ok(s, `${key} produced nothing`);
    assert.doesNotMatch(s, /NaN|undefined|null/, `${key}: ${s}`);
    assert.match(s, /\.$/, `${key} should end in a full stop: ${s}`);
  }
});

// --- second tranche: what a merchant looks at first on a surface they've just opened ---

test("the bestseller is named, with what it earned and its share", () => {
  const s = say("products.bestseller_by_revenue.trailing_90d", {
    title: "Overnight Repair Serum",
    revenue: 18400,
    revenueSharePercent: 31,
    currency: "GBP",
  });
  assert.match(s, /Overnight Repair Serum/);
  assert.match(s, /£18,400/);
  assert.match(s, /31%/);
});

test("customer concentration is stated as exposure, not scolded", () => {
  const s = say("customers.top_customer_revenue_share.all_time", {
    percentage: 44,
    topCustomerCount: 5,
  });
  assert.match(s, /44%/);
  assert.match(s, /top 5 customers/);
  // A few big loyal accounts is a fine business; whether it's a risk depends on things Jefe
  // cannot see from here.
  assert.doesNotMatch(s, /risk|danger|worry|problem|concerning/i);
});

test("a single top customer reads as singular", () => {
  const s = say("customers.top_customer_revenue_share.all_time", {
    percentage: 30,
    topCustomerCount: 1,
  });
  assert.match(s, /top customer\b/);
  assert.doesNotMatch(s, /1 customers/);
});

test("stock value is money, in the shop's own currency", () => {
  const s = say("inventory.retail_value_of_available_stock", { amount: 96000, currency: "GBP" });
  assert.match(s, /£96,000/);
});

test("out-of-stock products say what it costs the merchant", () => {
  const one = say("catalog.out_of_stock_product_count", { count: 1 });
  assert.match(one, /1 live product is/);
  assert.match(one, /buy it today/);
  const many = say("catalog.out_of_stock_product_count", { count: 7 });
  assert.match(many, /7 live products are/);
  assert.match(many, /buy them today/);
});

test("a quiet spell only speaks once it is worth noticing", () => {
  // "0 days since your last order" is noise, not insight.
  assert.equal(say("business.days_since_last_order", { count: 0 }), null);
  assert.equal(say("business.days_since_last_order", { count: 2 }), null);
  const s = say("business.days_since_last_order", { count: 11 });
  assert.match(s, /11 days/);
});

test("products with no sales are not called dead stock", () => {
  // Dead stock is this AND holding stock AND costed. A product here may be new or seasonal,
  // and Jefe cannot tell which — so it states the fact and does not diagnose.
  const s = say("products.no_sale_active_product_count.trailing_90d", { count: 23 });
  assert.match(s, /23 live products haven't sold/);
  assert.doesNotMatch(s, /dead|dying|waste|clear/i);
});
