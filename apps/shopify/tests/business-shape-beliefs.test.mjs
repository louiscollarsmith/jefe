import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { isMerchantVisibleBeliefKey, isBusinessShapeBeliefKey } from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";
import { selectPromptBeliefs } from "../app/lib/merchant-memory/conversation.server.js";

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

const BANDS = "business.order_value_bands.trailing_90d";
const FOOTPRINT = "business.delivery_footprint.trailing_90d";
const CONSIDERATION = "business.purchase_consideration.trailing_90d";

test("order-value bands describe the merchant's own spread, in their own currency", async () => {
  // Same shape, different currency. A cross-merchant "premium/budget" threshold would label
  // these two differently for no reason but the currency; describing each against itself
  // cannot. That is why this is a spread, not a verdict.
  const pounds = await derive({ ...baseSpec(), orderValues: spread(), currency: "GBP" });
  const yen = await derive({ ...baseSpec(), orderValues: spread().map((v) => v * 190), currency: "JPY" });

  const gbp = pounds.find((o) => o.key === BANDS);
  const jpy = yen.find((o) => o.key === BANDS);

  assert.equal(gbp?.value?.enum, jpy?.value?.enum);
  assert.equal(gbp?.value?.currency, "GBP");
  assert.equal(jpy?.value?.currency, "JPY");
  assert.ok(gbp?.value?.typicalOrderValue > 0);
});

test("a long tail of big orders reads differently from a merely wide spread", async () => {
  // A few orders many times the typical size usually means trade buyers inside a retail
  // order book — a different business from one that simply sells a wide price range.
  const tail = await derive({
    ...baseSpec(),
    orderValues: [...Array.from({ length: 45 }, () => 40), ...Array.from({ length: 5 }, () => 900)],
  });
  const tight = await derive({
    ...baseSpec(),
    orderValues: Array.from({ length: 50 }, (_, i) => 40 + (i % 5)),
  });

  assert.equal(tail.find((o) => o.key === BANDS)?.value?.enum, "long_tail");
  assert.equal(tight.find((o) => o.key === BANDS)?.value?.enum, "tight_band");
});

test("delivery footprint separates a single market from an international one", async () => {
  const domestic = await derive({ ...baseSpec(), countries: ["GB"] });
  const global = await derive({
    ...baseSpec(),
    countries: ["GB", "US", "DE", "FR", "ES", "IT", "NL", "SE", "AU", "CA", "JP", "IE"],
  });

  assert.equal(domestic.find((o) => o.key === FOOTPRINT)?.value?.enum, "single_market");
  assert.equal(global.find((o) => o.key === FOOTPRINT)?.value?.enum, "international");
});

test("the top destination is reported as the primary market, never assumed to be home", async () => {
  // Jefe does not store the shop's own country, so calling the top destination "domestic"
  // would be an assumption presented as a fact.
  const outcomes = await derive({ ...baseSpec(), countries: ["DE", "DE", "DE", "GB"] });
  const footprint = outcomes.find((o) => o.key === FOOTPRINT);
  assert.equal(footprint?.value?.primaryMarket, "DE");
  assert.equal(Object.keys(footprint?.value ?? {}).includes("domestic"), false);
});

test("considered and habitual buying are told apart, and a mixed signal stays mixed", async () => {
  // One expensive item, nobody comes back → considered.
  const considered = await derive({
    ...baseSpec(),
    orderValues: Array.from({ length: 50 }, () => 600),
    itemsPerOrder: 1,
    variantPrice: "300.00",
    repeatEveryDays: null,
    customerCount: 50,
  });
  // Small baskets of several ordinary items, customers return constantly → habitual.
  const habitual = await derive({
    ...baseSpec(),
    orderValues: Array.from({ length: 50 }, () => 30),
    itemsPerOrder: 3,
    variantPrice: "10.00",
    repeatEveryDays: 14,
    customerCount: 8,
  });

  assert.equal(considered.find((o) => o.key === CONSIDERATION)?.value?.enum, "considered");
  assert.equal(habitual.find((o) => o.key === CONSIDERATION)?.value?.enum, "habitual");
});

