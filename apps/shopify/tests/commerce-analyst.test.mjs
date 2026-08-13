import assert from "node:assert/strict";
import test from "node:test";
import {
  answerCommerceQuestion,
  executeCommerceAnalystToolCalls,
  shouldAttemptCommerceAnalysis,
} from "../app/lib/merchant-memory/commerce-analyst.server.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("commerce analyst plans, executes and derives replenishment units", async () => {
  const prompts = [];
  const { prisma, actionContext } = createTwoProductAnalystFixture();
  const provider = {
    provider: "mock",
    model: "mock-commerce-analyst",
    enabled: true,
    generateStructuredJson: async (request) => {
      prompts.push(request);
      if (request.prompt.includes("commerceAnalystToolCatalog")) {
        return {
          json: {
            toolCalls: [
              {
                id: "current_move_stock_cover",
                kind: "commerce_calculation",
                request: {
                  id: "current_move_stock_cover",
                  kind: "ranking",
                  measure: "stock_cover_days",
                  dimensions: ["product"],
                  filters: { scope: "current_move" },
                  window: { days: 30, label: "trailing_30d" },
                  topN: 12,
                },
              },
              {
                id: "recommended_purchase_units",
                kind: "derive",
                operation: "recommended_purchase_units",
                sourceResultId: "current_move_stock_cover",
                formula: "ceil(max(0, dailyUnits * targetCoverDays - availableUnits))",
                outputField: "recommendedUnits",
                assumptions: { targetCoverDays: 30, targetCoverDaysSource: "default_30_day_cover" },
              },
            ],
          },
          usage: { totalTokens: 20 },
          attempts: 1,
          durationMs: 2,
        };
      }
      return {
        json: { reply: "Buy 3 units of Picnic Xinomavro and 3 units of Pear Skin Sipon for a 30-day cover target." },
        usage: { totalTokens: 20 },
        attempts: 1,
        durationMs: 2,
      };
    },
  };

  const result = await answerCommerceQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    message: "How much should I purchase of each?",
    actionContext,
    provider,
    logger: silentLogger,
    now: new Date("2026-08-11T12:00:00.000Z"),
  });

  assert.equal(result.source, "llm");
  assert.match(result.reply, /3 units of Picnic Xinomavro/);
  assert.match(result.reply, /3 units of Pear Skin Sipon/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].prompt, /commerceAnalystToolCatalog/);
  assert.match(prompts[1].prompt, /analysisPacket/);
  const derived = result.analysisPacket.results.find((item) => item.id === "recommended_purchase_units");
  assert.ok(derived);
  assert.deepEqual(
    derived.rows.map((row) => row.recommendedUnits),
    [3, 3],
  );
  assert.equal(derived.formula, "ceil(max(0, dailyUnits * targetCoverDays - availableUnits))");
  assert.equal(result.analysisPacket.assumptions.targetCoverDays, 30);
});

test("commerce analyst blocks unsafe row requests and redacts row strings before prompts", async () => {
  const productFindManyCalls = [];
  const prisma = {
    product: {
      findMany: async (args) => {
        productFindManyCalls.push(args);
        return [
          {
            id: "p1",
            title: "Customer name Jane Smith owner@example.com +44 7700 900123 Bearer fixture_redaction_secret_0000",
            status: "ACTIVE",
            vendor: "Picnic",
            productType: "Wine",
            rawPayload: { should: "never cross" },
            customerName: "Jane Smith",
          },
        ];
      },
    },
    customerIdentity: {
      findMany: async () => {
        throw new Error("customer model should never be queried");
      },
    },
  };

  const packet = await executeCommerceAnalystToolCalls(prisma, {
    merchantId: "m1",
    shopId: "s1",
    toolCalls: [
      { id: "customers", kind: "fetch_rows", entity: "customers", limit: 10 },
      { id: "sql", kind: "sql", query: "SELECT * FROM orders" },
      {
        id: "products",
        kind: "fetch_rows",
        entity: "products",
        fields: ["id", "title", "rawPayload", "customerExternalId"],
        limit: 999,
      },
    ],
    logger: silentLogger,
    now: new Date("2026-08-11T12:00:00.000Z"),
  });

  assert.equal(productFindManyCalls.length, 1);
  assert.equal(productFindManyCalls[0].take, 50);
  assert.equal(productFindManyCalls[0].select.rawPayload, undefined);
  assert.equal(productFindManyCalls[0].select.customerExternalId, undefined);
  assert.equal(packet.rejectedResults.length, 2);
  const productResult = packet.results.find((item) => item.id === "products");
  assert.ok(productResult);
  assert.equal(productResult.rows[0].rawPayload, undefined);
  assert.equal(productResult.rows[0].customerName, undefined);
  // PII scrubbing removed 2026-08-13: row strings reach the prompt verbatim.
  assert.match(productResult.rows[0].title, /@/);
  assert.ok(productResult.rows[0].title.length > 0);
  assert.match(productResult.rows[0].title, /\[redacted-secret\]/);
  assert.match(productResult.rows[0].title, /customer \[redacted-name\]/i);
});

