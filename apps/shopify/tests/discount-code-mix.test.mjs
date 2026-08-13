import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { extractDiscountIdentity } from "../app/lib/ingestion/shopify/canonical.server.js";

// `total_discount` could always say a store gives away 14% of gross. It could never say
// WHICH offer did it — so "customers are redeeming a summer code" and "everything is 10%
// off automatically, forever" were the same number. They are opposite facts: one is a
// campaign with a response rate, the other is margin leaving quietly.

const KEY = "business.discount_code_mix.trailing_90d";

test("discount identity is normalised the same from GraphQL and from webhooks", () => {
  // Two transports, two shapes, and a belief that must not care which one it got.
  const graphql = extractDiscountIdentity({
    discountCodes: ["SUMMER20"],
    discountApplications: {
      nodes: [
        { code: "SUMMER20", allocationMethod: "ACROSS", targetType: "LINE_ITEM" },
        { title: "Site-wide 10%", allocationMethod: "EACH", targetType: "LINE_ITEM" },
      ],
    },
  });
  const rest = extractDiscountIdentity({
    discount_codes: [{ code: "SUMMER20", amount: "8.00", type: "percentage" }],
    discount_applications: [
      { code: "SUMMER20", allocation_method: "across", target_type: "line_item" },
      { title: "Site-wide 10%", type: "automatic", allocation_method: "each", target_type: "line_item" },
    ],
  });

  assert.deepEqual(graphql.codes, ["SUMMER20"]);
  assert.deepEqual(rest.codes, ["SUMMER20"]);

  for (const identity of [graphql, rest]) {
    assert.equal(identity.applications.length, 2);
    // The distinction the whole belief rests on: one was typed, one was not.
    assert.equal(identity.applications[0].kind, "code");
    assert.equal(identity.applications[0].label, "SUMMER20");
    assert.notEqual(identity.applications[1].kind, "code");
    assert.equal(identity.applications[1].label, "Site-wide 10%");
  }
});

test("a code seen only in the applications union still counts as redeemed", () => {
  // Shopify does not always populate `discountCodes`; the union is the other side of the
  // same redemption and dropping it would undercount real campaigns.
  const identity = extractDiscountIdentity({
    discountApplications: { nodes: [{ code: "WELCOME10" }] },
  });
  assert.deepEqual(identity.codes, ["WELCOME10"]);
});

test("an order with no discount produces no phantom offer", () => {
  const identity = extractDiscountIdentity({ discountCodes: [], discountApplications: { nodes: [] } });
  assert.deepEqual(identity.codes, []);
  assert.deepEqual(identity.applications, []);
});

test("Jefe names the offers doing the discounting, and says which were typed", async () => {
  const belief = await deriveOne({
    orderCount: 40,
    // Two thirds of discounted orders used a code the customer entered; the rest were an
    // automatic site-wide discount nobody chose.
    identityFor: (i) =>
      i % 3 === 0
        ? { codes: [], applications: [{ label: "Always 10% off", kind: "automatic" }] }
        : { codes: ["SUMMER20"], applications: [{ label: "SUMMER20", kind: "code" }] },
  });

  assert.equal(belief?.status, "CALCULATED", "the belief did not derive");
  const labels = belief.value.offers.map((offer) => offer.label);
  assert.ok(labels.includes("SUMMER20"));
  assert.ok(labels.includes("Always 10% off"));
  // The split is the point: a merchant seeing 33% automatic is looking at a standing price
  // cut, not a campaign.
  assert.ok(belief.value.typedCodeOrderSharePercent > 60);
  assert.ok(belief.value.automaticOrderSharePercent > 25);
  assert.equal(belief.value.distinctOffers, 2);
});

test("a store whose discounts predate identity capture gets silence, not 'runs no campaigns'", async () => {
  // ⛔ The failure this guards against. Orders ingested before the discount-identity
  // migration carry [] — which at the column level is indistinguishable from "this order
  // had no discount". Reading a code mix across those would confidently report a store
  // running no promotions, when in fact it runs several and we simply never asked.
  const belief = await deriveOne({
    orderCount: 40,
    identityFor: (i) =>
      i % 5 === 0
        ? { codes: ["SUMMER20"], applications: [{ label: "SUMMER20", kind: "code" }] }
        : { codes: [], applications: [] },
  });

  assert.notEqual(belief?.status, "CALCULATED", "asserted a code mix on mostly-unidentified orders");
  assert.equal(belief?.status, "BLOCKED_BY_MISSING_SOURCE");
  // The diagnostic has to name the coverage, or nobody can tell "no campaigns" apart from
  // "we never asked" when they come to debug it.
  assert.ok(belief.observedCounts.discountIdentityCoverage < 0.7);
  assert.equal(belief.observedCounts.identifiedOrders, 8);
});

async function deriveOne(spec) {
  const result = await deriveMerchantMemoryBeliefs(mockPrisma(spec), {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const derivations = Array.isArray(result) ? result : (result.derivations ?? []);
  const skipped = Array.isArray(result) ? [] : (result.skippedOutcomes ?? []);
  const all = [...derivations.map((row) => ({ ...row, status: "CALCULATED" })), ...skipped];
  return all.find((outcome) => outcome.key === KEY);
}

function mockPrisma({ orderCount, identityFor }) {
  const now = Date.now();
  const products = [{ id: "product-1", title: "Product 1", status: "ACTIVE", productType: "Goods", vendor: "House" }];
  const variants = [
    {
      id: "variant-1",
      productId: "product-1",
      sku: "SKU-1",
      title: "V1",
      price: "80.00",
      currency: "GBP",
      inventoryItemExternalId: "inv-1",
    },
  ];
  const orders = Array.from({ length: orderCount }, (_, i) => {
    const at = new Date(now - (1 + (i % 79)) * 86400000);
    const identity = identityFor(i);
    // Every order in these fixtures is discounted, so the denominator the belief cares
    // about — discounted orders — is the whole set, and coverage is purely about how many
    // of them we can name an offer for.
    return {
      id: `order-${i + 1}`,
      externalId: `ext-order-${i + 1}`,
      currency: "GBP",
      totalPrice: "80.00",
      totalDiscount: "8.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `customer-${i + 1}`,
      financialStatus: "PAID",
      sourceName: "web",
      shippingCountry: "GB",
      discountCodes: identity.codes,
      discountApplications: identity.applications,
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
          unitPrice: "80.00",
          totalPrice: "80.00",
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
