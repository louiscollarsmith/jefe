import assert from "node:assert/strict";
import test from "node:test";

import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";

// A merchant who sells internationally takes orders in many currencies. That is ordinary
// trading, not a data problem — and it never made their money unknowable, because every
// amount Jefe stores is Shopify `shopMoney`, already converted into the shop's own base
// currency at the rate that applied when the sale happened.
//
// Jefe used to refuse anyway: any money belief whose records carried more than one currency
// LABEL was skipped as "blocked by data quality". A skipped belief is invisible to the
// merchant — nothing renders it — so Jefe silently knew nothing about the money of any store
// selling abroad, and the refusal looked principled rather than broken.
//
// These tests pin the fix at the level that matters: beliefs come out, with a currency on
// them. The old behaviour is a silent regression — it removes beliefs rather than breaking
// anything — so without this it would come back unnoticed.

const MONEY_KEYS = [
  "orders.average_order_value.all_time",
  "business.revenue_per_active_day.trailing_90d",
  "catalog.variant_price_mean",
  "inventory.retail_value_of_available_stock",
];

test("a merchant selling in several currencies still gets money beliefs", async () => {
  const single = await derive(currencies(["GBP"]));
  const multi = await derive(currencies(["GBP", "USD", "EUR", "SEK", "AUD", "JPY"]));

  const singleMoney = moneyOutcomes(single);
  const multiMoney = moneyOutcomes(multi);

  assert.ok(singleMoney.length > 0, "expected the single-currency merchant to have money beliefs");
  // The whole point: selling abroad must not cost the merchant beliefs.
  assert.deepEqual(
    multiMoney.map((outcome) => outcome.key).sort(),
    singleMoney.map((outcome) => outcome.key).sort(),
  );
});

test("no money belief is ever skipped for having more than one currency", async () => {
  const outcomes = await derive(currencies(["GBP", "USD", "EUR", "SEK", "AUD", "JPY"]));

  const blamedOnCurrency = outcomes.filter((outcome) =>
    /currenc/i.test(String(outcome.reason ?? "")) &&
    String(outcome.status ?? "") !== "CALCULATED",
  );

  assert.deepEqual(
    blamedOnCurrency.map((outcome) => `${outcome.key}: ${outcome.reason}`),
    [],
    "a skipped belief blamed a currency — the refusal is back",
  );
});

test("money beliefs carry the currency they are stated in", async () => {
  const outcomes = await derive(currencies(["GBP", "USD", "EUR"]));

  // Labelling is what makes a shop-currency figure honest for an international seller:
  // "£45 average order" is true, but an unlabelled "45" invites the wrong reading. The
  // label is the honesty mechanism — not the refusal it replaced.
  const money = moneyOutcomes(outcomes);
  assert.ok(money.length > 0, "expected money beliefs to assert on");
  for (const outcome of money) {
    const currency = outcome.value?.currency;
    assert.ok(
      typeof currency === "string" && currency.length === 3,
      `${outcome.key} produced a money value with no currency label (got ${JSON.stringify(currency)})`,
    );
  }
});

test("every money belief is labelled with the currency Jefe says is primary", async () => {
  // Equal order counts per currency — the near-tie that exposed the split. `primary_currency`
  // read one set of records and the label stamped on money read another, so on a tie they
  // picked different winners and a merchant could be told their primary currency was GBP and
  // their average order was "€100" on the same screen. The belief is canonical: nothing Jefe
  // states may contradict it.
  const outcomes = await derive(currencies(["GBP", "USD", "EUR"]));

  const primary = outcomes.find((outcome) => outcome.key === "business.primary_currency");
  assert.ok(primary, "expected a primary-currency belief");
  const primaryCode = primary.value?.currency;

  const labelled = outcomes.filter(
    (outcome) => String(outcome.status ?? "") === "CALCULATED" && typeof outcome.value?.currency === "string",
  );
  const contradicting = labelled
    .filter((outcome) => outcome.value.currency !== primaryCode)
    .map((outcome) => `${outcome.key} says ${outcome.value.currency}, primary is ${primaryCode}`);

  assert.deepEqual(contradicting, []);
  assert.ok(labelled.length > 5, "expected a meaningful number of labelled money beliefs");
});

