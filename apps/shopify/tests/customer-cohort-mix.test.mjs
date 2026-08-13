import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";

// `repeat_customer_rate` says 30% of customers came back. It cannot say whether that is
// twelve people buying every fortnight or three hundred people buying twice — and those
// two businesses want opposite things done about them. This belief is the split.

const KEY = "customers.cohort_mix.all_stored_history";
const DAY = 86400000;

test("a few devoted buyers and a broad shallow base are told apart", async () => {
  // Same repeat rate could describe both. The cohort split cannot.
  const devoted = await deriveOne(
    identities({ oneTime: 60, returning: 0, loyal: 40, spendPerOrder: 50, gapDays: 20 }),
  );
  const shallow = await deriveOne(
    identities({ oneTime: 60, returning: 40, loyal: 0, spendPerOrder: 50, gapDays: 20 }),
  );

  assert.equal(devoted?.status, "CALCULATED");
  assert.equal(shallow?.status, "CALCULATED");

  assert.equal(devoted.value.loyalSharePercent, 40);
  assert.equal(shallow.value.loyalSharePercent, 0);
  assert.equal(shallow.value.returningSharePercent, 40);

  // And the money matters more than the headcount: loyal buyers are 40% of people but a
  // larger share of revenue, which is the fact that justifies spending anything on them.
  assert.ok(devoted.value.loyalRevenueSharePercent > devoted.value.loyalSharePercent);
});

test("lapsed is judged against the store's own rhythm, not a fixed 90 days", async () => {
  // ⛔ The property this belief exists to protect. The SAME 100-day silence is a lapsed
  // subscriber at a fortnightly store and an entirely normal gap at a furniture store. A
  // fixed window would call both lapsed, or neither, and be wrong about one of them.
  const fortnightly = await deriveOne(
    identities({ oneTime: 20, returning: 0, loyal: 30, spendPerOrder: 40, gapDays: 14, lastOrderDaysAgo: 100 }),
  );
  const furniture = await deriveOne(
    identities({ oneTime: 20, returning: 0, loyal: 30, spendPerOrder: 900, gapDays: 240, lastOrderDaysAgo: 100 }),
  );

  assert.equal(fortnightly.value.recencyBasis, "store_observed_repeat_gap");
  assert.equal(furniture.value.recencyBasis, "store_observed_repeat_gap");

  // Silent for 100 days against a ~14-day rhythm: gone.
  assert.ok(fortnightly.value.lapsedSharePercent > 0, "a fortnightly store's 100-day silence should read as lapsed");
  // Silent for 100 days against a ~240-day rhythm: still early.
  assert.equal(furniture.value.lapsedSharePercent, 0, "a furniture store's 100-day gap is not lapsed");

  assert.ok(furniture.value.typicalRepeatGapDays > fortnightly.value.typicalRepeatGapDays * 5);
});

test("with too few repeat customers Jefe withholds the recency split and says why", async () => {
  // "No lapsed customers" and "we could not work out what lapsed means here" must never be
  // the same output — the first invites doing nothing, the second invites getting more data.
  const belief = await deriveOne(
    identities({ oneTime: 40, returning: 2, loyal: 0, spendPerOrder: 30, gapDays: 30 }),
  );

  assert.equal(belief?.status, "CALCULATED", "the count cohorts should still be reported");
  assert.equal(belief.value.recencyBasis, "unavailable_too_few_repeat_customers");
  assert.equal(belief.value.lapsedSharePercent, undefined);
  assert.equal(belief.value.lapsedCustomers, undefined);
  // The count half is still useful and still there.
  assert.ok(belief.value.oneTimeSharePercent > 90);
});

test("a customer base too small to describe is skipped, not guessed at", async () => {
  const belief = await deriveOne(identities({ oneTime: 4, returning: 0, loyal: 0, spendPerOrder: 30, gapDays: 30 }));
  assert.notEqual(belief?.status, "CALCULATED");
});

