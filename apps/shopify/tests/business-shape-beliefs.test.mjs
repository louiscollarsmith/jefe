import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { isMerchantVisibleBeliefKey } from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";

// The ontology could describe a lipstick DTC brand and a Tesla dealership identically, so
// every recommendation came out generic by construction. These beliefs describe what KIND of
// business it is. The test that matters is not "does it produce a label" — it's "do two
// genuinely different businesses get different labels", because a dimension that collapses
// to the same answer for everyone adds nothing.

const CHANNEL = "business.channel_mix.trailing_90d";
const CATALOGUE = "business.catalogue_shape";
const CADENCE = "business.purchase_cadence.all_stored_history";

test("two different businesses get different shapes from the same ontology", async () => {
  // A subscription-ish coffee brand: few products, online, customers back every few weeks.
  const coffee = await shapeOf({
    productCount: 6,
    variantsPerProduct: 2,
    sourceNames: ["web"],
    repeatEveryDays: 14,
    customerCount: 40,
    orderCount: 120,
  });
  // A furniture shop: wide range, sells in person too, customers rarely return.
  const furniture = await shapeOf({
    productCount: 400,
    variantsPerProduct: 1,
    sourceNames: ["web", "web", "pos", "pos"],
    repeatEveryDays: null,
    customerCount: 110,
    orderCount: 120,
  });

  assert.equal(coffee[CATALOGUE], "focused");
  assert.equal(furniture[CATALOGUE], "long_tail");

  assert.equal(coffee[CHANNEL], "online_only");
  assert.notEqual(furniture[CHANNEL], "online_only");

  assert.equal(coffee[CADENCE], "frequent");
  assert.equal(furniture[CADENCE], "one_off");
});

test("a trade-heavy merchant reads as wholesale, not as a quiet online shop", async () => {
  const shape = await shapeOf({
    productCount: 30,
    variantsPerProduct: 1,
    // Draft orders are how most merchants invoice trade customers — Shopify has no
    // wholesale source name, so this is the honest proxy and the value says so.
    sourceNames: ["shopify_draft_order", "shopify_draft_order", "web"],
    repeatEveryDays: 45,
    customerCount: 30,
    orderCount: 90,
  });
  assert.equal(shape[CHANNEL], "wholesale_led");
});

test("a channel mix is withheld when too few orders record their channel", async () => {
  // Orders backfilled before sourceName capture carry nothing. A mix read off a third of the
  // orders is a guess wearing a label, so Jefe should decline rather than assert.
  const outcomes = await derive({
    productCount: 10,
    variantsPerProduct: 1,
    sourceNames: [null, null, null, "web"],
    repeatEveryDays: 30,
    customerCount: 30,
    orderCount: 100,
  });
  const channel = outcomes.find((outcome) => outcome.key === CHANNEL);
  assert.notEqual(String(channel?.status ?? ""), "CALCULATED");
});

test("a business nobody returns to is a finding, not missing data", async () => {
  // "No repeat customers" is exactly the sort of thing a merchant needs advice about. It
  // must come out as one_off, not as an absent belief.
  const shape = await shapeOf({
    productCount: 12,
    variantsPerProduct: 1,
    sourceNames: ["web"],
    repeatEveryDays: null,
    customerCount: 120,
    orderCount: 120,
  });
  assert.equal(shape[CADENCE], "one_off");
});

test("every shape belief reports the evidence behind its label, not just the label", async () => {
  // A merchant can only correct a wrong read if they can see what it rests on.
  const outcomes = await derive({
    productCount: 40,
    variantsPerProduct: 3,
    sourceNames: ["web", "pos"],
    repeatEveryDays: 30,
    customerCount: 40,
    orderCount: 120,
  });
  for (const key of [CHANNEL, CATALOGUE, CADENCE]) {
    const belief = outcomes.find((outcome) => outcome.key === key);
    assert.ok(belief, `${key} did not derive`);
    const fields = Object.keys(belief.value ?? {});
    assert.ok(fields.includes("enum"), `${key} has no label`);
    assert.ok(fields.length > 2, `${key} states a label with no supporting numbers`);
  }
});