test("commerce analyst enforces shop scope before reading commerce rows", async () => {
  const prisma = {
    product: {
      findMany: async () => {
        throw new Error("product rows should not be read without shop scope");
      },
    },
  };

  const packet = await executeCommerceAnalystToolCalls(prisma, {
    merchantId: "m1",
    shopId: null,
    toolCalls: [{ id: "products", kind: "fetch_rows", entity: "products" }],
    logger: silentLogger,
  });

  assert.equal(packet.results.length, 0);
  assert.equal(packet.rejectedResults.length, 1);
  assert.match(packet.rejectedResults[0].error, /shopId is required/);
});

test("commerce analyst detects replenishment and quantitative commerce questions", () => {
  assert.equal(shouldAttemptCommerceAnalysis("How much should I purchase of each?"), true);
  assert.equal(shouldAttemptCommerceAnalysis("Can you quantify the predicted loss of revenue?"), true);
  assert.equal(shouldAttemptCommerceAnalysis("Which acquisition channels are working?"), true);
  assert.equal(shouldAttemptCommerceAnalysis("Why did you recommend this move?"), false);
});

function createTwoProductAnalystFixture({ mixedCurrency = false } = {}) {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const products = [
    { id: "p1", merchantId: "m1", shopId: "s1", title: "Picnic Xinomavro", vendor: "Picnic", productType: "Wine", status: "ACTIVE" },
    { id: "p2", merchantId: "m1", shopId: "s1", title: "Pear Skin Sipon", vendor: "Pear", productType: "Wine", status: "ACTIVE" },
  ];
  const variants = [
    { id: "v1", merchantId: "m1", shopId: "s1", productId: "p1", title: "Default", sku: "PX", price: 60, currency: "GBP", unitCost: 20 },
    { id: "v2", merchantId: "m1", shopId: "s1", productId: "p2", title: "Default", sku: "PS", price: 48, currency: "GBP", unitCost: 16 },
  ];
  const orders = [
    { id: "o1", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 180, totalDiscount: 0, processedAt: new Date(now.getTime() - 10 * 86400000), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
    { id: "o2", merchantId: "m1", shopId: "s1", currency: mixedCurrency ? "EUR" : "GBP", totalPrice: 144, totalDiscount: 0, processedAt: new Date(now.getTime() - 8 * 86400000), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
  ];
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const orderLineItems = [
    { merchantId: "m1", shopId: "s1", orderId: "o1", productId: "p1", variantId: "v1", sku: "PX", title: "Picnic Xinomavro", quantity: 3, unitPrice: 60, totalPrice: 180, discount: 0, order: orderById.get("o1") },
    { merchantId: "m1", shopId: "s1", orderId: "o2", productId: "p2", variantId: "v2", sku: "PS", title: "Pear Skin Sipon", quantity: 3, unitPrice: 48, totalPrice: 144, discount: 0, order: orderById.get("o2") },
    { merchantId: "m-other", shopId: "s-other", orderId: "o3", productId: "p3", variantId: "v3", sku: "LEAK", title: "Other Store", quantity: 99, unitPrice: 99, totalPrice: 9801, discount: 0, order: { id: "o3", currency: "GBP", processedAt: now, financialStatus: "paid", sourceName: "web", shippingCountry: "GB" } },
  ];
  const inventoryLevels = [
    { merchantId: "m1", shopId: "s1", variantId: "v1", available: 0 },
    { merchantId: "m1", shopId: "s1", variantId: "v2", available: 0 },
  ];
  return {
    actionContext: {
      actionRunId: "run-1",
      currentSystemContext: {
        blocks: [
          {
            kind: "structured_evidence",
            source: "merchant_memory",
            data: {
              key: "inventory.low_cover_products.trailing_30d",
              items: [
                { productId: "p1", variantId: "v1", title: "Picnic Xinomavro", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
                { productId: "p2", variantId: "v2", title: "Pear Skin Sipon", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
              ],
            },
          },
        ],
      },
    },
    prisma: {
      product: { findMany: async () => products },
      variant: { findMany: async () => variants },
      order: { findMany: async () => orders },
      orderLineItem: {
        findMany: async () => orderLineItems.filter((line) => line.merchantId === "m1" && line.shopId === "s1"),
      },
      inventoryLevel: { findMany: async () => inventoryLevels },
      refund: { findMany: async () => [] },
      actionExecution: { findMany: async () => [] },
    },
  };
}

test("a revenue question is totalled in base currency even when customers paid in several", async () => {
  const { prisma, actionContext } = createTwoProductAnalystFixture({ mixedCurrency: true });
  const provider = {
    provider: "mock",
    model: "mock-commerce-analyst",
    enabled: true,
    generateStructuredJson: async (request) => {
      if (request.prompt.includes("commerceAnalystToolCatalog")) {
        return {
          json: {
            toolCalls: [{
              id: "revenue",
              kind: "commerce_calculation",
              request: { id: "revenue", kind: "aggregate", measure: "revenue", window: { days: 30, label: "trailing_30d" } },
            }],
          },
          usage: {},
        };
      }
      // Force the deterministic fallback renderer, which is the surface under test.
      return { json: {}, usage: {} };
    },
  };

  const answer = await answerCommerceQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    message: "what is my revenue",
    actionContext,
    provider,
    logger: silentLogger,
  });

  const reply = String(answer?.reply ?? "");

  // 180 + 144 = 324. Both amounts are shopMoney in the shop's single base currency;
  // the differing order.currency values are PRESENTMENT codes (what the customer
  // paid in), not the denomination of the stored amount. Summing is correct, and
  // the belief layer sums the same way.
  assert.match(reply, /324/);
  // Never mislabel a base-currency amount with a presentment code, and never
  // dead-end on a total that is perfectly computable.
  assert.doesNotMatch(reply, /EUR 144/);
  assert.doesNotMatch(reply, /unavailable/i);
  assert.doesNotMatch(reply, /not added together/i);
});

test("product revenue questions force product-level ranking even when the planner asks for only a total", async () => {
  const { prisma, actionContext } = createTwoProductAnalystFixture();
  const provider = {
    provider: "mock",
    model: "mock-commerce-analyst",
    enabled: true,
    generateStructuredJson: async (request) => {
      if (request.prompt.includes("commerceAnalystToolCatalog")) {
        return {
          json: {
            toolCalls: [{
              id: "revenue",
              kind: "commerce_calculation",
              request: { id: "revenue", kind: "aggregate", measure: "revenue", window: { days: 30, label: "trailing_30d" } },
            }],
          },
          usage: {},
        };
      }
      return {
        json: { reply: "I don't have product-level revenue data, only total revenue." },
        usage: {},
      };
    },
  };

  const answer = await answerCommerceQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    message: "Which products drove revenue last month?",
    actionContext,
    provider,
    logger: silentLogger,
    now: new Date("2026-08-11T12:00:00.000Z"),
  });

  assert.equal(answer.source, "fallback");
  assert.match(answer.reply, /Picnic Xinomavro/);
  assert.match(answer.reply, /Pear Skin Sipon/);
  assert.doesNotMatch(answer.reply, /don't have product-level/i);
  const productRanking = answer.analysisPacket.results.find((item) => item.id === "sales_by_product");
  assert.ok(productRanking);
  assert.equal(productRanking.measure, "line_revenue");
  assert.deepEqual(productRanking.rows.map((row) => row.label), ["Picnic Xinomavro", "Pear Skin Sipon"]);
  assert.deepEqual(
    answer.analysisPacket.toolCalls.map((call) => call.resultId).filter(Boolean),
    ["sales_by_product", "revenue"],
  );
});

test("commerce analyst treats not-ingested Shopify evidence as unknown, not false", async () => {
  const prompts = [];
  const provider = {
    provider: "mock",
    model: "mock-commerce-analyst",
    enabled: true,
    generateStructuredJson: async (request) => {
      prompts.push(request);
      if (request.prompt.includes("commerceAnalystToolCatalog")) {
        return {
          json: {
            toolCalls: [
              {
                id: "acquisition_quality",
                kind: "shopify_query",
                toolName: "shopify_analyse_acquisition_quality",
                input: { window: { days: 90 } },
              },
            ],
          },
          usage: {},
        };
      }
      return { json: {}, usage: {} };
    },
  };

  const answer = await answerCommerceQuestion(createAttributionGapPrisma(), {
    merchantId: "m1",
    shopId: "s1",
    message: "Which acquisition channels are working?",
    provider,
    logger: silentLogger,
    now: new Date("2026-08-13T09:00:00.000Z"),
  });

  assert.match(prompts[0].prompt, /shopifyIntelligenceCatalog/);
  assert.match(prompts[1].prompt, /NOT_INGESTED/);
  assert.match(String(answer.reply), /NOT_INGESTED|not ingested|not asked/i);
  assert.doesNotMatch(String(answer.reply), /100% direct/i);
  assert.equal(answer.analysisPacket.dataQuality.evidenceAvailability.NOT_INGESTED > 0, true);
});

function createAttributionGapPrisma() {
  const now = new Date("2026-08-13T09:00:00.000Z");
  const orders = Array.from({ length: 12 }, (_, index) => ({
    id: `o${index}`,
    merchantId: "m1",
    shopId: "s1",
    totalPrice: 50,
    totalDiscount: 0,
    processedAt: new Date(now.getTime() - (index + 1) * 86400000),
    financialStatus: "paid",
    fulfillmentStatus: "fulfilled",
    sourceName: "web",
    attribution: {},
  }));
  return {
    order: { findMany: async () => orders },
  };
}