test("nothing identifying a customer reaches the belief", async () => {
  // These are hashed identities and the belief is aggregate by construction. This pins it,
  // because the cheapest way to make this belief "more useful" is to name someone.
  const belief = await deriveOne(
    identities({ oneTime: 20, returning: 10, loyal: 10, spendPerOrder: 40, gapDays: 21 }),
  );
  const serialised = JSON.stringify(belief.value);
  // Actual identifying VALUES from the fixture, plus the field names that carry them.
  // Deliberately not a bare "customer-" substring — the belief's own
  // `thresholdVersion: "customer-cohort-v1"` contains it, and a check that trips on its own
  // metadata teaches you to relax the check.
  for (const leak of [
    "emailHash",
    "maskedEmail",
    "shopifyCustomerId",
    "@example.com",
    "hash-",
    "customer-one-",
    "customer-loyal-",
  ]) {
    assert.ok(!serialised.includes(leak), `cohort value leaked ${leak}`);
  }
});

async function deriveOne(customerIdentities) {
  const result = await deriveMerchantMemoryBeliefs(mockPrisma(customerIdentities), {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const derivations = Array.isArray(result) ? result : (result.derivations ?? []);
  const skipped = Array.isArray(result) ? [] : (result.skippedOutcomes ?? []);
  const all = [...derivations.map((row) => ({ ...row, status: "CALCULATED" })), ...skipped];
  return all.find((outcome) => outcome.key === KEY);
}

/**
 * Build hashed identities directly. `lastOrderDaysAgo` defaults to recent so the recency
 * assertions only fire in the tests that set it.
 */
function identities({ oneTime, returning, loyal, spendPerOrder, gapDays, lastOrderDaysAgo = 2 }) {
  const now = Date.now();
  const rows = [];
  const push = (orderCount, index, group) => {
    const last = now - lastOrderDaysAgo * DAY;
    // first = last minus the whole span this customer's orders cover, so the derived
    // average gap comes out at gapDays.
    const first = last - gapDays * (orderCount - 1) * DAY;
    rows.push({
      emailHash: `hash-${group}-${index}`,
      maskedEmail: `c***@example.com`,
      shopifyCustomerId: `customer-${group}-${index}`,
      orderCount,
      totalSpend: String(spendPerOrder * orderCount),
      averageOrderValue: String(spendPerOrder),
      firstSeenOrderAt: new Date(orderCount >= 2 ? first : last),
      lastOrderAt: new Date(last),
      rawPayload: {},
    });
  };
  for (let i = 0; i < oneTime; i += 1) push(1, i, "one");
  for (let i = 0; i < returning; i += 1) push(3, i, "ret");
  for (let i = 0; i < loyal; i += 1) push(6, i, "loyal");
  return rows;
}

function mockPrisma(customerIdentities) {
  const now = Date.now();
  const products = [{ id: "product-1", title: "Product 1", status: "ACTIVE", productType: "Goods", vendor: "House" }];
  const variants = [
    {
      id: "variant-1",
      productId: "product-1",
      sku: "SKU-1",
      title: "V1",
      price: "40.00",
      currency: "GBP",
      inventoryItemExternalId: "inv-1",
    },
  ];
  // Enough orders to keep the surrounding beliefs out of insufficient-data territory; this
  // belief reads identities, not orders.
  const orders = Array.from({ length: 40 }, (_, i) => {
    const at = new Date(now - (1 + (i % 79)) * DAY);
    return {
      id: `order-${i + 1}`,
      externalId: `ext-order-${i + 1}`,
      currency: "GBP",
      totalPrice: "40.00",
      totalDiscount: "0.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `customer-${i + 1}`,
      financialStatus: "PAID",
      sourceName: "web",
      shippingCountry: "GB",
      discountCodes: [],
      discountApplications: [],
    };
  });

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
            connectorAccounts: [{ scopes: ["read_orders", "read_customers"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => products },
    variant: { findMany: async () => variants },
    order: { findMany: async () => orders },
    orderLineItem: {
      findMany: async () =>
        orders.map((order) => ({
          orderId: order.id,
          productId: "product-1",
          variantId: "variant-1",
          quantity: 1,
          unitPrice: "40.00",
          totalPrice: "40.00",
        })),
    },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => customerIdentities },
    inventoryLevel: {
      findMany: async () => [
        {
          variantId: "variant-1",
          available: 5,
          inventoryItemExternalId: "inv-1",
          locationExternalId: "location-one",
          sourceUpdatedAt: new Date(now - 3600000),
          observedAt: new Date(now - 3600000),
        },
      ],
    },
  };
}
