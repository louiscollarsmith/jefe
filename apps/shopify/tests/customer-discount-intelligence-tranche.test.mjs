import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { renderBeliefStatement } from "../app/lib/merchant-memory/belief-statement.server.js";

// Task 2 tranche: RFM-style customer segmentation, a leading early-retention indicator,
// and discount concentration/effect/customer-mix — all computed from data already ingested
// (Order.totalDiscount/customerExternalId, OrderLineItem.discount, CustomerIdentity
// orderCount/totalSpend/firstSeenOrderAt/lastOrderAt). No new Shopify reads or scopes.

const now = Date.now();
const day = 86400000;

async function derive(prisma, categories) {
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories,
  });
  return new Map(result.derivations.map((belief) => [belief.key, belief]));
}

function baseShop() {
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "mock.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Mock Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// customers.rfm_segment_mix.all_time
// ---------------------------------------------------------------------------

function rfmPrisma() {
  const identities = [];
  // 12 "loyal": standard spend, recent last order (not overdue).
  for (let i = 0; i < 12; i++) {
    identities.push({
      orderCount: 2,
      totalSpend: "100.00",
      firstSeenOrderAt: new Date(now - 70 * day),
      lastOrderAt: new Date(now - 10 * day),
    });
  }
  // 4 "champions": high spend, recent last order (not overdue).
  for (let i = 0; i < 4; i++) {
    identities.push({
      orderCount: 2,
      totalSpend: "2000.00",
      firstSeenOrderAt: new Date(now - 70 * day),
      lastOrderAt: new Date(now - 10 * day),
    });
  }
  // 4 "at_risk": high spend, last order overdue against the store's own rhythm.
  for (let i = 0; i < 4; i++) {
    identities.push({
      orderCount: 2,
      totalSpend: "2000.00",
      firstSeenOrderAt: new Date(now - 200 * day),
      lastOrderAt: new Date(now - 190 * day),
    });
  }
  // 5 one-time buyers.
  for (let i = 0; i < 5; i++) {
    identities.push({
      orderCount: 1,
      totalSpend: "50.00",
      firstSeenOrderAt: new Date(now - 20 * day),
      lastOrderAt: new Date(now - 20 * day),
    });
  }
  return {
    ...baseShop(),
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => [] },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => identities },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("RFM segment mix separates champions (current) from at-risk (overdue) among equally high-value repeat customers", async () => {
  const beliefs = await derive(rfmPrisma(), ["customers"]);
  const rfm = beliefs.get("customers.rfm_segment_mix.all_time");
  assert.ok(rfm, "belief should be calculated, not skipped");
  assert.equal(rfm.value.customers, 25);
  assert.equal(rfm.value.oneTimeCustomers, 5);
  assert.equal(rfm.value.championsCustomers, 4);
  assert.equal(rfm.value.atRiskCustomers, 4);
  assert.equal(rfm.value.loyalCustomers, 12);
  assert.equal(rfm.value.fadingCustomers, 0);
  // Both high-value groups clear the same spend threshold — only recency tells them apart.
  assert.equal(rfm.value.highValueSpendThreshold, 2000);
  assert.equal(rfm.value.atRiskRevenueAtStake, 8000);
  assert.equal(rfm.value.typicalRepeatGapDays, 60);
  assert.equal(rfm.value.lapsedAfterDays, 120);

  const statement = renderBeliefStatement({ key: rfm.key, value: rfm.value });
  assert.match(statement, /4 customers used to be among your best/);
  assert.match(statement, /8,000/);
  assert.match(statement, /4 customers match that same high value/);
});

test("RFM segment mix withholds champion/at-risk when the store has too few repeat customers for a rhythm", async () => {
  const identities = Array.from({ length: 12 }, (_, i) => ({
    orderCount: i < 3 ? 2 : 1,
    totalSpend: "100.00",
    firstSeenOrderAt: new Date(now - 30 * day),
    lastOrderAt: new Date(now - 10 * day),
  }));
  const prisma = {
    ...baseShop(),
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => [] },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => identities },
    inventoryLevel: { findMany: async () => [] },
  };
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["customers"],
  });
  const skipped = new Map(result.skippedOutcomes.map((o) => [o.key, o]));
  assert.ok(skipped.has("customers.rfm_segment_mix.all_time"));
  assert.equal(skipped.get("customers.rfm_segment_mix.all_time").status, "INSUFFICIENT_DATA");
});