test("consideration falls back to mixed rather than guessing when signals disagree", async () => {
  // Single expensive items, but customers return often — that is a real business (a jeweller
  // with loyal buyers) and neither label fits. Saying "mixed" beats inventing a verdict.
  const outcomes = await derive({
    ...baseSpec(),
    orderValues: Array.from({ length: 50 }, () => 600),
    itemsPerOrder: 1,
    variantPrice: "300.00",
    repeatEveryDays: 14,
    customerCount: 8,
  });
  assert.equal(outcomes.find((o) => o.key === CONSIDERATION)?.value?.enum, "mixed");
});

const RANGE = "business.range_composition";

test("an own-brand maker and a multi-brand retailer are told apart", async () => {
  // Both could turn identical revenue from identical order counts. They need opposite advice
  // about range, stock and clearance, and the ontology could not tell them apart at all.
  const maker = await derive({
    ...baseSpec(),
    productTypes: ["Candles"],
    vendors: ["Tin & Tide"],
  });
  const retailer = await derive({
    ...baseSpec(),
    productTypes: ["Boots", "Jackets", "Rucksacks", "Tents", "Stoves"],
    vendors: ["Berghaus", "Rab", "Osprey", "MSR", "Vango"],
  });

  assert.equal(maker.find((o) => o.key === RANGE)?.value?.enum, "own_brand_specialist");
  assert.equal(retailer.find((o) => o.key === RANGE)?.value?.enum, "multi_brand_retailer");
});

test("a specialist stocking many brands is not the same as a general retailer", async () => {
  // A running shop: one category, everyone else's brands. Collapsing this into
  // "multi_brand_retailer" would lose the thing that makes the advice specific.
  const outcomes = await derive({
    ...baseSpec(),
    productTypes: ["Running shoes"],
    vendors: ["Asics", "Hoka", "Saucony", "Brooks", "New Balance"],
  });
  assert.equal(outcomes.find((o) => o.key === RANGE)?.value?.enum, "multi_brand_specialist");
});

test("a range is not described when the merchant never filled in type or vendor", async () => {
  // Shopify leaves both optional. Reading a range off a third of the catalogue would be a
  // guess about someone's business, so Jefe declines rather than asserts.
  const outcomes = await derive({
    ...baseSpec(),
    productTypes: [null, null, null, "Candles"],
    vendors: [null, null, null, "Tin & Tide"],
  });
  const range = outcomes.find((o) => o.key === RANGE);
  assert.notEqual(String(range?.status ?? ""), "CALCULATED");
});

test("the brand read is reported as a proxy, with the numbers behind it", async () => {
  // A merchant may simply put their shop name on every product, so "own brand" is an
  // inference from vendor concentration — it has to be correctable, which means visible.
  const outcomes = await derive({ ...baseSpec(), productTypes: ["Candles"], vendors: ["Tin & Tide"] });
  const value = outcomes.find((o) => o.key === RANGE)?.value ?? {};
  assert.equal(value.brandModelIsProxy, "vendor_concentration");
  assert.equal(typeof value.leadingBrandShare, "number");
  assert.equal(typeof value.brandCount, "number");
  assert.equal(value.leadingCategory, "Candles");
});

function baseSpec() {
  return {
    productCount: 12,
    variantsPerProduct: 2,
    sourceNames: ["web"],
    repeatEveryDays: 30,
    customerCount: 30,
    orderCount: 50,
  };
}

