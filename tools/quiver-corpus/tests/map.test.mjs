// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import {
  CORPUS_PLATFORM,
  NEVER_CARRIED_COLUMNS,
  corpusShopMetadata,
  deriveCatalog,
  hashCustomerRef,
  lineItemExternalId,
  mapQuiverOrder,
  orderExternalId,
  penceToAmount,
  selectCurrency,
} from "../src/map.mjs";
import {
  assertCorpusShop,
  corpusShopDomain,
  resolveCorpusDatabase,
  resolveCustomerSalt,
} from "../src/safety.mjs";

const SALT = "corpus-test-salt-0123456789";

/** A Quiver `orders` row, shaped exactly as etl-task writes it. */
function quiverOrder(overrides = {}) {
  return {
    id: "3f9b1c2e-0000-4000-8000-000000000001", // uuid minted at ETL time — NOT stable
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-01T09:05:00.000Z",
    merchant_id: 412,
    merchant_name: "Everdew",
    platform: "SHOPIFY",
    order_id: "5544332211",
    order_name: "#1042",
    order_created_at: "2026-07-30T14:22:00.000Z",
    channel: "web",
    retail_location_id: null,
    address: "12 Example Street, London",
    city: "London",
    postcode: "N19GU",
    postcode_prefix: "N1",
    country: "United Kingdom",
    company: null,
    latitude: 51.53,
    longitude: -0.1,
    first_name: "Ada",
    last_name: "Lovelace",
    email: "Ada@Example.com",
    phone_number: "+447700900000",
    quiver: true,
    shipping_title: "Quiver same day",
    shipping_code: "QUIV-SD",
    tags: "vip,repeat",
    payment_gateway_name: "shopify_payments",
    customer_journey: JSON.stringify({ huge: "x".repeat(5000), email: "Ada@Example.com" }),
    ...overrides,
  };
}

test("penceToAmount converts without float drift and handles sign and absence", () => {
  assert.equal(penceToAmount("123456"), "1234.56");
  assert.equal(penceToAmount("5"), "0.05");
  assert.equal(penceToAmount("100"), "1.00");
  assert.equal(penceToAmount("-2550"), "-25.50");
  assert.equal(penceToAmount(0), "0.00");
  assert.equal(penceToAmount(null), null);
  assert.equal(penceToAmount(""), null);
  assert.equal(penceToAmount("not-a-number"), null);

  // The reason this uses BigInt: a revenue sum big enough to lose precision as a
  // float must still be exact, because it lands in a merchant-facing belief.
  assert.equal(penceToAmount("90071992547409911"), "900719925474099.11");
});

test("order external id keys on the platform order id, not Quiver's per-run uuid", () => {
  const first = quiverOrder();
  const second = quiverOrder({ id: "totally-different-uuid-after-etl-rerun" });

  // Same order re-imported after a Quiver ETL re-run must map to the SAME key,
  // otherwise every re-import duplicates the store's entire order history.
  assert.equal(orderExternalId(first), orderExternalId(second));
  assert.equal(orderExternalId(first), "shopify:5544332211");
});

test("line item external ids stay distinct when one order repeats a SKU", () => {
  const line = { sku: "TEE-BLK-M", name: "Black tee" };
  const a = lineItemExternalId("shopify:1", line, 0);
  const b = lineItemExternalId("shopify:1", line, 1);
  assert.notEqual(a, b, "repeated SKU on one order must not collide on the unique key");
});

test("customer ref is stable, salted and empty-safe", () => {
  const a = hashCustomerRef("Ada@Example.com", SALT);
  const b = hashCustomerRef("  ada@example.com  ", SALT);
  assert.equal(a, b, "same customer must hash identically regardless of case/whitespace");

  assert.notEqual(a, hashCustomerRef("ada@example.com", "a-different-salt-value"));
  assert.equal(hashCustomerRef(null, SALT), null);
  assert.equal(hashCustomerRef("   ", SALT), null);
  assert.ok(!String(a).includes("ada"), "raw email must not survive into the ref");
});

test("currency selection is deterministic when an order mixes currencies", () => {
  const mixed = [
    { currency_code: "USD" },
    { currency_code: "USD" },
    { currency_code: "GBP" },
  ];
  // GBP is preferred even though USD has more rows — otherwise the same corpus
  // would read in a different currency depending on row ordering.
  assert.equal(selectCurrency(mixed, "GBP"), "GBP");
  assert.equal(selectCurrency([{ currency_code: "EUR" }], "GBP"), "EUR");
  assert.equal(selectCurrency([], "GBP"), "GBP");
});

