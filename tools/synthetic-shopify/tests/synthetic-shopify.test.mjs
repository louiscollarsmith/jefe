import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { generateSyntheticShopifyDataset } from "../src/generator/index.mjs";
import { validateSyntheticDataset } from "../src/validators/dataset.mjs";
import { buildBeliefCoverageReport } from "../src/validators/coverage.mjs";
import { shippingForMerchandise } from "../src/generator/money.mjs";
import { createManifest, markPhase, persistRun, recordMapping } from "../src/importers/manifest.mjs";
import { assertWriteSafety } from "../src/importers/safety.mjs";
import { resolveShopifyAccessToken } from "../src/importers/credentials.mjs";
import { createOrLoadPlannedRun, formatCliError } from "../src/cli.mjs";
import { runDirectory } from "../src/output-paths.mjs";
import { ShopifyAdminGraphqlError } from "../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";
import {
  ShopifyMutationUserError,
  createProductWithRecoveredHandle,
  estimateImportProgress,
  hydrateExistingSyntheticMappings,
  isAlreadyExistsError,
  mapExistingProductVariants,
  missingInventoryItemIds,
  refreshInventoryQuantityEntriesForProduct,
  staleInventoryQuantityIndexes,
  syncProductVariants,
} from "../src/importers/shopify.mjs";

const asOf = "2026-07-23T12:00:00+01:00";

test("fixed seed and as-of produce deterministic output", () => {
  const first = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
  });
  const second = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
  });
  const changedSeed = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042027,
    asOf,
  });
  const changedDate = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf: "2026-07-24T12:00:00+01:00",
  });

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
  const dataset = generateSyntheticShopifyDataset({
    profile: "realistic",
    seed: 1042026,
    asOf,
  });
  const grouped = new Map();
  for (const order of dataset.orders.filter((order) => !order.isTest && order.customerSourceId)) {
    grouped.set(order.customerSourceId, (grouped.get(order.customerSourceId) || 0) + 1);
  }
  assert.ok([...grouped.values()].some((count) => count >= 8));
  assert.equal(
    [...dataset.customers.map((customer) => customer.email)].every((email) => email.endsWith("@example.com")),
    true,
  );
  assert.equal(
    dataset.customers.every((customer) => customer.phone === null),
    true,
  );
});

test("seasonality and recency windows are present", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "realistic",
    seed: 1042026,
    asOf,
  });
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
  const dataset = generateSyntheticShopifyDataset({
    profile: "realistic",
    seed: 1042026,
    asOf,
  });
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
    assert.equal(
      refund.transactions.every((transaction) => transaction.status === "SUCCESS"),
      true,
    );
    assert.ok(refund.transactions.every((transaction) => transaction.amount > 0));
  }
});

test("inventory states include tracked, zero, low and negative availability without offsetting positive stock", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "realistic",
    seed: 1042026,
    asOf,
  });
  assert.ok(dataset.metrics.inventory.trackedVariantShare >= 85);
  assert.ok(dataset.metrics.inventory.zeroStockVariants >= 2);
  assert.ok(dataset.metrics.inventory.lowStockVariants >= 2);
  assert.ok(dataset.metrics.inventory.negativeStockMagnitude >= 1);
  assert.ok(dataset.metrics.inventory.positiveStock > dataset.metrics.inventory.negativeStockMagnitude);
});

test("quality edge-case overlay is separate from healthy data", () => {
  const healthy = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    scenario: "healthy_gbp",
  });
  const edge = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    scenario: "quality_edge_cases",
  });
  const healthySkus = healthy.products.flatMap((product) => product.variants.map((variant) => variant.sku));
  const edgeSkus = edge.products.flatMap((product) => product.variants.map((variant) => variant.sku));
  assert.equal(healthySkus.includes(""), false);
  assert.equal(edgeSkus.includes(""), true);
  assert.ok(new Set(edge.orders.map((order) => order.currency)).has("EUR") || edge.meta.scenario === "quality_edge_cases");
  assert.equal(validateSyntheticDataset(edge).ok, true);
});

test("manifest primitives support idempotent resume bookkeeping", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  recordMapping(manifest, "products", "prod_001", "gid://shopify/Product/1");
  recordMapping(manifest, "products", "prod_001", "gid://shopify/Product/1");
  markPhase(manifest, "create_products", "completed", 1);
  assert.equal(Object.keys(manifest.sourceToShopifyIds.products).length, 1);
  assert.equal(manifest.phaseStatus.create_products, "completed");
});

