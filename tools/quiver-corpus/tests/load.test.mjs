// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { CORPUS_PLATFORM, mapQuiverOrder } from "../src/map.mjs";
import { ensureCorpusShop, loadCorpusMerchant, loadCorpusRows } from "../src/load.mjs";

const SALT = "corpus-test-salt-0123456789";

// Silence the loader's structured log lines; the tests assert on returned state,
// and a few hundred JSON lines per run makes real failures hard to see.
const realLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = realLog; });

/** Minimal in-memory stand-in for the Prisma client the loader uses. */
function fakePrisma(overrides = {}) {
  let sequence = 0;
  const id = (prefix) => `${prefix}-${++sequence}`;
  const store = { merchants: [], shops: [], products: [], variants: [], orders: [], lineItems: [], refunds: [], customers: [] };
  const calls = { upserts: 0, creates: 0 };

  const upsertInto = (collection, matches) => async ({ where, create, update }) => {
    calls.upserts += 1;
    const existing = collection.find((row) => matches(row, where));
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    const row = { id: id("row"), ...create };
    collection.push(row);
    return row;
  };

  return {
    store,
    calls,
    merchant: {
      async create({ data }) {
        calls.creates += 1;
        const row = { id: id("merchant"), ...data };
        store.merchants.push(row);
        return row;
      },
    },
    shop: {
      async findUnique({ where }) {
        const key = where.platform_shopDomain;
        return store.shops.find((s) => s.platform === key.platform && s.shopDomain === key.shopDomain) ?? null;
      },
      async create({ data }) {
        calls.creates += 1;
        const row = { id: id("shop"), ...data };
        store.shops.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = store.shops.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      ...(overrides.shop ?? {}),
    },
    product: { upsert: upsertInto(store.products, (r, w) => r.externalId === w.shopId_externalId.externalId) },
    variant: { upsert: upsertInto(store.variants, (r, w) => r.externalId === w.shopId_externalId.externalId) },
    order: { upsert: upsertInto(store.orders, (r, w) => r.externalId === w.shopId_externalId.externalId) },
    orderLineItem: {
      upsert: upsertInto(store.lineItems, (r, w) =>
        r.orderId === w.orderId_externalId.orderId && r.externalId === w.orderId_externalId.externalId),
    },
    refund: { upsert: upsertInto(store.refunds, (r, w) => r.externalId === w.shopId_externalId.externalId) },
    customerIdentity: { upsert: upsertInto(store.customers, (r, w) => r.emailHash === w.shopId_emailHash.emailHash) },
  };
}

function sourceOrder(overrides = {}, priceOverrides = null) {
  return {
    order: {
      id: "etl-uuid-changes-every-run",
      merchant_id: 967,
      merchant_name: "The Fresh Fish Shop",
      platform: "SHOPIFY",
      order_id: "900001",
      order_created_at: "2026-07-01T10:00:00Z",
      channel: "web",
      city: "London",
      country: "United Kingdom",
      email: "buyer@example.com",
      quiver: true,
      ...overrides,
    },
    prices: priceOverrides ?? [
      { type: "SUBTOTAL", currency_code: "GBP", amount: "4200" },
      { type: "TOTAL", currency_code: "GBP", amount: "4500" },
      { type: "SHIPPING", currency_code: "GBP", amount: "300" },
    ],
    lineItems: [
      { sku: "COD-FILLET-2", name: "Cod fillet x2", quantity: 2, product_id: "p1", variant_id: "v1" },
    ],
  };
}

const merchant = { quiverMerchantId: 967, merchantName: "The Fresh Fish Shop", platform: "SHOPIFY" };

test("a corpus shop is created unresolvable and structurally not a Shopify tenant", async () => {
  const prisma = fakePrisma();
  const shop = await ensureCorpusShop(prisma, merchant);

  assert.equal(shop.platform, CORPUS_PLATFORM);
  assert.equal(shop.shopDomain, "quiver-967.corpus.invalid");
  // Not "installed" — a corpus shop was never installed and holds no session, so
  // anything reading setupStatus must not mistake it for a live tenant.
  assert.equal(shop.setupStatus, "corpus");
  assert.equal(shop.onboardingMetadata.simulation, true);
  assert.ok(shop.onboardingMetadata.coverageGaps.includes("inventory_levels"));
  assert.ok(prisma.store.merchants[0].name.startsWith("[corpus] "));
});

test("re-running reuses the shop instead of creating a second one", async () => {
  const prisma = fakePrisma();
  const first = await ensureCorpusShop(prisma, merchant);
  const creationsAfterFirst = prisma.calls.creates;
  const second = await ensureCorpusShop(prisma, merchant);

  assert.equal(second.id, first.id);
  assert.equal(prisma.calls.creates, creationsAfterFirst, "second run must not create anything");
  assert.equal(prisma.store.shops.length, 1);
});

test("the isolation guard refuses a shop that is not a corpus shop, before any write", async () => {
  // The scenario that matters: something already occupies that row and is NOT a
  // corpus shop. The loader must refuse rather than write merchant data into it.
  const prisma = fakePrisma({
    shop: {
      async findUnique() {
        return { id: "real-shop", merchantId: "real-merchant", platform: "shopify", shopDomain: "everdew.myshopify.com" };
      },
    },
  });

  await assert.rejects(
    () => loadCorpusMerchant(prisma, { merchant, orders: [sourceOrder()] }, { customerSalt: SALT }),
    /expected quiver_sim/,
  );
  assert.equal(prisma.store.orders.length, 0, "nothing may be written once the guard fires");
  assert.equal(prisma.store.products.length, 0);
});

test("the write path itself refuses a non-corpus shop, not just the shop lookup", async () => {
  // Regression guard, found by mutation testing: the earlier version of this suite
  // only exercised the check inside ensureCorpusShop, so the assertion inside the
  // write path could be deleted with every test still green. This calls the write
  // entry point DIRECTLY — the way a future caller that resolved a shop itself
  // would reach it — so the guard has to be real rather than conventional.
  const prisma = fakePrisma();
  const mapped = [mapQuiverOrder(sourceOrder(), {
    merchantId: "m-1", shopId: "s-1", customerSalt: SALT,
  })];

  for (const impostor of [
    { id: "s-1", merchantId: "m-1", platform: "shopify", shopDomain: "quiver-967.corpus.invalid" },
    { id: "s-1", merchantId: "m-1", platform: CORPUS_PLATFORM, shopDomain: "everdew.myshopify.com" },
  ]) {
    await assert.rejects(() => loadCorpusRows(prisma, impostor, mapped), /Refusing to write/);
  }

  assert.equal(prisma.store.orders.length, 0);
  assert.equal(prisma.store.products.length, 0);

  // And the same shop, corpus-shaped, goes through — proving the guard rejects on
  // the isolation property rather than failing for some unrelated reason.
  const ok = await loadCorpusRows(
    prisma,
    { id: "s-1", merchantId: "m-1", platform: CORPUS_PLATFORM, shopDomain: "quiver-967.corpus.invalid" },
    mapped,
  );
  assert.equal(ok.orders, 1);
});

test("orders, derived catalog and line-item links all land", async () => {
  const prisma = fakePrisma();
  const summary = await loadCorpusMerchant(
    prisma,
    { merchant, orders: [sourceOrder(), sourceOrder({ order_id: "900002" })] },
    { customerSalt: SALT },
  );

  assert.equal(summary.orders, 2);
  assert.equal(summary.products, 1, "both orders sold the same product");
  assert.equal(summary.variants, 1);
  assert.equal(prisma.store.lineItems.length, 2);

  // The link is the point: a line item that doesn't resolve to the derived product
  // makes every product-level belief silently empty.
  const product = prisma.store.products[0];
  const variant = prisma.store.variants[0];
  assert.ok(prisma.store.lineItems.every((l) => l.productId === product.id));
  assert.ok(prisma.store.lineItems.every((l) => l.variantId === variant.id));
  assert.equal(variant.productId, product.id);

  const order = prisma.store.orders[0];
  assert.equal(order.currency, "GBP");
  assert.equal(order.subtotalPrice, "42.00");
  assert.equal(order.totalShipping, "3.00");
});

test("loading twice is idempotent — no duplicate rows", async () => {
  const prisma = fakePrisma();
  const orders = [sourceOrder(), sourceOrder({ order_id: "900002" })];
  await loadCorpusMerchant(prisma, { merchant, orders }, { customerSalt: SALT });

  // A Quiver re-import mints fresh row uuids; the deterministic external ids are
  // what stop that from duplicating the store's entire history.
  const reimported = orders.map((entry) => ({
    ...entry,
    order: { ...entry.order, id: `different-uuid-${entry.order.order_id}` },
  }));
  await loadCorpusMerchant(prisma, { merchant, orders: reimported }, { customerSalt: SALT });

  assert.equal(prisma.store.orders.length, 2, "re-import must update, not duplicate");
  assert.equal(prisma.store.lineItems.length, 2);
  assert.equal(prisma.store.products.length, 1);
  assert.equal(prisma.store.shops.length, 1);
});

test("anomalous orders are quarantined by default and counted either way", async () => {
  const bad = sourceOrder({ order_id: "900003" }, [
    { type: "SUBTOTAL", currency_code: "GBP", amount: "1000" },
    { type: "DISCOUNT", currency_code: "GBP", amount: "9900" },
  ]);

  const quarantining = fakePrisma();
  const held = await loadCorpusMerchant(
    quarantining,
    { merchant, orders: [sourceOrder(), bad] },
    { customerSalt: SALT },
  );
  assert.equal(held.orders, 1, "the nonsense order must not reach the belief layer");
  assert.equal(held.quarantined, 1);
  assert.equal(held.anomalyCounts.discount_exceeds_subtotal, 1);
  assert.deepEqual(held.quarantinedOrders[0].anomalies, ["discount_exceeds_subtotal"]);

  // Opting in still records what was suspect, so it stays visible in the data.
  const loading = fakePrisma();
  const kept = await loadCorpusMerchant(
    loading,
    { merchant, orders: [sourceOrder(), bad] },
    { customerSalt: SALT, quarantineAnomalies: false },
  );
  assert.equal(kept.orders, 2);
  assert.equal(kept.quarantined, 0);
  assert.equal(kept.anomalyCounts.discount_exceeds_subtotal, 1, "still counted when loaded");
  const flagged = loading.store.orders.find((o) => o.externalId === "shopify:900003");
  assert.deepEqual(flagged.rawPayload.dataQualityAnomalies, ["discount_exceeds_subtotal"]);
});

test("personal fields stay out by default and customer refs are pseudonymous", async () => {
  const prisma = fakePrisma();
  await loadCorpusMerchant(prisma, { merchant, orders: [sourceOrder()] }, { customerSalt: SALT });

  const written = JSON.stringify(prisma.store.orders);
  assert.ok(!written.includes("buyer@example.com"), "raw email must not be persisted");
  assert.ok(prisma.store.orders[0].customerExternalId, "repeat-purchase signal must survive");
});

test("an order-level refund becomes a refund row attached to its order", async () => {
  const prisma = fakePrisma();
  await loadCorpusMerchant(
    prisma,
    {
      merchant,
      orders: [sourceOrder({ order_id: "900004" }, [
        { type: "SUBTOTAL", currency_code: "GBP", amount: "4200" },
        { type: "REFUND", currency_code: "GBP", amount: "4200" },
      ])],
    },
    { customerSalt: SALT },
  );

  assert.equal(prisma.store.refunds.length, 1);
  assert.equal(prisma.store.refunds[0].amount, "42.00");
  assert.equal(prisma.store.refunds[0].orderId, prisma.store.orders[0].id);
});

test("only the merchant's dominant currency is loaded, and the loss is counted", async () => {
  // Quiver stores presentmentMoney: amounts are in whatever the customer paid in,
  // so they are NOT summable. Jefe sums totalPrice assuming one currency. Loading
  // both would produce a confident, meaningless revenue figure.
  const gbp = (id) => sourceOrder({ order_id: id }, [
    { type: "SUBTOTAL", currency_code: "GBP", amount: "4200" },
    { type: "TOTAL", currency_code: "GBP", amount: "4200" },
  ]);
  const aed = (id) => sourceOrder({ order_id: id }, [
    { type: "SUBTOTAL", currency_code: "AED", amount: "52785" },
    { type: "TOTAL", currency_code: "AED", amount: "52785" },
  ]);

  const prisma = fakePrisma();
  const summary = await loadCorpusMerchant(
    prisma,
    { merchant, orders: [gbp("1"), gbp("2"), gbp("3"), aed("4")] },
    { customerSalt: SALT },
  );

  assert.equal(summary.baseCurrency, "GBP");
  assert.equal(summary.orders, 3, "the AED order must not be loaded");
  assert.equal(summary.anomalyCounts.foreign_currency_order, 1);
  // Coverage is always reported, so "we loaded this store" is never mistaken for
  // "we loaded all of it" — the skipped order is real trade we could not carry.
  assert.equal(summary.currencyCoverage, 0.75);
  assert.ok(prisma.store.orders.every((o) => o.currency === "GBP"));

  // The totals Jefe will sum are now homogeneous, which is the whole point.
  assert.equal(prisma.store.orders.length, 3);
});

test("the corpus records what it actually knows: active products, customers, history span", async () => {
  const prisma = fakePrisma();
  const repeatBuyer = { ...sourceOrder({ order_id: "900010" }).order, email: "regular@example.com" };
  const orders = [
    { ...sourceOrder({ order_id: "900010" }), order: { ...repeatBuyer, order_created_at: "2026-06-01T10:00:00Z" } },
    { ...sourceOrder({ order_id: "900011" }), order: { ...repeatBuyer, order_created_at: "2026-07-01T10:00:00Z" } },
    sourceOrder({ order_id: "900012", email: "someone-else@example.com", order_created_at: "2026-07-15T10:00:00Z" }),
  ];
  const summary = await loadCorpusMerchant(prisma, { merchant, orders }, { customerSalt: SALT });

  // Products must be ACTIVE. Left null, Jefe concluded the store had ZERO active
  // products and silently skipped five downstream beliefs.
  assert.ok(prisma.store.products.length > 0);
  assert.ok(prisma.store.products.every((p) => p.status === "ACTIVE"));
  assert.equal(prisma.store.products[0].rawPayload.statusSource, "inferred_from_having_sold");

  // Two distinct customers, one of whom bought twice — without the roster,
  // known_customer_count derived to zero and repeat-purchase analysis was dead.
  assert.equal(summary.customers, 2);
  const regular = prisma.store.customers.find((c) => c.orderCount === 2);
  assert.ok(regular, "the repeat buyer must be recognised as one customer, not two");
  assert.ok(regular.firstSeenOrderAt < regular.lastOrderAt);
  assert.equal(regular.maskedEmail, null, "we hash the address and never hold it");

  // The shop must not claim history it does not have: a short slice otherwise reads
  // as an "intermittent" business whose quiet days are just missing data.
  const shop = prisma.store.shops[0];
  assert.equal(shop.historicalOrderAccess, "partial");
  assert.equal(shop.availableOrderHistoryDays, 44, "2026-06-01 to 2026-07-15");
});
