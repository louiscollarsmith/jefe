import assert from "node:assert/strict";
import test from "node:test";

import {
  executeShopifyIntelligenceTool,
  listShopifyIntelligenceTools,
  shopifyIntelligenceToolCatalogForPrompt,
} from "../app/lib/shopify/intelligence-tools.server.js";

const NOW = new Date("2026-08-13T09:00:00.000Z");
const silentLogger = { info() {}, warn() {}, error() {} };

test("tool catalog separates retrieval and analytical tools", () => {
  const catalog = shopifyIntelligenceToolCatalogForPrompt();
  const tools = listShopifyIntelligenceTools();

  assert.ok(tools.some((tool) => tool.kind === "retrieval"));
  assert.ok(tools.some((tool) => tool.kind === "analysis"));
  assert.ok(catalog.tools.some((tool) => tool.name === "shopify_analyse_product_performance"));
  assert.ok(catalog.prohibited.includes("arbitrary GraphQL"));
});

test("unsafe requests are rejected before any read", async () => {
  const reads = [];
  const prisma = {
    order: {
      findMany: async () => {
        reads.push("order");
        return [];
      },
    },
  };

  const result = await executeShopifyIntelligenceTool(prisma, {
    merchantId: "m1",
    shopId: "s1",
    toolName: "shopify_analyse_sales_mix",
    input: { query: "query { orders { nodes { id email } } }" },
    logger: silentLogger,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.deepEqual(reads, []);
});

test("acquisition analysis returns NOT_INGESTED instead of direct traffic when journeys are absent", async () => {
  const result = await executeShopifyIntelligenceTool(createPrisma(), {
    merchantId: "m1",
    shopId: "s1",
    toolName: "shopify_analyse_acquisition_quality",
    input: { window: { days: 90 } },
    logger: silentLogger,
    now: NOW,
  });

  assert.equal(result.availabilityState, "NOT_INGESTED");
  assert.match(result.caveats.join(" "), /Do not treat this as direct traffic/);
  assert.equal(result.totals.attributionCoveragePercent, 0);
});

test("discount analysis reports thin identity coverage as insufficient evidence", async () => {
  const result = await executeShopifyIntelligenceTool(createPrisma({ partialDiscountIdentity: true }), {
    merchantId: "m1",
    shopId: "s1",
    toolName: "shopify_analyse_discount_usage",
    input: { window: { days: 90 }, limit: 999 },
    logger: silentLogger,
    now: NOW,
  });

  assert.equal(result.availabilityState, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.dataQuality.rowCount <= 50, true);
  assert.match(result.caveats.join(" "), /Do not conclude the merchant runs no campaigns/);
});

test("product metadata passes PII through and marks richer Shopify metadata as contextual", async () => {
  const result = await executeShopifyIntelligenceTool(createPrisma(), {
    merchantId: "m1",
    shopId: "s1",
    toolName: "shopify_get_product_metadata",
    input: { productId: "p1" },
    logger: silentLogger,
    now: NOW,
  });

  const text = JSON.stringify(result);
  assert.equal(result.ok, true);
  // ⛔ PII scrubbing REMOVED 2026-08-13 (founder's call). Tool results used to rewrite
  // email-shaped strings to [redacted-email] before the model saw them; they no longer do.
  // Inverted rather than deleted so restoring the guarantee is one edit.
  assert.equal(result.rows[0].title.includes("[redacted-email]"), false);
  assert.match(text, /owner@example\.com/);
  assert.ok(result.evidenceAvailability.some((item) => item.id === "products.metafields" && item.state === "UNKNOWN"));
});

function createPrisma({ partialDiscountIdentity = false } = {}) {
  const orders = Array.from({ length: 20 }, (_, index) => ({
    id: `o${index}`,
    merchantId: "m1",
    shopId: "s1",
    currency: "GBP",
    totalPrice: 100,
    totalDiscount: 10,
    processedAt: new Date(NOW.getTime() - (index + 1) * 86400000),
    financialStatus: "paid",
    fulfillmentStatus: index % 2 ? "fulfilled" : "unfulfilled",
    sourceName: "web",
    discountCodes: !partialDiscountIdentity || index < 5 ? ["WELCOME10"] : [],
    discountApplications: !partialDiscountIdentity || index < 5 ? [{ label: "WELCOME10", kind: "code" }] : [],
    attribution: {},
  }));
  const product = {
    id: "p1",
    externalId: "gid://shopify/Product/1",
    merchantId: "m1",
    shopId: "s1",
    title: "Customer name Jane Smith owner@example.com",
    handle: "sample",
    status: "ACTIVE",
    vendor: "Jefe",
    productType: "Wine",
    sourceUpdatedAt: NOW,
    variants: [
      {
        id: "v1",
        externalId: "gid://shopify/ProductVariant/1",
        sku: "SKU-1",
        title: "Default",
        price: 20,
        currency: "GBP",
        unitCost: 8,
        inventoryLevels: [{ available: 6 }],
      },
    ],
  };
  return {
    order: {
      findMany: async () => orders,
      findFirst: async () => null,
    },
    product: {
      findFirst: async () => product,
    },
  };
}