test("seed command reloads an existing deterministic run instead of overwriting progress", () => {
  const args = {
    shop: "synthetic-resume-loader.myshopify.com",
    profile: "smoke",
    seed: "771923",
    "as-of": asOf,
  };
  const planned = generateSyntheticShopifyDataset({
    profile: args.profile,
    seed: args.seed,
    asOf: args["as-of"],
    shopDomain: args.shop,
  });
  fs.rmSync(runDirectory(args.shop, planned.meta.runId), { recursive: true, force: true });
  const first = createOrLoadPlannedRun(args);
  try {
    assert.equal(first.loadedExistingRun, false);
    recordMapping(first.manifest, "products", "prod_001", "gid://shopify/Product/resumed");
    persistRun(first);

    const second = createOrLoadPlannedRun(args);
    assert.equal(second.loadedExistingRun, true);
    assert.equal(second.manifest.sourceToShopifyIds.products.prod_001, "gid://shopify/Product/resumed");
  } finally {
    fs.rmSync(runDirectory(first.manifest.shopDomain, first.manifest.runId), { recursive: true, force: true });
  }
});

test("variant resume maps existing Shopify variants before creating missing ones", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products.find((candidate) => candidate.variants.some((variant) => variant.optionValue === "Previous vintage"));
  assert.ok(product);
  const previousVintage = product.variants.find((variant) => variant.optionValue === "Previous vintage");
  assert.ok(previousVintage);
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });

  mapExistingProductVariants({
    manifest,
    product,
    shopifyVariants: [
      {
        id: "gid://shopify/ProductVariant/previous-vintage",
        sku: previousVintage.sku,
        selectedOptions: [{ name: "Format", value: "Previous vintage" }],
        inventoryItem: { id: "gid://shopify/InventoryItem/previous-vintage" },
      },
    ],
  });

  assert.equal(manifest.sourceToShopifyIds.variants[previousVintage.sourceId], "gid://shopify/ProductVariant/previous-vintage");
  assert.equal(manifest.sourceToShopifyIds.inventoryItems[`ii_${previousVintage.sourceId}`], "gid://shopify/InventoryItem/previous-vintage");
});

test("variant resume refreshes stale inventory item mappings", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[0];
  const variant = product.variants[0];
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  recordMapping(manifest, "variants", variant.sourceId, "gid://shopify/ProductVariant/stale");
  recordMapping(manifest, "inventoryItems", `ii_${variant.sourceId}`, "gid://shopify/InventoryItem/stale");
  manifest.sourceToShopifyIds.inventoryActivations = {
    "gid://shopify/InventoryItem/stale:gid://shopify/Location/main": "gid://shopify/InventoryItem/stale:gid://shopify/Location/main",
  };

  mapExistingProductVariants({
    manifest,
    product,
    shopifyVariants: [
      {
        id: "gid://shopify/ProductVariant/current",
        sku: variant.sku,
        selectedOptions: [{ name: "Format", value: variant.optionValue }],
        inventoryItem: { id: "gid://shopify/InventoryItem/current" },
      },
    ],
  });

  assert.equal(manifest.sourceToShopifyIds.variants[variant.sourceId], "gid://shopify/ProductVariant/current");
  assert.equal(manifest.sourceToShopifyIds.inventoryItems[`ii_${variant.sourceId}`], "gid://shopify/InventoryItem/current");
  assert.deepEqual(manifest.sourceToShopifyIds.inventoryActivations, {});
});