// ---------------------------------------------------------------------------
// customers.new_customer_early_repeat_rate.trailing_180d
// ---------------------------------------------------------------------------

function earlyRepeatPrisma({ newRepeaters = 12, newNonRepeaters = 8, staleCustomers = 5, censoredCustomers = 0 } = {}) {
  const orders = [];
  let n = 0;
  for (let i = 0; i < newRepeaters; i++) {
    const customerId = `customer-new-repeat-${i}`;
    n += 1;
    // First order 100 days ago — old enough for the 90-day follow window to have
    // fully elapsed, so this customer is part of the fully-observed cohort.
    orders.push(order(`order-${n}`, customerId, now - 100 * day));
    n += 1;
    // Second order 70 days after the first — inside the 90-day follow window.
    orders.push(order(`order-${n}`, customerId, now - 30 * day));
  }
  for (let i = 0; i < newNonRepeaters; i++) {
    const customerId = `customer-new-once-${i}`;
    n += 1;
    orders.push(order(`order-${n}`, customerId, now - 100 * day));
  }
  for (let i = 0; i < staleCustomers; i++) {
    const customerId = `customer-old-${i}`;
    n += 1;
    // First order well outside the 180-day acquisition window — must not count as "new".
    orders.push(order(`order-${n}`, customerId, now - 300 * day));
    n += 1;
    orders.push(order(`order-${n}`, customerId, now - 20 * day));
  }
  for (let i = 0; i < censoredCustomers; i++) {
    const customerId = `customer-censored-${i}`;
    n += 1;
    // First order only 10 days ago — has NOT had the full 90-day follow window yet.
    // Must be excluded entirely (right-censored), never counted as a non-repeat.
    orders.push(order(`order-${n}`, customerId, now - 10 * day));
  }
  return {
    ...baseShop(),
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

function order(id, customerExternalId, atMs) {
  const at = new Date(atMs);
  return {
    id,
    externalId: id,
    currency: "GBP",
    totalPrice: "50.00",
    totalDiscount: "0.00",
    totalTax: "0.00",
    totalShipping: "0.00",
    processedAt: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    customerExternalId,
    financialStatus: "PAID",
  };
}

test("new-customer early repeat rate counts only the fully-observed 90-180-day cohort, and only repeats within 90 days of their first order", async () => {
  const beliefs = await derive(earlyRepeatPrisma(), ["customers"]);
  const belief = beliefs.get("customers.new_customer_early_repeat_rate.trailing_180d");
  assert.ok(belief, "belief should be calculated, not skipped");
  assert.equal(belief.value.newCustomers, 20);
  assert.equal(belief.value.repeatedWithin90dCount, 12);
  assert.equal(belief.value.repeatedWithin90dSharePercent, 60);

  const statement = renderBeliefStatement({ key: belief.key, value: belief.value });
  assert.match(statement, /60%/);
  assert.match(statement, /3 to 6 months ago/);
});

test("new-customer early repeat rate is withheld below the minimum new-customer sample", async () => {
  const beliefs = await derive(earlyRepeatPrisma({ newRepeaters: 2, newNonRepeaters: 3, staleCustomers: 0 }), ["customers"]);
  assert.equal(beliefs.has("customers.new_customer_early_repeat_rate.trailing_180d"), false);
});

// Regression: a customer acquired recently has not had the full 90-day follow window
// elapse yet — "hasn't repeated" is not yet knowable for them. Counting them as a
// non-repeater would right-censor the rate downward purely because they are recent.
// They must be excluded entirely, not counted in either the numerator or denominator.
test("new-customer early repeat rate excludes right-censored customers acquired within the last 90 days, rather than counting them as non-repeaters", async () => {
  const withoutCensored = await derive(earlyRepeatPrisma({ censoredCustomers: 0 }), ["customers"]);
  const withCensored = await derive(earlyRepeatPrisma({ censoredCustomers: 15 }), ["customers"]);
  const beliefWithout = withoutCensored.get("customers.new_customer_early_repeat_rate.trailing_180d");
  const beliefWith = withCensored.get("customers.new_customer_early_repeat_rate.trailing_180d");
  assert.ok(beliefWithout && beliefWith, "belief should be calculated in both cases");
  // Adding 15 recently-acquired (10-days-ago) customers must not change newCustomers,
  // the repeat count, or the share — they are outside the fully-observed cohort.
  assert.equal(beliefWith.value.newCustomers, beliefWithout.value.newCustomers);
  assert.equal(beliefWith.value.repeatedWithin90dCount, beliefWithout.value.repeatedWithin90dCount);
  assert.equal(beliefWith.value.repeatedWithin90dSharePercent, beliefWithout.value.repeatedWithin90dSharePercent);
});

// A cohort consisting ONLY of too-recent (censored) customers must not silently
// publish a rate built by treating "hasn't repeated yet" as "won't repeat" — it must
// be withheld as insufficient data, since zero fully-observed customers exist.
test("new-customer early repeat rate is withheld when every new customer is still within the follow window", async () => {
  const beliefs = await derive(earlyRepeatPrisma({ newRepeaters: 0, newNonRepeaters: 0, staleCustomers: 0, censoredCustomers: 15 }), ["customers"]);
  assert.equal(beliefs.has("customers.new_customer_early_repeat_rate.trailing_180d"), false);
});

// ---------------------------------------------------------------------------
// business.discount_order_value_effect.trailing_90d
// ---------------------------------------------------------------------------

function discountEffectPrisma() {
  const orders = [];
  const lineItems = [];
  for (let i = 0; i < 10; i++) {
    const id = `disc-order-${i}`;
    const at = new Date(now - (i + 1) * day);
    orders.push({
      id,
      externalId: id,
      currency: "GBP",
      totalPrice: "120.00",
      totalDiscount: "15.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `cust-${i}`,
      financialStatus: "PAID",
    });
    lineItems.push({ orderId: id, productId: "product-1", variantId: "variant-1", quantity: 2, unitPrice: "60.00", totalPrice: "120.00", discount: "15.00" });
  }
  for (let i = 0; i < 10; i++) {
    const id = `plain-order-${i}`;
    const at = new Date(now - (i + 1) * day);
    orders.push({
      id,
      externalId: id,
      currency: "GBP",
      totalPrice: "100.00",
      totalDiscount: "0.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `cust-plain-${i}`,
      financialStatus: "PAID",
    });
    lineItems.push({ orderId: id, productId: "product-1", variantId: "variant-1", quantity: 1, unitPrice: "100.00", totalPrice: "100.00", discount: "0.00" });
  }
  return {
    ...baseShop(),
    product: { findMany: async () => [{ id: "product-1", title: "Widget", status: "ACTIVE" }] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => lineItems },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("discount order-value effect compares discounted vs undiscounted AOV and basket size", async () => {
  const beliefs = await derive(discountEffectPrisma(), ["business"]);
  const belief = beliefs.get("business.discount_order_value_effect.trailing_90d");
  assert.ok(belief, "belief should be calculated, not skipped");
  assert.equal(belief.value.discountedOrderCount, 10);
  assert.equal(belief.value.undiscountedOrderCount, 10);
  assert.equal(belief.value.discountedAverageOrderValue, 120);
  assert.equal(belief.value.undiscountedAverageOrderValue, 100);
  assert.equal(belief.value.averageOrderValueLiftPercent, 20);
  assert.equal(belief.value.discountedAverageItemsPerOrder, 2);
  assert.equal(belief.value.undiscountedAverageItemsPerOrder, 1);
  assert.equal(belief.value.itemsPerOrderLiftPercent, 100);

  const statement = renderBeliefStatement({ key: belief.key, value: belief.value });
  assert.match(statement, /bigger/);
  assert.doesNotMatch(statement, /caus/i);
});

test("discount order-value effect is withheld without both a discounted and undiscounted sample", async () => {
  const prisma = discountEffectPrisma();
  const onlyDiscounted = {
    ...prisma,
    order: { findMany: async () => (await prisma.order.findMany()).filter((o) => o.id.startsWith("disc-")) },
    orderLineItem: { findMany: async () => (await prisma.orderLineItem.findMany()).filter((li) => li.orderId.startsWith("disc-")) },
  };
  const beliefs = await derive(onlyDiscounted, ["business"]);
  assert.equal(beliefs.has("business.discount_order_value_effect.trailing_90d"), false);
});

// ---------------------------------------------------------------------------
// business.discount_concentration.trailing_90d
// ---------------------------------------------------------------------------

function discountConcentrationPrisma() {
  const products = [
    { id: "product-a", externalId: "gid://shopify/Product/5001", title: "Big Discount Product", status: "ACTIVE" },
    { id: "product-b", externalId: "gid://shopify/Product/5002", title: "Small Discount Product", status: "ACTIVE" },
    { id: "product-c", externalId: "gid://shopify/Product/5003", title: "Tiny Discount Product", status: "ACTIVE" },
  ];
  const orders = Array.from({ length: 8 }, (_, i) => {
    const id = `order-${i}`;
    const at = new Date(now - (i + 1) * day);
    return {
      id,
      externalId: id,
      currency: "GBP",
      totalPrice: "100.00",
      totalDiscount: "10.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `cust-${i}`,
      financialStatus: "PAID",
    };
  });
  const lineItems = [
    ...Array.from({ length: 4 }, (_, i) => ({ orderId: `order-${i}`, productId: "product-a", variantId: "v-a", quantity: 1, unitPrice: "100.00", totalPrice: "80.00", discount: "200.00" })),
    ...Array.from({ length: 2 }, (_, i) => ({ orderId: `order-${i + 4}`, productId: "product-b", variantId: "v-b", quantity: 1, unitPrice: "100.00", totalPrice: "90.00", discount: "75.00" })),
    ...Array.from({ length: 2 }, (_, i) => ({ orderId: `order-${i + 6}`, productId: "product-c", variantId: "v-c", quantity: 1, unitPrice: "100.00", totalPrice: "95.00", discount: "25.00" })),
  ];
  return {
    ...baseShop(),
    product: { findMany: async () => products },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => lineItems },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("discount concentration ranks products by line-item discount amount", async () => {
  const beliefs = await derive(discountConcentrationPrisma(), ["business"]);
  const belief = beliefs.get("business.discount_concentration.trailing_90d");
  assert.ok(belief, "belief should be calculated, not skipped");
  // product-a: 4 * 200 = 800; product-b: 2 * 75 = 150; product-c: 2 * 25 = 50. Total = 1000.
  assert.equal(belief.value.totalDiscountAmount, 1000);
  assert.equal(belief.value.topDiscountedProduct.productId, "gid://shopify/Product/5001");
  assert.equal(belief.value.topDiscountedProduct.discountAmount, 800);
  assert.equal(belief.value.top5ConcentrationSharePercent, 100);
  assert.equal(belief.value.discountedProductCount, 3);

  const statement = renderBeliefStatement({ key: belief.key, value: belief.value });
  assert.match(statement, /Big Discount Product/);
});

// ---------------------------------------------------------------------------
// business.discount_customer_mix.trailing_90d
// ---------------------------------------------------------------------------

function discountCustomerMixPrisma() {
  const identities = [
    ...Array.from({ length: 4 }, (_, i) => ({ orderCount: 2, totalSpend: "200.00", shopifyCustomerId: `cust-R${i}` })),
    ...Array.from({ length: 16 }, (_, i) => ({ orderCount: 1, totalSpend: "50.00", shopifyCustomerId: `cust-N${i}` })),
  ];
  const orders = [];
  // 12 discounted orders: 10 from repeat customers (cycling R0-R3), 2 from new customers.
  for (let i = 0; i < 10; i++) orders.push(discOrder(`disc-r-${i}`, `cust-R${i % 4}`, true));
  for (let i = 0; i < 2; i++) orders.push(discOrder(`disc-n-${i}`, `cust-N${i}`, true));
  // 8 undiscounted orders: 2 from repeat customers, 6 from new customers.
  for (let i = 0; i < 2; i++) orders.push(discOrder(`plain-r-${i}`, `cust-R${i}`, false));
  for (let i = 2; i < 8; i++) orders.push(discOrder(`plain-n-${i}`, `cust-N${i}`, false));
  return {
    ...baseShop(),
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => identities },
    inventoryLevel: { findMany: async () => [] },
  };
}

function discOrder(id, customerExternalId, discounted) {
  const at = new Date(now - 5 * day);
  return {
    id,
    externalId: id,
    currency: "GBP",
    totalPrice: discounted ? "90.00" : "100.00",
    totalDiscount: discounted ? "10.00" : "0.00",
    totalTax: "0.00",
    totalShipping: "0.00",
    processedAt: at,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    customerExternalId,
    financialStatus: "PAID",
  };
}

test("discount customer mix flags when discounts over-index toward repeat customers", async () => {
  const beliefs = await derive(discountCustomerMixPrisma(), ["business"]);
  const belief = beliefs.get("business.discount_customer_mix.trailing_90d");
  assert.ok(belief, "belief should be calculated, not skipped");
  assert.equal(belief.value.linkedOrders, 20);
  assert.equal(belief.value.discountedOrders, 12);
  assert.equal(belief.value.repeatCustomerShareOfAllOrdersPercent, 60);
  // 10 of 12 discounted orders come from the 4 repeat customers.
  assert.equal(belief.value.repeatCustomerShareOfDiscountedOrdersPercent, 83.33);
  assert.ok(belief.value.overIndexRatio > 1.3);

  const statement = renderBeliefStatement({ key: belief.key, value: belief.value });
  assert.match(statement, /already buy repeatedly/);
});

test("discount customer mix stays silent when repeat customers are not meaningfully over-indexed", async () => {
  // Repeat share of discounted orders matches their share of all orders — nothing to flag.
  const identities = [
    ...Array.from({ length: 4 }, (_, i) => ({ orderCount: 2, totalSpend: "200.00", shopifyCustomerId: `cust-R${i}` })),
    ...Array.from({ length: 16 }, (_, i) => ({ orderCount: 1, totalSpend: "50.00", shopifyCustomerId: `cust-N${i}` })),
  ];
  const orders = [];
  // 2 of 10 discounted orders from repeat customers (20%); 2 of 10 undiscounted orders from
  // repeat customers (20%) — identical share, so nothing is over-indexed.
  for (let i = 0; i < 2; i++) orders.push(discOrder(`disc-r-${i}`, `cust-R${i}`, true));
  for (let i = 0; i < 8; i++) orders.push(discOrder(`disc-n-${i}`, `cust-N${i}`, true));
  for (let i = 2; i < 4; i++) orders.push(discOrder(`plain-r-${i}`, `cust-R${i}`, false));
  for (let i = 8; i < 16; i++) orders.push(discOrder(`plain-n-${i}`, `cust-N${i}`, false));
  const prisma = {
    ...baseShop(),
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => identities },
    inventoryLevel: { findMany: async () => [] },
  };
  const beliefs = await derive(prisma, ["business"]);
  const belief = beliefs.get("business.discount_customer_mix.trailing_90d");
  assert.ok(belief);
  const statement = renderBeliefStatement({ key: belief.key, value: belief.value });
  assert.equal(statement, null);
});