test("mapQuiverOrder produces canonical money fields and omits what Quiver lacks", () => {
  const { order } = mapQuiverOrder(
    {
      order: quiverOrder(),
      prices: [
        { type: "TOTAL", currency_code: "GBP", amount: "8400" },
        { type: "SUBTOTAL", currency_code: "GBP", amount: "7500" },
        { type: "SHIPPING", currency_code: "GBP", amount: "900" },
        { type: "DISCOUNT", currency_code: "GBP", amount: "500" },
      ],
      lineItems: [],
    },
    { merchantId: "m-1", shopId: "s-1", customerSalt: SALT },
  );

  assert.equal(order.externalId, "shopify:5544332211");
  assert.equal(order.currency, "GBP");
  assert.equal(order.totalPrice, "84.00");
  assert.equal(order.subtotalPrice, "75.00");
  assert.equal(order.totalShipping, "9.00");
  assert.equal(order.totalDiscount, "5.00");

  // Quiver has no tax type and no payment/fulfilment state. These must stay null
  // rather than being inferred — an invented status is indistinguishable from an
  // observed one once it reaches the belief layer.
  assert.equal(order.totalTax, null);
  assert.equal(order.financialStatus, null);
  assert.equal(order.fulfillmentStatus, null);
});

test("repeated price rows of one type are summed, not overwritten", () => {
  const { order } = mapQuiverOrder(
    {
      order: quiverOrder(),
      prices: [
        { type: "SUBTOTAL", currency_code: "GBP", amount: "1000" },
        { type: "SUBTOTAL", currency_code: "GBP", amount: "250" },
      ],
    },
    { merchantId: "m-1", shopId: "s-1", customerSalt: SALT },
  );
  assert.equal(order.subtotalPrice, "12.50");
});

test("prices in a non-selected currency are excluded rather than summed across currencies", () => {
  const { order } = mapQuiverOrder(
    {
      order: quiverOrder(),
      prices: [
        { type: "SUBTOTAL", currency_code: "GBP", amount: "1000" },
        { type: "SUBTOTAL", currency_code: "USD", amount: "9999" },
      ],
    },
    { merchantId: "m-1", shopId: "s-1", customerSalt: SALT },
  );
  assert.equal(order.currency, "GBP");
  assert.equal(order.subtotalPrice, "10.00", "must not add USD pence into a GBP total");
});

test("personal fields are excluded by default and carried only on explicit opt-in", () => {
  const source = { order: quiverOrder(), prices: [], lineItems: [] };
  const context = { merchantId: "m-1", shopId: "s-1", customerSalt: SALT };

  const { order: withoutPii } = mapQuiverOrder(source, context);
  const serialized = JSON.stringify(withoutPii);
  assert.equal(withoutPii.rawPayload.personal, undefined);
  for (const needle of ["Ada", "Lovelace", "+447700900000", "12 Example Street", "N19GU"]) {
    assert.ok(!serialized.includes(needle), `${needle} must not appear by default`);
  }
  // Coarse geography IS retained — delivery geography is a real Quiver signal.
  assert.equal(withoutPii.rawPayload.city, "London");
  assert.equal(withoutPii.rawPayload.postcode_prefix, "N1");
  // The pseudonymous ref still exists, so repeat-purchase behaviour survives.
  assert.ok(withoutPii.customerExternalId);

  const { order: withPii } = mapQuiverOrder(source, { ...context, includePersonalFields: true });
  assert.equal(withPii.rawPayload.personal.first_name, "Ada");
  assert.equal(withPii.rawPayload.personal.postcode, "N19GU");
});

test("customer_journey is never carried, even with personal fields enabled", () => {
  // It is JSON.stringify(<entire platform order>) — unbounded, and it re-contains
  // the address/email/phone regardless of the includePersonalFields choice.
  assert.deepEqual(NEVER_CARRIED_COLUMNS, ["customer_journey"]);

  for (const includePersonalFields of [false, true]) {
    const { order } = mapQuiverOrder(
      { order: quiverOrder(), prices: [], lineItems: [] },
      { merchantId: "m-1", shopId: "s-1", customerSalt: SALT, includePersonalFields },
    );
    const serialized = JSON.stringify(order);
    assert.ok(!serialized.includes("customer_journey"));
    assert.ok(!serialized.includes("xxxxx"), "the stringified platform order must not leak in");
  }
});

test("an order-level REFUND becomes a refund record; its absence does not", () => {
  const base = { order: quiverOrder(), lineItems: [] };
  const context = { merchantId: "m-1", shopId: "s-1", customerSalt: SALT };

  const { refund } = mapQuiverOrder(
    { ...base, prices: [{ type: "REFUND", currency_code: "GBP", amount: "2500" }] },
    context,
  );
  assert.equal(refund.amount, "25.00");
  assert.equal(refund.externalId, "shopify:5544332211:refund");
  assert.equal(refund.reason, null, "Quiver records no refund reason — must not invent one");

  const { refund: none } = mapQuiverOrder({ ...base, prices: [] }, context);
  assert.equal(none, null);

  const { refund: zero } = mapQuiverOrder(
    { ...base, prices: [{ type: "REFUND", currency_code: "GBP", amount: "0" }] },
    context,
  );
  assert.equal(zero, null, "a zero refund is not a refund");
});