test("variant sync preserves and updates Shopify standalone variants", async () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[0];
  const [singleBottle, caseOfSix, previousVintage] = product.variants;
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  recordMapping(manifest, "products", product.sourceId, "gid://shopify/Product/salt-road");
  const calls = [];
  const refreshedVariants = [
    {
      id: "gid://shopify/ProductVariant/single",
      sku: singleBottle.sku,
      selectedOptions: [{ name: "Format", value: singleBottle.optionValue }],
      inventoryItem: { id: "gid://shopify/InventoryItem/single", tracked: true },
    },
    {
      id: "gid://shopify/ProductVariant/case",
      sku: caseOfSix.sku,
      selectedOptions: [{ name: "Format", value: caseOfSix.optionValue }],
      inventoryItem: { id: "gid://shopify/InventoryItem/case", tracked: true },
    },
    {
      id: "gid://shopify/ProductVariant/previous",
      sku: previousVintage.sku,
      selectedOptions: [{ name: "Format", value: previousVintage.optionValue }],
      inventoryItem: { id: "gid://shopify/InventoryItem/previous", tracked: false },
    },
  ];
  const client = {
    async request(query, variables) {
      calls.push({ query, variables });
      if (query.includes("SyntheticProductVariantsBulkUpdate")) {
        assert.equal(variables.variants[0].id, "gid://shopify/ProductVariant/single");
        assert.equal(variables.variants[0].inventoryItem.sku, singleBottle.sku);
        assert.equal(variables.variants[0].inventoryItem.tracked, true);
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
      }
      if (query.includes("SyntheticProductVariantsBulkCreate")) {
        assert.equal(variables.strategy, "PRESERVE_STANDALONE_VARIANT");
        assert.deepEqual(
          variables.variants.map((variant) => variant.inventoryItem.sku),
          [caseOfSix.sku, previousVintage.sku],
        );
        return { productVariantsBulkCreate: { productVariants: [], userErrors: [] } };
      }
      if (query.includes("SyntheticProductVariants")) {
        const priorQueries = calls.filter((call) => call.query.includes("SyntheticProductVariants(")).length;
        return {
          product: {
            variants: {
              nodes:
                priorQueries === 1
                  ? [
                      {
                        id: "gid://shopify/ProductVariant/single",
                        sku: "",
                        selectedOptions: [{ name: "Format", value: singleBottle.optionValue }],
                        inventoryItem: { id: "gid://shopify/InventoryItem/single", tracked: false },
                      },
                    ]
                  : refreshedVariants,
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };

  await syncProductVariants(client, product, manifest, () => {});

  assert.equal(manifest.sourceToShopifyIds.variants[singleBottle.sourceId], "gid://shopify/ProductVariant/single");
  assert.equal(manifest.sourceToShopifyIds.variants[caseOfSix.sourceId], "gid://shopify/ProductVariant/case");
  assert.equal(manifest.sourceToShopifyIds.variants[previousVintage.sourceId], "gid://shopify/ProductVariant/previous");
  assert.equal(manifest.sourceToShopifyIds.inventoryItems[`ii_${singleBottle.sourceId}`], "gid://shopify/InventoryItem/single");
});

test("inventory quantity user errors identify stale quantity indexes", () => {
  const indexes = staleInventoryQuantityIndexes([
    {
      field: ["input", "quantities", "2", "inventoryItemId"],
      message: "The specified inventory item could not be found.",
    },
    {
      field: ["input", "quantities", "11", "inventoryItemId"],
      message: "The specified inventory item could not be found.",
    },
    {
      field: ["input", "quantities", "11", "inventoryItemId"],
      message: "The specified inventory item could not be found.",
    },
    {
      code: "INVALID_INVENTORY_ITEM",
      field: ["input", "quantities", "27", "inventoryItemId"],
      message: "Inventory item is invalid.",
    },
  ]);

  assert.deepEqual(indexes, [2, 11, 27]);
});

test("inventory preflight identifies IDs Shopify no longer resolves", async () => {
  const requestedIds = [
    "gid://shopify/InventoryItem/current-1",
    "gid://shopify/InventoryItem/deleted",
    "gid://shopify/InventoryItem/current-2",
    "gid://shopify/InventoryItem/current-1",
  ];
  const client = {
    async request(query, variables) {
      assert.match(query, /SyntheticInventoryItemsByIds/);
      assert.deepEqual(variables.ids, requestedIds.slice(0, 3));
      return {
        nodes: [
          { id: "gid://shopify/InventoryItem/current-1" },
          null,
          { id: "gid://shopify/InventoryItem/current-2" },
        ],
      };
    },
  };

  const missing = await missingInventoryItemIds(client, requestedIds);

  assert.deepEqual(missing, ["gid://shopify/InventoryItem/deleted"]);
});

test("inventory recovery refreshes every queued level for the recovered product", async () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[0];
  const productVariantIds = new Set(product.variants.map((variant) => `ii_${variant.sourceId}`));
  const productLevels = dataset.inventoryLevels.filter((level) => productVariantIds.has(level.inventoryItemSourceId));
  const unrelatedLevel = dataset.inventoryLevels.find((level) => !productVariantIds.has(level.inventoryItemSourceId));
  assert.ok(productLevels.length > 1);
  assert.ok(unrelatedLevel);
  recordMapping(manifest, "locations", "loc_london_warehouse", "gid://shopify/Location/main");
  manifest.sourceToShopifyIds.inventoryActivations = {};

  for (const level of productLevels) {
    const inventoryItemId = `gid://shopify/InventoryItem/current-${level.inventoryItemSourceId}`;
    recordMapping(manifest, "inventoryItems", level.inventoryItemSourceId, inventoryItemId);
    manifest.sourceToShopifyIds.inventoryActivations[`${inventoryItemId}:gid://shopify/Location/main`] =
      `${inventoryItemId}:gid://shopify/Location/main`;
  }
  recordMapping(manifest, "inventoryItems", unrelatedLevel.inventoryItemSourceId, "gid://shopify/InventoryItem/unrelated");
  const quantityEntries = [...productLevels, unrelatedLevel].map((level) => ({
    level,
    quantity: {
      inventoryItemId: `gid://shopify/InventoryItem/stale-${level.inventoryItemSourceId}`,
      locationId: "gid://shopify/Location/main",
      quantity: level.available,
      changeFromQuantity: level.available,
    },
  }));

  await refreshInventoryQuantityEntriesForProduct({
    client: {
      async request() {
        throw new Error("Already-activated current inventory IDs should not call Shopify");
      },
    },
    dataset,
    manifest,
    quantityEntries,
    product,
    persist() {},
  });

  for (const entry of quantityEntries.slice(0, productLevels.length)) {
    assert.equal(
      entry.quantity.inventoryItemId,
      `gid://shopify/InventoryItem/current-${entry.level.inventoryItemSourceId}`,
    );
  }
  assert.equal(
    quantityEntries.at(-1).quantity.inventoryItemId,
    `gid://shopify/InventoryItem/stale-${unrelatedLevel.inventoryItemSourceId}`,
  );
});

test("resume hydration maps Shopify products and variants into a blank manifest", async () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[0];
  const variant = product.variants[0];
  const collection = dataset.collections[0];
  const client = {
    async request(query, variables) {
      if (query.includes("SyntheticProductByHandle") && variables.handle === product.handle) {
        return {
          productByHandle: {
            id: "gid://shopify/Product/existing",
            handle: product.handle,
            variants: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/existing",
                  sku: variant.sku,
                  selectedOptions: [{ name: "Format", value: variant.optionValue }],
                  inventoryItem: { id: "gid://shopify/InventoryItem/existing" },
                },
              ],
            },
          },
        };
      }
      if (query.includes("SyntheticCollectionByHandle") && variables.handle === collection.handle) {
        return {
          collectionByHandle: {
            id: "gid://shopify/Collection/existing",
            handle: collection.handle,
          },
        };
      }
      return { productByHandle: null, collectionByHandle: null };
    },
  };

  await hydrateExistingSyntheticMappings(
    client,
    dataset,
    manifest,
    {
      productsCount: { count: 1 },
      customersCount: { count: 0 },
      ordersCount: { count: 0 },
      nonemptyResumeNotice: "resume",
    },
    { info() {}, warn() {} },
    () => {},
  );

  assert.equal(manifest.sourceToShopifyIds.products[product.sourceId], "gid://shopify/Product/existing");
  assert.equal(manifest.sourceToShopifyIds.variants[variant.sourceId], "gid://shopify/ProductVariant/existing");
  assert.equal(manifest.sourceToShopifyIds.collections[collection.sourceId], "gid://shopify/Collection/existing");
  assert.ok(manifest.resumeProgress.after.percentComplete > manifest.resumeProgress.before.percentComplete);
});

