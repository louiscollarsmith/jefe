import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { extractOrderAttribution } from "../app/lib/ingestion/shopify/canonical.server.js";
import { buildOrdersQuery, ORDERS_QUERY } from "../app/lib/shopify/queries.server.js";

// Jefe could describe what a store sold in enormous detail and never why anyone turned up.
// "Is the ad spend working" was not a question it could engage with at all.

const KEY = "business.acquisition_mix.trailing_90d";

test("the journey fields are only requested when the flag is on", () => {
  // ⛔ The flag guards the QUERY, not just the write. Requesting a field the app isn't
  // approved for fails the WHOLE request — that would take down order backfill for every
  // store, not just attribution. Flag off must mean byte-identical to before.
  const previous = process.env.ORDER_ATTRIBUTION_INGEST_ENABLED;
  try {
    delete process.env.ORDER_ATTRIBUTION_INGEST_ENABLED;
    assert.equal(buildOrdersQuery(), ORDERS_QUERY);
    assert.ok(!buildOrdersQuery().includes("customerJourneySummary"));

    process.env.ORDER_ATTRIBUTION_INGEST_ENABLED = "true";
    const on = buildOrdersQuery();
    assert.ok(on.includes("customerJourneySummary"));
    assert.ok(on.includes("utmParameters"));
    assert.ok(on.includes("referralCode"));

    // Anything other than the exact string "true" is off — same discipline as the execute flags.
    process.env.ORDER_ATTRIBUTION_INGEST_ENABLED = "1";
    assert.equal(buildOrdersQuery(), ORDERS_QUERY);
  } finally {
    if (previous === undefined) delete process.env.ORDER_ATTRIBUTION_INGEST_ENABLED;
    else process.env.ORDER_ATTRIBUTION_INGEST_ENABLED = previous;
  }
});

test("landing pages are stored without their query string", () => {
  // ⛔ Landing URLs routinely carry personal data — an email in a newsletter link, a token,
  // a name in a gift param. None of it is needed to know someone arrived from a campaign,
  // and keeping it would quietly turn an attribution column into a PII column.
  const attribution = extractOrderAttribution({
    customerJourneySummary: {
      firstVisit: {
        source: "klaviyo",
        landingPage: "https://shop.example.com/products/beans?email=someone%40example.com&utm_campaign=spring",
        utmParameters: { source: "klaviyo", medium: "email", campaign: "spring" },
      },
    },
  });

  const path = attribution.firstVisit.landingPath;
  assert.equal(path, "shop.example.com/products/beans");
  assert.ok(!path.includes("@"));
  assert.ok(!path.includes("email="));
  assert.ok(!path.includes("?"));
  // The campaign itself survives — it's the part that carries the meaning.
  assert.equal(attribution.firstVisit.utmCampaign, "spring");
});

test("an order with no journey yields nothing, not an empty-looking journey", () => {
  // {} must mean "never asked", so the belief can tell it apart from "came from nowhere".
  assert.deepEqual(extractOrderAttribution({ id: "gid://shopify/Order/1" }), {});
});

test("a declared paid medium outranks a source that looks organic", async () => {
  // ⛔ The most expensive misclassification available: filing paid traffic as organic makes
  // ad spend look free. utm_medium=cpc on a google source must read paid, not search.
  const belief = await deriveOne(() => ({
    firstVisit: { source: "google", utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-sale" },
  }));

  assert.equal(belief?.status, "CALCULATED");
  assert.equal(belief.value.paidSharePercent, 100);
  assert.equal(belief.value.searchSharePercent, 0);
});

test("Jefe separates paid, organic, social, email and direct", async () => {
  const belief = await deriveOne((i) => {
    if (i % 5 === 0) return { firstVisit: { source: "google", utmMedium: "cpc" } };
    if (i % 5 === 1) return { firstVisit: { source: "google" } };
    if (i % 5 === 2) return { firstVisit: { source: "instagram.com" } };
    if (i % 5 === 3) return { firstVisit: { source: "klaviyo", utmMedium: "email" } };
    return { firstVisit: { source: "an unknown source" } };
  });

  assert.equal(belief?.status, "CALCULATED");
  assert.equal(belief.value.paidSharePercent, 20);
  assert.equal(belief.value.searchSharePercent, 20);
  assert.equal(belief.value.socialSharePercent, 20);
  assert.equal(belief.value.emailSharePercent, 20);
  assert.equal(belief.value.directSharePercent, 20);
  assert.equal(belief.value.touch, "first");
  // The raw sources are reported too, so a merchant can correct the premise rather than
  // only argue with the label.
  assert.ok(belief.value.topSources.length > 1);
});

test("a store whose orders predate attribution gets silence, not '100% direct'", async () => {
  // ⛔ The failure this belief is most likely to commit. Orders ingested before the flag
  // carry {}, which is indistinguishable from "arrived from nowhere" — ungated, a perfectly
  // healthy store reads as entirely direct traffic and every acquisition conclusion drawn
  // from it is wrong.
  const belief = await deriveOne((i) => (i % 5 === 0 ? { firstVisit: { source: "google" } } : null));

  assert.notEqual(belief?.status, "CALCULATED");
  assert.equal(belief?.status, "BLOCKED_BY_MISSING_SOURCE");
  assert.ok(belief.observedCounts.attributionCoverage < 0.7);
});

async function deriveOne(attributionFor) {
  const result = await deriveMerchantMemoryBeliefs(mockPrisma(attributionFor), {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const derivations = Array.isArray(result) ? result : (result.derivations ?? []);
  const skipped = Array.isArray(result) ? [] : (result.skippedOutcomes ?? []);
  const all = [...derivations.map((row) => ({ ...row, status: "CALCULATED" })), ...skipped];
  return all.find((outcome) => outcome.key === KEY);
}

function mockPrisma(attributionFor) {
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
  const orders = Array.from({ length: 40 }, (_, i) => {
    const at = new Date(now - (1 + (i % 79)) * 86400000);
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
      attribution: attributionFor(i) ?? {},
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
          unitPrice: "40.00",
          totalPrice: "40.00",
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