test("a fabricated variant currency cannot decide what currency Jefe states money in", async () => {
  // `Variant.currency` is NOT observed: ingestion reads it off a bare price scalar and falls
  // through to a hardcoded "GBP" for every variant of every merchant (normalize.server.js).
  // So a US store's variants all read GBP. This fixture reproduces exactly that — a
  // dollar-selling merchant whose variant rows claim GBP — and asserts the invented value
  // does not win. Counting it would be inferred data presented as observed.
  // A young US store: big catalogue, few sales. That ordering matters — with variants in the
  // vote, 60 fabricated GBP rows outvote 6 real USD orders and Jefe tells a dollar merchant
  // their primary currency is sterling.
  const outcomes = await derive({
    orderCurrencies: ["USD"],
    orderCount: 6,
    variantCount: 60,
    variantCurrency: "GBP", // what ingestion actually writes, whatever the merchant trades in
  });

  const primary = outcomes.find((outcome) => outcome.key === "business.primary_currency");
  assert.equal(primary?.value?.currency, "USD");

  const labelled = outcomes.filter(
    (outcome) => String(outcome.status ?? "") === "CALCULATED" && typeof outcome.value?.currency === "string",
  );
  assert.deepEqual(
    labelled.filter((outcome) => outcome.value.currency !== "USD").map((outcome) => outcome.key),
    [],
  );
});

test("a merchant with no orders at all is short of data, not guilty of bad data", async () => {
  const outcomes = await derive({ orderCurrencies: [], variantCurrency: "GBP" });

  // The guard still fires when there is nothing priced to read a currency from — but that
  // is an empty store, and telling a brand-new merchant their currencies are unsupported
  // would be both false and discouraging.
  const stillBlamed = outcomes.filter(
    (outcome) => String(outcome.status ?? "") === "BLOCKED_BY_MISSING_SOURCE" && /currenc/i.test(String(outcome.reason ?? "")),
  );
  assert.deepEqual(stillBlamed.map((o) => o.key), []);
});

function moneyOutcomes(outcomes) {
  return outcomes.filter(
    (outcome) =>
      MONEY_KEYS.includes(outcome.key) && String(outcome.status ?? "") === "CALCULATED",
  );
}

function currencies(orderCurrencies) {
  return { orderCurrencies, variantCurrency: "GBP" };
}

async function derive({ orderCurrencies, variantCurrency, orderCount, variantCount }) {
  const result = await deriveMerchantMemoryBeliefs(mockPrisma({ orderCurrencies, variantCurrency, orderCount, variantCount }), {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const outcomes = Array.isArray(result) ? result : result.derivations ?? [];
  const skippedOutcomes = Array.isArray(result) ? [] : result.skippedOutcomes ?? [];
  return [
    ...outcomes.map((row) => ({ ...row, status: "CALCULATED" })),
    ...skippedOutcomes,
  ];
}

// Mirrors the derivation fixture in merchant-memory.test.mjs, parameterised by currency.
// Deliberately a local copy: the shared one is used by other sessions' tests.
function mockPrisma({ orderCurrencies, variantCurrency, orderCount = 30, variantCount = 3 }) {
  const now = Date.now();
  const products = [
    { id: "product-one", title: "Multi", status: "ACTIVE" },
    { id: "product-two", title: "Single", status: "ACTIVE" },
  ];
  const variants = Array.from({ length: Math.max(variantCount, 3) }, (_, i) => ({
    id: i === 0 ? "variant-one" : i === 1 ? "variant-two" : i === 2 ? "variant-three" : `variant-${i + 1}`,
    productId: i % 2 === 0 ? "product-one" : "product-two",
    sku: `SKU-${i + 1}`,
    title: `V${i + 1}`,
    price: String(10 + (i % 3) * 10) + ".00",
    currency: variantCurrency,
    inventoryItemExternalId: `inventory-${i + 1}`,
  }));
  // Amounts stay identical across cases — only the presentment LABEL rotates, which is
  // exactly the situation the old guard mistook for unusable data.
  const orders = orderCurrencies.length
    ? Array.from({ length: orderCount }, (_, index) => ({
        id: `order-${index + 1}`,
        externalId: `external-order-${index + 1}`,
        currency: orderCurrencies[index % orderCurrencies.length],
        totalPrice: "100.00",
        totalDiscount: "0.00",
        totalTax: "20.00",
        totalShipping: "5.00",
        processedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000),
        sourceCreatedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000),
        sourceUpdatedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000),
        customerExternalId: `customer-${index + 1}`,
        financialStatus: "PAID",
      }))
    : [];
  const lineItems = orders.map((order, index) => ({
    orderId: order.id,
    productId: index % 2 === 0 ? "product-one" : "product-two",
    variantId: index % 2 === 0 ? "variant-one" : "variant-three",
    quantity: 1,
    unitPrice: "100.00",
    totalPrice: "100.00",
  }));

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
    orderLineItem: { findMany: async () => lineItems },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: {
      findMany: async () =>
        variants.map((variant, i) => ({
          variantId: variant.id,
          available: 4 + (i % 3),
          inventoryItemExternalId: variant.inventoryItemExternalId,
          locationExternalId: "location-one",
          sourceUpdatedAt: new Date(now - 3600000),
          observedAt: new Date(now - 3600000),
        })),
    },
  };
}