test("resume hydration maps products found only by handle search fallback", async () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[1];
  const variant = product.variants[0];
  const client = {
    async request(query, variables) {
      if (query.includes("SyntheticProductByHandleSearch")) {
        if (variables.query !== `handle:${product.handle}`) {
          return { products: { nodes: [] } };
        }
        return {
          products: {
            nodes: [
              {
                id: "gid://shopify/Product/search-existing",
                handle: product.handle,
                variants: {
                  nodes: [
                    {
                      id: "gid://shopify/ProductVariant/search-existing",
                      sku: variant.sku,
                      selectedOptions: [{ name: "Format", value: variant.optionValue }],
                      inventoryItem: { id: "gid://shopify/InventoryItem/search-existing" },
                    },
                  ],
                },
              },
            ],
          },
        };
      }
      if (query.includes("SyntheticProductByHandle")) {
        return { productByHandle: null };
      }
      return { collectionByHandle: null };
    },
  };

  await hydrateExistingSyntheticMappings(
    client,
    dataset,
    manifest,
    {
      productsCount: { count: 1 },
      customersCount: { count: 0 },
      ordersCount: { count: 0 },
      nonemptyResumeNotice: "resume",
    },
    { info() {}, warn() {} },
    () => {},
  );

  assert.equal(manifest.sourceToShopifyIds.products[product.sourceId], "gid://shopify/Product/search-existing");
  assert.equal(manifest.sourceToShopifyIds.variants[variant.sourceId], "gid://shopify/ProductVariant/search-existing");
  assert.equal(manifest.sourceToShopifyIds.inventoryItems[`ii_${variant.sourceId}`], "gid://shopify/InventoryItem/search-existing");
});