test("business-shape beliefs derive but are not yet shown to merchants", async () => {
  // Founder call: these run against real stores and get reviewed before any merchant is told
  // what kind of business Jefe thinks they run. The memory view renders every active belief,
  // so this has to be a real gate rather than an intention.
  for (const key of [CHANNEL, CATALOGUE, CADENCE]) {
    assert.equal(isMerchantVisibleBeliefKey(key), false, `${key} would render today`);
  }
  // ...and the gate must not have swallowed anything else.
  assert.equal(isMerchantVisibleBeliefKey("business.store_name"), true);
  assert.equal(isMerchantVisibleBeliefKey("orders.average_order_value.all_time"), true);
});

async function shapeOf(spec) {
  const outcomes = await derive(spec);
  const shape = {};
  for (const key of [CHANNEL, CATALOGUE, CADENCE]) {
    shape[key] = outcomes.find((outcome) => outcome.key === key)?.value?.enum ?? null;
  }
  return shape;
}

async function derive(spec) {
  const result = await deriveMerchantMemoryBeliefs(mockPrisma(spec), {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const derivations = Array.isArray(result) ? result : result.derivations ?? [];
  const skipped = Array.isArray(result) ? [] : result.skippedOutcomes ?? [];
  return [...derivations.map((row) => ({ ...row, status: "CALCULATED" })), ...skipped];
}

function mockPrisma({
  productCount,
  variantsPerProduct,
  sourceNames,
  repeatEveryDays,
  customerCount,
  orderCount,
}) {
  const now = Date.now();
  const products = Array.from({ length: productCount }, (_, i) => ({
    id: `product-${i + 1}`,
    title: `Product ${i + 1}`,
    status: "ACTIVE",
    productType: "Goods",
    vendor: "House",
  }));
  const variants = products.flatMap((product, p) =>
    Array.from({ length: variantsPerProduct }, (_, v) => ({
      id: `variant-${p + 1}-${v + 1}`,
      productId: product.id,
      sku: `SKU-${p + 1}-${v + 1}`,
      title: `V${v + 1}`,
      price: "25.00",
      currency: "GBP",
      inventoryItemExternalId: `inv-${p + 1}-${v + 1}`,
    })),
  );
  // Spread orders over the last 80 days so they land inside the 90-day windows. When
  // repeatEveryDays is set, customers recur at that interval; otherwise every order is a
  // distinct customer and nobody comes back.
  const orders = Array.from({ length: orderCount }, (_, i) => {
    const customerIndex = repeatEveryDays == null ? i : i % customerCount;
    const repeatRound = repeatEveryDays == null ? 0 : Math.floor(i / customerCount);
    const daysAgo = repeatEveryDays == null
      ? 1 + (i % 79)
      : Math.max(1, 79 - repeatRound * repeatEveryDays - (customerIndex % 3));
    const at = new Date(now - daysAgo * 86400000);
    return {
      id: `order-${i + 1}`,
      externalId: `ext-order-${i + 1}`,
      currency: "GBP",
      totalPrice: "80.00",
      totalDiscount: "0.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `customer-${customerIndex + 1}`,
      financialStatus: "PAID",
      sourceName: sourceNames[i % sourceNames.length],
      shippingCountry: "GB",
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
        orders.map((order, i) => ({
          orderId: order.id,
          productId: products[i % products.length].id,
          variantId: variants[i % variants.length].id,
          quantity: 1,
          unitPrice: "80.00",
          totalPrice: "80.00",
        })),
    },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: {
      findMany: async () =>
        variants.map((variant, i) => ({
          variantId: variant.id,
          available: 5 + (i % 4),
          inventoryItemExternalId: variant.inventoryItemExternalId,
          locationExternalId: "location-one",
          sourceUpdatedAt: new Date(now - 3600000),
          observedAt: new Date(now - 3600000),
        })),
    },
  };
}
