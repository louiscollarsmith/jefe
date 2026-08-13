import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";

// acquisition_mix says where orders come from. cohort_mix says who comes back. Neither can
// say whether the channel bringing the most customers brings the ones who STAY — which is
// the question that decides where the money goes.

const KEY = "business.channel_quality.all_stored_history";
const DAY = 86400000;

test("a channel that brings volume is told apart from one that brings returners", async () => {
  // Instagram brings twice as many customers; almost none come back. Email brings fewer who
  // mostly do. A merchant reading only order counts would spend on exactly the wrong one.
  const belief = await deriveOne([
    ...customers({ n: 30, channel: "instagram.com", orders: 1, firstOrderDaysAgo: 120 }),
    ...customers({ n: 15, channel: "klaviyo", medium: "email", orders: 3, firstOrderDaysAgo: 120 }),
  ]);

  assert.equal(belief?.status, "CALCULATED", "channel quality did not derive");
  const byChannel = Object.fromEntries(belief.value.channels.map((c) => [c.channel, c]));

  assert.ok(byChannel.social.customers > byChannel.email.customers, "fixture should give social more customers");
  assert.equal(byChannel.social.repeatRatePercent, 0);
  assert.equal(byChannel.email.repeatRatePercent, 100);
  assert.ok(byChannel.email.averageLifetimeSpend > byChannel.social.averageLifetimeSpend);
});

test("the value refuses to be read as this store's repeat rate", async () => {
  // ⛔ The methodological trap. Attribution only exists for customers acquired since ingest
  // was switched on, so they are all recent and most have not had time to return. The
  // repeat rates are FLOORS. Anything quoting one as "your repeat rate" is badly wrong, so
  // the value has to say what it is rather than relying on a doc nobody opens.
  const belief = await deriveOne([
    ...customers({ n: 15, channel: "google", orders: 1, firstOrderDaysAgo: 60 }),
    ...customers({ n: 15, channel: "klaviyo", medium: "email", orders: 2, firstOrderDaysAgo: 60 }),
  ]);

  assert.equal(belief.value.basis, "comparative_between_channels_only");
  assert.equal(belief.value.repeatRatesAre, "floors_truncated_by_observation_window");
  assert.equal(belief.value.maturityDays, 30);
});

test("customers too new to have come back are excluded, not counted as non-returners", async () => {
  // A channel that is busy THIS WEEK would otherwise look terrible: its customers have had
  // no chance to reorder. That would recommend cutting spend on whatever is currently working.
  const withFresh = await deriveOne([
    ...customers({ n: 15, channel: "google", orders: 2, firstOrderDaysAgo: 90 }),
    ...customers({ n: 15, channel: "klaviyo", medium: "email", orders: 2, firstOrderDaysAgo: 90 }),
    // 40 customers acquired 5 days ago via paid, none of whom could possibly have returned.
    ...customers({ n: 40, channel: "google", medium: "cpc", orders: 1, firstOrderDaysAgo: 5 }),
  ]);

  const paid = withFresh.value.channels.find((c) => c.channel === "paid");
  assert.equal(paid, undefined, "customers younger than the maturity window were counted");
  assert.equal(withFresh.value.matureCustomers, 30);
});

test("one channel is not a comparison", async () => {
  // Reporting "email: 40% repeat" with nothing to compare it against invites reading it as
  // an absolute, which is exactly what this belief must never support.
  const belief = await deriveOne(
    customers({ n: 30, channel: "klaviyo", medium: "email", orders: 2, firstOrderDaysAgo: 90 }),
  );
  assert.notEqual(belief?.status, "CALCULATED");
});

test("a store whose customers predate attribution gets silence", async () => {
  const belief = await deriveOne([
    ...customers({ n: 25, channel: null, orders: 2, firstOrderDaysAgo: 200 }),
    ...customers({ n: 5, channel: "klaviyo", medium: "email", orders: 2, firstOrderDaysAgo: 200 }),
  ]);
  assert.notEqual(belief?.status, "CALCULATED");
  assert.equal(belief?.status, "BLOCKED_BY_MISSING_SOURCE");
  assert.ok(belief.observedCounts.attributionCoverage < 0.7);
});

async function deriveOne(orders) {
  const result = await deriveMerchantMemoryBeliefs(mockPrisma(orders), {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const derivations = Array.isArray(result) ? result : (result.derivations ?? []);
  const skipped = Array.isArray(result) ? [] : (result.skippedOutcomes ?? []);
  const all = [...derivations.map((row) => ({ ...row, status: "CALCULATED" })), ...skipped];
  return all.find((outcome) => outcome.key === KEY);
}

let seq = 0;
/** Each customer gets `orders` orders; the earliest carries the acquisition journey. */
function customers({ n, channel, medium = null, orders, firstOrderDaysAgo }) {
  const now = Date.now();
  const rows = [];
  for (let c = 0; c < n; c += 1) {
    const customerId = `gid://shopify/Customer/${(seq += 1)}`;
    for (let o = 0; o < orders; o += 1) {
      // Later orders sit between the first order and now, so the first is unambiguous.
      const daysAgo = firstOrderDaysAgo - o * Math.max(1, Math.floor(firstOrderDaysAgo / (orders + 1)));
      const at = new Date(now - daysAgo * DAY);
      rows.push({
        id: `order-${seq}-${o}`,
        externalId: `ext-${seq}-${o}`,
        currency: "GBP",
        totalPrice: "50.00",
        totalDiscount: "0.00",
        totalTax: "0.00",
        totalShipping: "0.00",
        processedAt: at,
        sourceCreatedAt: at,
        sourceUpdatedAt: at,
        customerExternalId: customerId,
        financialStatus: "PAID",
        sourceName: "web",
        shippingCountry: "GB",
        discountCodes: [],
        discountApplications: [],
        // Only the FIRST order carries the journey, as Shopify supplies it.
        attribution:
          o === 0 && channel != null
            ? { firstVisit: { source: channel, utmMedium: medium } }
            : {},
      });
    }
  }
  return rows;
}

function mockPrisma(orders) {
  const now = Date.now();
  const products = [{ id: "product-1", title: "Product 1", status: "ACTIVE", productType: "Goods", vendor: "House" }];
  const variants = [
    {
      id: "variant-1",
      productId: "product-1",
      sku: "SKU-1",
      title: "V1",
      price: "50.00",
      currency: "GBP",
      inventoryItemExternalId: "inv-1",
    },
  ];
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
          unitPrice: "50.00",
          totalPrice: "50.00",
        })),
    },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
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
