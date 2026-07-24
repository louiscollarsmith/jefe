import assert from "node:assert/strict";
import test from "node:test";
import { generateSyntheticShopifyDataset } from "../src/generator/index.mjs";
import { validateSyntheticDataset } from "../src/validators/dataset.mjs";
import { buildBeliefCoverageReport } from "../src/validators/coverage.mjs";
import { shippingForMerchandise } from "../src/generator/money.mjs";
import { createManifest, markPhase, recordMapping } from "../src/importers/manifest.mjs";
import { assertWriteSafety } from "../src/importers/safety.mjs";
import { resolveShopifyAccessToken } from "../src/importers/credentials.mjs";
import { formatCliError } from "../src/cli.mjs";
import { ShopifyAdminGraphqlError } from "../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";
import { ShopifyMutationUserError } from "../src/importers/shopify.mjs";

const asOf = "2026-07-23T12:00:00+01:00";

test("fixed seed and as-of produce deterministic output", () => {
  const first = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042026, asOf });
  const second = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042026, asOf });
  const changedSeed = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042027, asOf });
  const changedDate = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042026, asOf: "2026-07-24T12:00:00+01:00" });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notEqual(JSON.stringify(first), JSON.stringify(changedSeed));
  assert.notEqual(first.meta.runId, changedDate.meta.runId);
  assert.equal(first.meta.asOf, "2026-07-23T11:00:00.000Z");
});

test("realistic profile matches required core counts and commercial ranges", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "realistic",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const report = validateSyntheticDataset(dataset);

  assert.equal(report.ok, true);
  assert.equal(dataset.plannedCounts.activeProducts, 24);
  assert.equal(dataset.plannedCounts.archivedProducts, 3);
  assert.equal(dataset.plannedCounts.draftProducts, 2);
  assert.equal(dataset.plannedCounts.customers, 780);
  assert.equal(dataset.plannedCounts.nonTestOrders, 1250);
  assert.equal(dataset.plannedCounts.testOrders, 10);
  assert.equal(dataset.plannedCounts.guestOrders, 80);
  assert.ok(dataset.plannedCounts.refunds >= 82 && dataset.plannedCounts.refunds <= 100);
  assert.ok(dataset.metrics.customers.repeatCustomerRate >= 28 && dataset.metrics.customers.repeatCustomerRate <= 32);
  assert.ok(dataset.metrics.refunds.refundedOrderIncidence >= 6 && dataset.metrics.refunds.refundedOrderIncidence <= 7);
  assert.ok(dataset.metrics.basket.freeDeliveryShare >= 40 && dataset.metrics.basket.freeDeliveryShare <= 55);
  assert.ok(dataset.metrics.basket.averageItems >= 2 && dataset.metrics.basket.averageItems <= 2.4);
});

test("customer repeat orders resolve to the same synthetic customer entity", () => {
  const dataset = generateSyntheticShopifyDataset({ profile: "realistic", seed: 1042026, asOf });
  const grouped = new Map();
  for (const order of dataset.orders.filter((order) => !order.isTest && order.customerSourceId)) {
    grouped.set(order.customerSourceId, (grouped.get(order.customerSourceId) || 0) + 1);
  }
  assert.ok([...grouped.values()].some((count) => count >= 8));
  assert.equal([...dataset.customers.map((customer) => customer.email)].every((email) => email.endsWith("@example.com")), true);
  assert.equal(dataset.customers.every((customer) => customer.phone === null), true);
});

test("seasonality and recency windows are present", () => {
  const dataset = generateSyntheticShopifyDataset({ profile: "realistic", seed: 1042026, asOf });
  const monthly = new Map();
  for (const order of dataset.orders.filter((order) => !order.isTest)) {
    const month = order.processedAt.slice(5, 7);
    monthly.set(month, (monthly.get(month) || 0) + 1);
  }
  const january = monthly.get("01") || 0;
  const december = monthly.get("12") || 0;
  const latestOrderMs = Math.max(...dataset.orders.filter((order) => !order.isTest).map((order) => new Date(order.processedAt).getTime()));
  assert.ok(december > january);
  assert.ok(new Date(asOf).getTime() - latestOrderMs <= 24 * 60 * 60 * 1000);
});

test("orders and refunds reconcile financially", () => {
  const dataset = generateSyntheticShopifyDataset({ profile: "realistic", seed: 1042026, asOf });
  for (const order of dataset.orders) {
    const subtotal = round(order.lineItems.reduce((sum, line) => sum + line.totalPrice, 0));
    assert.equal(round(subtotal - order.totalDiscount + order.totalShipping + order.totalTax), order.totalPrice);
    if (!order.isTest && order.totalPrice > 0 && order.discountCode !== "SHIPFREE") {
      assert.equal(order.totalShipping, shippingForMerchandise(round(subtotal - order.totalDiscount)));
    }
  }
  for (const refund of dataset.refunds) {
    const order = dataset.orders.find((candidate) => candidate.sourceId === refund.orderSourceId);
    assert.ok(new Date(refund.processedAt) > new Date(order.processedAt));
    assert.ok(refund.amount > 0);
    assert.equal(round(refund.transactions.reduce((sum, transaction) => sum + transaction.amount, 0)), refund.amount);
    assert.equal(refund.transactions.every((transaction) => transaction.status === "SUCCESS"), true);
    assert.ok(refund.transactions.every((transaction) => transaction.amount > 0));
  }
});