test("line items carry units but never fabricated per-line money", () => {
  const { lineItems } = mapQuiverOrder(
    {
      order: quiverOrder(),
      prices: [{ type: "SUBTOTAL", currency_code: "GBP", amount: "7500" }],
      lineItems: [
        { sku: "TEE-BLK-M", name: "Black tee", quantity: 2, product_id: "77", variant_id: "88" },
        { sku: null, name: "Mystery item", quantity: 1 },
      ],
    },
    { merchantId: "m-1", shopId: "s-1", customerSalt: SALT },
  );

  assert.equal(lineItems.length, 2);
  assert.equal(lineItems[0].quantity, 2);
  assert.equal(lineItems[0].productExternalId, "product:77");
  assert.equal(lineItems[0].variantExternalId, "variant:88");
  // Allocating the order subtotal across lines would invent per-product revenue.
  assert.equal(lineItems[0].unitPrice, null);
  assert.equal(lineItems[0].totalPrice, null);
  // A line with no ids still resolves to a stable identity via its SKU/title.
  assert.equal(lineItems[1].productExternalId, "title:mystery item");
});

test("catalog is derived from sold lines only, and deduplicated", () => {
  const lineItems = [
    { productExternalId: "product:77", variantExternalId: "variant:88", sku: "A", title: "Tee" },
    { productExternalId: "product:77", variantExternalId: "variant:88", sku: "A", title: "Tee" },
    { productExternalId: "product:99", variantExternalId: "variant:12", sku: "B", title: "Mug" },
  ];
  const { products, variants } = deriveCatalog(lineItems, { merchantId: "m-1", shopId: "s-1" });

  assert.equal(products.length, 2);
  assert.equal(variants.length, 2);
  // No cost and no price: a margin calculation must report unavailable, not zero.
  assert.equal(variants[0].unitCost, null);
  assert.equal(variants[0].price, null);
});

test("corpus shop metadata carries the coverage gaps with the data", () => {
  const meta = corpusShopMetadata({ platform: "SHOPIFY", merchantName: "Everdew" });
  assert.equal(meta.simulation, true);
  assert.equal(meta.sourcePlatform, "shopify");
  // Dead-stock beliefs and the clearance action depend on stock we do not have.
  assert.ok(meta.coverageGaps.includes("inventory_levels"));
  assert.ok(meta.coverageGaps.includes("unit_cost"));
  assert.ok(meta.coverageGaps.includes("line_item_prices"));
});

test("corpus shop domains are unresolvable and structurally not Shopify", () => {
  assert.equal(corpusShopDomain(412), "quiver-412.corpus.invalid");
  assert.throws(() => corpusShopDomain(""), /unusable Quiver merchant id/);
  assert.throws(() => corpusShopDomain("../../etc"), /unusable Quiver merchant id/);

  assertCorpusShop({ platform: CORPUS_PLATFORM, shopDomain: "quiver-412.corpus.invalid" });
  assert.throws(
    () => assertCorpusShop({ platform: "shopify", shopDomain: "quiver-412.corpus.invalid" }),
    /expected quiver_sim/,
  );
  assert.throws(
    () => assertCorpusShop({ platform: CORPUS_PLATFORM, shopDomain: "everdew.myshopify.com" }),
    /not a corpus shop domain/,
  );
});

test("the corpus database must be named explicitly and never inherits DATABASE_URL", () => {
  const local = "postgresql://jefe:jefe@localhost:55432/jefe_corpus";

  assert.throws(
    () => resolveCorpusDatabase({ QUIVER_CORPUS_DATABASE_URL: local }),
    /ALLOW_QUIVER_CORPUS_IMPORT/,
  );

  // The load-bearing one: a shell with DATABASE_URL exported at the app's own
  // database must NOT resolve to it. Forgetting the variable has to fail loudly.
  assert.throws(
    () =>
      resolveCorpusDatabase({
        ALLOW_QUIVER_CORPUS_IMPORT: "true",
        DATABASE_URL: "postgresql://jefe:jefe@localhost:55432/jefe_dev",
      }),
    /QUIVER_CORPUS_DATABASE_URL is not set/,
  );

  assert.deepEqual(
    resolveCorpusDatabase({ ALLOW_QUIVER_CORPUS_IMPORT: "true", QUIVER_CORPUS_DATABASE_URL: local }),
    { databaseUrl: local, host: "localhost" },
  );
});

test("a managed database host is refused unless acknowledged", () => {
  const managed = {
    ALLOW_QUIVER_CORPUS_IMPORT: "true",
    QUIVER_CORPUS_DATABASE_URL: "postgresql://u:p@ep-cool-1.eu-west-2.aws.neon.tech/jefe",
  };
  assert.throws(() => resolveCorpusDatabase(managed), /looks like a managed database/);
  assert.equal(
    resolveCorpusDatabase({ ...managed, QUIVER_CORPUS_ALLOW_MANAGED_DB: "true" }).host,
    "ep-cool-1.eu-west-2.aws.neon.tech",
  );
});

test("a weak customer salt is refused", () => {
  assert.throws(() => resolveCustomerSalt({}), /at least 16 characters/);
  assert.throws(() => resolveCustomerSalt({ QUIVER_CORPUS_CUSTOMER_SALT: "short" }), /at least 16/);
  assert.equal(resolveCustomerSalt({ QUIVER_CORPUS_CUSTOMER_SALT: SALT }), SALT);
});