function spread() {
  return Array.from({ length: 50 }, (_, i) => 20 + i * 4);
}

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
  orderValues = null,
  currency = "GBP",
  countries = ["GB"],
  itemsPerOrder = 1,
  variantPrice = "25.00",
  productTypes = ["Goods"],
  vendors = ["House"],
}) {
  const count = orderValues ? orderValues.length : orderCount;
  const now = Date.now();
  const products = Array.from({ length: productCount }, (_, i) => ({
    id: `product-${i + 1}`,
    title: `Product ${i + 1}`,
    status: "ACTIVE",
    productType: productTypes[i % productTypes.length],
    vendor: vendors[i % vendors.length],
  }));
  const variants = products.flatMap((product, p) =>
    Array.from({ length: variantsPerProduct }, (_, v) => ({
      id: `variant-${p + 1}-${v + 1}`,
      productId: product.id,
      sku: `SKU-${p + 1}-${v + 1}`,
      title: `V${v + 1}`,
      price: variantPrice,
      currency,
      inventoryItemExternalId: `inv-${p + 1}-${v + 1}`,
    })),
  );
  // Spread orders over the last 80 days so they land inside the 90-day windows. When
  // repeatEveryDays is set, customers recur at that interval; otherwise every order is a
  // distinct customer and nobody comes back.
  const orders = Array.from({ length: count }, (_, i) => {
    const customerIndex = repeatEveryDays == null ? i : i % customerCount;
    const repeatRound = repeatEveryDays == null ? 0 : Math.floor(i / customerCount);
    const daysAgo = repeatEveryDays == null
      ? 1 + (i % 79)
      : Math.max(1, 79 - repeatRound * repeatEveryDays - (customerIndex % 3));
    const at = new Date(now - daysAgo * 86400000);
    return {
      id: `order-${i + 1}`,
      externalId: `ext-order-${i + 1}`,
      currency,
      totalPrice: orderValues ? String(orderValues[i]) + ".00" : "80.00",
      totalDiscount: "0.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `customer-${customerIndex + 1}`,
      financialStatus: "PAID",
      sourceName: sourceNames[i % sourceNames.length],
      shippingCountry: countries[i % countries.length],
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
          quantity: itemsPerOrder,
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

// --- Reaching the model -----------------------------------------------------------------
// A representation that never reaches the LLM changes nothing. The prompt has 40 slots for
// ~140 beliefs, ranked by keyword relevance to the merchant's message — so shape beliefs,
// which by design match no keyword, were scoring on confidence alone (~8) and losing every
// slot. Derived, stored, and never once seen by the model.

test("business shape reaches the model even when the merchant asks about something else", () => {
  const shape = [
    { key: "business.channel_mix.trailing_90d", value: { enum: "online_led" }, confidence: 0.85 },
    { key: "business.catalogue_shape", value: { enum: "focused" }, confidence: 0.9 },
    { key: "business.range_composition", value: { enum: "own_brand_specialist" }, confidence: 0.8 },
  ];
  // 60 unrelated beliefs, enough to fill every slot on their own.
  const noise = Array.from({ length: 60 }, (_, i) => ({
    key: `orders.filler_metric_${i}`,
    value: { count: i },
    confidence: 0.9,
  }));

  const selected = selectPromptBeliefs(
    { beliefs: [...noise, ...shape], message: "how much stock do I have left?", context: {} },
    100_000,
  );
  const keys = new Set(selected.map((belief) => belief.key));

  for (const belief of shape) {
    assert.ok(keys.has(belief.key), `${belief.key} never reached the prompt`);
  }
});

test("shape frames the answer but never displaces what is being discussed", () => {
  // The boost must not outrank the belief the merchant is actually talking about — context
  // that shoves aside the subject is worse than no context.
  const discussed = { key: "inventory.low_cover_products.trailing_30d", value: { items: [] }, confidence: 0.5 };
  const shape = { key: "business.catalogue_shape", value: { enum: "focused" }, confidence: 0.9 };

  const selected = selectPromptBeliefs(
    {
      beliefs: [shape, discussed],
      message: "what should I reorder?",
      context: { lastDiscussedBeliefKeys: [discussed.key] },
    },
    100_000,
  );
  assert.equal(selected.length, 2);

  // Ranking is asserted through scoring order, not the emitted (key-sorted) array.
  const rankOf = (key) =>
    promptBeliefScoreFor(key, key === discussed.key ? 0.5 : 0.9, key === discussed.key);
  assert.ok(
    rankOf(discussed.key) > rankOf(shape.key),
    "a shape belief outranked the belief under discussion",
  );
});

// Mirrors promptBeliefScore's inputs closely enough to compare two beliefs' priority.
function promptBeliefScoreFor(key, confidence, isDiscussed) {
  return (
    (isDiscussed ? 100 : 0) +
    (isBusinessShapeBeliefKey(key) ? 25 : 0) +
    Math.round(confidence * 10)
  );
}