test("inventory states include tracked, zero, low and negative availability without offsetting positive stock", () => {
  const dataset = generateSyntheticShopifyDataset({ profile: "realistic", seed: 1042026, asOf });
  assert.ok(dataset.metrics.inventory.trackedVariantShare >= 85);
  assert.ok(dataset.metrics.inventory.zeroStockVariants >= 2);
  assert.ok(dataset.metrics.inventory.lowStockVariants >= 2);
  assert.ok(dataset.metrics.inventory.negativeStockMagnitude >= 1);
  assert.ok(dataset.metrics.inventory.positiveStock > dataset.metrics.inventory.negativeStockMagnitude);
});

test("quality edge-case overlay is separate from healthy data", () => {
  const healthy = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042026, asOf, scenario: "healthy_gbp" });
  const edge = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042026, asOf, scenario: "quality_edge_cases" });
  const healthySkus = healthy.products.flatMap((product) => product.variants.map((variant) => variant.sku));
  const edgeSkus = edge.products.flatMap((product) => product.variants.map((variant) => variant.sku));
  assert.equal(healthySkus.includes(""), false);
  assert.equal(edgeSkus.includes(""), true);
  assert.ok(new Set(edge.orders.map((order) => order.currency)).has("EUR") || edge.meta.scenario === "quality_edge_cases");
});

test("manifest primitives support idempotent resume bookkeeping", () => {
  const dataset = generateSyntheticShopifyDataset({ profile: "smoke", seed: 1042026, asOf, shopDomain: "jefe-wine-test.myshopify.com" });
  const manifest = createManifest({ dataset, shopDomain: "jefe-wine-test.myshopify.com" });
  recordMapping(manifest, "products", "prod_001", "gid://shopify/Product/1");
  recordMapping(manifest, "products", "prod_001", "gid://shopify/Product/1");
  markPhase(manifest, "create_products", "completed", 1);
  assert.equal(Object.keys(manifest.sourceToShopifyIds.products).length, 1);
  assert.equal(manifest.phaseStatus.create_products, "completed");
});

test("write safety refuses non-allowlisted or ungated stores", () => {
  const originalGate = process.env.ALLOW_SYNTHETIC_SHOPIFY_SEED;
  const originalAllowlist = process.env.SYNTHETIC_SHOPIFY_ALLOWED_SHOPS;
  try {
    delete process.env.ALLOW_SYNTHETIC_SHOPIFY_SEED;
    process.env.SYNTHETIC_SHOPIFY_ALLOWED_SHOPS = "jefe-wine-test.myshopify.com";
    assert.throws(() => assertWriteSafety({ shopDomain: "jefe-wine-test.myshopify.com" }), /ALLOW_SYNTHETIC_SHOPIFY_SEED/);
    process.env.ALLOW_SYNTHETIC_SHOPIFY_SEED = "true";
    assert.throws(() => assertWriteSafety({ shopDomain: "real-merchant.myshopify.com" }), /not in SYNTHETIC_SHOPIFY_ALLOWED_SHOPS/);
  } finally {
    process.env.ALLOW_SYNTHETIC_SHOPIFY_SEED = originalGate;
    process.env.SYNTHETIC_SHOPIFY_ALLOWED_SHOPS = originalAllowlist;
  }
});

test("credential resolver prefers explicit synthetic env token", async () => {
  const originalToken = process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN;
  const originalFallback = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  try {
    process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_synthetic";
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_fallback";
    const resolved = await resolveShopifyAccessToken({
      shopDomain: "jefe-wine-test.myshopify.com",
      source: "env",
    });
    assert.equal(resolved.accessToken, "shpat_synthetic");
    assert.equal(resolved.source, "SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN");
  } finally {
    process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN = originalToken;
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = originalFallback;
  }
});

test("credential resolver defaults to local DB source", async () => {
  const originalToken = process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN;
  const originalFallback = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  try {
    delete process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN;
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    delete process.env.DATABASE_URL;
    await assert.rejects(
      () =>
        resolveShopifyAccessToken({
          shopDomain: "jefe-wine-test.myshopify.com",
        }),
      /No offline Shopify session found|Found an offline Shopify session.*expired/,
    );
  } finally {
    process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN = originalToken;
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = originalFallback;
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("coverage command reads the active deterministic belief registry", () => {
  const dataset = generateSyntheticShopifyDataset({ profile: "realistic", seed: 1042026, asOf });
  const report = buildBeliefCoverageReport(dataset);
  assert.equal(report.length, 104);
  assert.ok(report.some((entry) => entry.beliefKey === "orders.total_order_count"));
  assert.ok(report.some((entry) => entry.expectedOutcome === "derived_zero"));
});

test("CLI error formatter prints Shopify GraphQL response details", () => {
  const error = new ShopifyAdminGraphqlError("Shopify GraphQL response errors", {
    status: 200,
    requestId: "request-1",
    errors: [
      {
        message: "Access denied",
        extensions: { code: "ACCESS_DENIED", requiredAccess: "write_products" },
        path: ["productDelete"],
      },
    ],
  });
  const formatted = formatCliError(error);
  assert.match(formatted, /request-1/);
  assert.match(formatted, /ACCESS_DENIED/);
  assert.match(formatted, /write_products/);
});

test("CLI error formatter prints Shopify mutation userErrors", () => {
  const error = new ShopifyMutationUserError("productCreate", "prod_001", [
    {
      field: ["input", "handle"],
      message: "Handle 'salt-road-feteasca' already in use.",
    },
  ]);
  const formatted = formatCliError(error);
  assert.match(formatted, /productCreate/);
  assert.match(formatted, /prod_001/);
  assert.match(formatted, /salt-road-feteasca/);
});

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
