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