test("product handle already in use is treated as a recoverable mapping error", () => {
  const error = new ShopifyMutationUserError("productCreate", "prod_002", [
    {
      field: ["input", "handle"],
      message: "Handle 'cloud-needle-tsolikouri' already in use. Please provide a new handle.",
    },
  ]);

  assert.equal(isAlreadyExistsError(error), true);
});

test("product handle conflicts can create with deterministic recovered handles", async () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[1];
  const expectedRecoveredHandle = `${product.handle}-${manifest.runId.replace(/^synth_/, "").slice(0, 8)}`;
  const calls = [];
  const client = {
    async request(query, variables) {
      calls.push({ query, variables });
      if (query.includes("SyntheticProductByHandle")) return { productByHandle: null };
      if (query.includes("SyntheticProductByHandleSearch")) return { products: { nodes: [] } };
      if (query.includes("SyntheticProductCreate")) {
        assert.equal(variables.product.handle, expectedRecoveredHandle);
        return {
          productCreate: {
            product: { id: "gid://shopify/Product/recovered" },
            userErrors: [],
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  const error = new ShopifyMutationUserError("productCreate", product.sourceId, [
    {
      field: ["input", "handle"],
      message: `Handle '${product.handle}' already in use. Please provide a new handle.`,
    },
  ]);

  const recovered = await createProductWithRecoveredHandle(client, manifest, product, error);

  assert.equal(recovered, true);
  assert.equal(manifest.sourceToShopifyIds.products[product.sourceId], "gid://shopify/Product/recovered");
  assert.equal(manifest.recoveredProductHandles[product.sourceId], expectedRecoveredHandle);
  assert.ok(calls.some((call) => call.query.includes("SyntheticProductCreate")));
});

test("resume hydration clears stale product variant and inventory mappings", async () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const product = dataset.products[0];
  const variant = product.variants[0];
  recordMapping(manifest, "products", product.sourceId, "gid://shopify/Product/deleted");
  recordMapping(manifest, "variants", variant.sourceId, "gid://shopify/ProductVariant/deleted");
  recordMapping(manifest, "inventoryItems", `ii_${variant.sourceId}`, "gid://shopify/InventoryItem/deleted");
  manifest.sourceToShopifyIds.inventoryActivations = {
    "gid://shopify/InventoryItem/deleted:gid://shopify/Location/main": "gid://shopify/InventoryItem/deleted:gid://shopify/Location/main",
  };
  const client = {
    async request(query) {
      if (query.includes("SyntheticProductResumeState")) return { product: null };
      return { productByHandle: null, collectionByHandle: null };
    },
  };

  await hydrateExistingSyntheticMappings(
    client,
    dataset,
    manifest,
    {
      productsCount: { count: 0 },
      customersCount: { count: 0 },
      ordersCount: { count: 0 },
    },
    { info() {}, warn() {} },
    () => {},
  );

  assert.equal(manifest.sourceToShopifyIds.products[product.sourceId], undefined);
  assert.equal(manifest.sourceToShopifyIds.variants[variant.sourceId], undefined);
  assert.equal(manifest.sourceToShopifyIds.inventoryItems[`ii_${variant.sourceId}`], undefined);
  assert.deepEqual(manifest.sourceToShopifyIds.inventoryActivations, {});
});

test("resume progress estimates mapped and remaining synthetic records", () => {
  const dataset = generateSyntheticShopifyDataset({
    profile: "smoke",
    seed: 1042026,
    asOf,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  const manifest = createManifest({
    dataset,
    shopDomain: "jefe-wine-test.myshopify.com",
  });
  recordMapping(manifest, "products", dataset.products[0].sourceId, "gid://shopify/Product/1");
  recordMapping(manifest, "customers", dataset.customers[0].sourceId, "gid://shopify/Customer/1");

  const progress = estimateImportProgress(dataset, manifest);

  assert.equal(progress.mapped.products, 1);
  assert.equal(progress.remaining.products, dataset.products.length - 1);
  assert.equal(progress.mapped.customers, 1);
  assert.ok(progress.percentComplete > 0);
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
  const dataset = generateSyntheticShopifyDataset({
    profile: "realistic",
    seed: 1042026,
    asOf,
  });
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
        extensions: {
          code: "ACCESS_DENIED",
          requiredAccess: "write_products",
        },
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
