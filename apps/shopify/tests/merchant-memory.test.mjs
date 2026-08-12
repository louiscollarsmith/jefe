import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  confirmBelief,
  correctBelief,
  getBelief,
  getBeliefsForMerchant,
  markBeliefObsolete,
  rebuildMerchantMemory,
  supersedeBelief,
  upsertDerivedBelief,
} from "../app/lib/merchant-memory/service.server.js";
import { processNextBackfillJob } from "../app/services/shopify-backfill-worker.server.js";
import { enqueueMerchantMemoryRefresh } from "../app/lib/merchant-memory/jobs.server.js";
import {
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
  MEMORY_REFRESH_JOB_TYPE,
} from "../app/lib/merchant-memory/constants.server.js";
import { evaluateConfidenceTemplate } from "../app/lib/merchant-memory/confidence-templates.server.js";
import { ratio, roundMoney } from "../app/lib/merchant-memory/calculation-primitives.server.js";
import { currentDefinitionVersion } from "../app/lib/merchant-memory/derivation-versioning.server.js";
import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { DETERMINISTIC_BELIEF_REGISTRY } from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";
import { numericTextIsGrounded } from "../app/lib/llm/numeric-grounding.server.js";

const databaseUrl = process.env.DATABASE_URL;
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("deterministic belief registry contains only vetted implementation tranches", () => {
  assert.equal(DETERMINISTIC_BELIEF_REGISTRY.length, 139);
  assert.deepEqual(
    new Set(DETERMINISTIC_BELIEF_REGISTRY.map((definition) => definition.tranche)),
    new Set([
      "0A — validate existing 19",
      "0B — data-quality guardrails",
      "1A — cheap deterministic expansion",
      "Product performance v1",
      "Customer memory v1",
      "Inventory velocity v1",
      "Attribute performance v1",
      "Seasonality v1",
      "Recommendation outcomes v1",
      "Clearance outcomes v1",
      "Action feedback v1",
      "Tool stack v1",
      "Business shape v1",
    ]),
  );
  assert.equal(
    DETERMINISTIC_BELIEF_REGISTRY.some(
      (definition) => definition.key === "refunds.total_refunded_amount.all_time",
    ),
    true,
  );
  assert.equal(
    currentDefinitionVersion(
      DETERMINISTIC_BELIEF_REGISTRY.find(
        (definition) => definition.key === "orders.total_order_count",
      ),
    ),
    "orders.total_order_count@v1",
  );
});

test("confidence templates are deterministic, clamped and preserve provenance", () => {
  const exact = evaluateConfidenceTemplate("exact_observation", {
    score: 1.2,
    source: "stored Shopify records",
  });
  const sample = evaluateConfidenceTemplate("sample_size_v1", {
    sampleSize: 10,
  });
  const composite = evaluateConfidenceTemplate("composite_min_v1", {
    components: [
      { template: "direct_observation_v1", params: { score: 0.95 } },
      { template: "coverage_based_v1", params: { coverage: 0.5 } },
    ],
  });

  assert.equal(exact.score, 0.98);
  assert.equal(exact.rawScore, 0.98);
  assert.equal(exact.template, "direct_observation_v1");
  assert.equal(exact.templateVersion, "v1");
  assert.equal(sample.template, "sample_size_v1");
  assert.equal(sample.score, 0.7);
  assert.equal(composite.template, "composite_min_v1");
  assert.equal(composite.score, 0.6);
  assert.equal(composite.composition, "minimum_component_score");
  assert.equal(
    evaluateConfidenceTemplate("unknown_template", { score: -1 }).score,
    0.6,
  );
});

test("calculation primitives centralise ratio and rounding semantics", () => {
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(1, 0, { zeroDenominator: "zero" }), 0);
  assert.equal(roundMoney(12.345), 12.35);
});

test("deterministic Shopify derivations gate unsafe refund amounts and separate inventory states", async () => {
  const prisma = createMockDerivationPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const skipped = new Map(result.skippedOutcomes.map((outcome) => [outcome.key, outcome]));

  assert.equal(result.registryDefinitionCount, 139);
  assert.equal(result.derivationReport.attempted, 139);
  assert.equal(
    result.derivationReport.published + result.derivationReport.suppressed,
    139,
  );
  assert.equal(result.derivationAttempts.length, 139);
  assert.equal(beliefs.get("catalog.has_product_variants").value.boolean, true);
  assert.equal(beliefs.get("catalog.has_product_variants").evidence.metadata.calculation, "exists(product where count(active variants for product) > 1)");
  assert.equal(beliefs.get("orders.average_order_value.all_time").value.amount, 100);
  assert.equal(
    beliefs.get("orders.average_order_value.all_time").value.orderValuePolicy.refunds,
    "excluded; refund amounts are reported separately when successful transaction coverage is available",
  );
  assert.equal(
    beliefs.get("data.order_history_completeness").value.historyKind,
    "all_stored_history",
  );
  assert.equal(
    beliefs.get("orders.average_order_value.all_time").derivationVersion,
    "orders.average_order_value.all_time@v1",
  );
  assert.equal(
    beliefs.get("orders.average_order_value.all_time").evidence.metadata.confidenceProvenance.template,
    "composite_min_v1",
  );
  assert.deepEqual(
    beliefs.get("orders.average_order_value.all_time").evidence.metadata.dataQualityFlags,
    ["low_sample", "partial_history"],
  );
  assert.equal(
    beliefs.get("orders.average_order_value.all_time").evidence.metadata.evidenceTemplate,
    "shopify_windowed_order_aggregate",
  );
  assert.equal(
    beliefs.get("data.refund_transaction_amount_coverage").value.percentage,
    0,
  );
  assert.equal(
    skipped.get("refunds.total_refunded_amount.all_time").status,
    "INSUFFICIENT_DATA",
  );
  assert.equal(beliefs.has("inventory.total_tracked_units"), false);
  assert.equal(
    skipped.get("inventory.total_tracked_units").status,
    "NOT_APPLICABLE",
  );
  assert.equal(skipped.get("inventory.total_tracked_units").publish, false);
  assert.equal(beliefs.get("inventory.positive_available_units").value.count, 5);
  assert.ok(
    [0.98, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6].includes(
      beliefs.get("inventory.positive_available_units").confidence,
    ),
  );
  assert.ok(
    beliefs.get("inventory.positive_available_units").evidence.metadata.confidenceProvenance.params.ageHours <= 2,
  );
  assert.equal(beliefs.get("inventory.negative_inventory_unit_magnitude").value.count, 2);
  assert.equal(beliefs.get("customers.repeat_customer_rate.all_time").value.percentage, 50);
});

function createProductPerformancePrisma(orderCount) {
  const products = [
    { id: "prod-alpha", title: "Alpha", status: "ACTIVE" },
    { id: "prod-bravo", title: "Bravo", status: "ACTIVE" },
    { id: "prod-charlie", title: "Charlie", status: "ACTIVE" },
  ];
  const variants = [
    { id: "var-alpha", productId: "prod-alpha", sku: "A", title: "A", price: "100.00", currency: "GBP", unitCost: "40.00", inventoryItemExternalId: "inv-a" },
    { id: "var-bravo", productId: "prod-bravo", sku: "B", title: "B", price: "50.00", currency: "GBP", unitCost: "30.00", inventoryItemExternalId: "inv-b" },
    { id: "var-charlie", productId: "prod-charlie", sku: "C", title: "C", price: "25.00", currency: "GBP", unitCost: "10.00", inventoryItemExternalId: "inv-c" },
  ];
  const now = Date.now();
  const orders = [];
  const lineItems = [];
  for (let index = 0; index < orderCount; index += 1) {
    const isAlpha = index % 5 < 3;
    const id = `perf-order-${index + 1}`;
    const price = isAlpha ? "100.00" : "50.00";
    const at = new Date(now - (index + 1) * 24 * 60 * 60 * 1000);
    orders.push({ id, externalId: `perf-x-${index + 1}`, currency: "GBP", totalPrice: price, totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `perf-c-${index + 1}`, financialStatus: "PAID" });
    lineItems.push({ orderId: id, productId: isAlpha ? "prod-alpha" : "prod-bravo", variantId: isAlpha ? "var-alpha" : "var-bravo", quantity: 1, unitPrice: price, totalPrice: price });
  }
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "perf.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Perf Shop", iana_timezone: "Europe/London" },
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
    inventoryLevel: { findMany: async () => [] },
  };
}

test("product-performance beliefs derive concentration, bestsellers and dead stock", async () => {
  const prisma = createProductPerformancePrisma(10);
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const bands = [0.98, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6];

  assert.equal(beliefs.get("products.selling_product_count.trailing_90d").value.count, 2);
  assert.equal(beliefs.get("products.no_sale_active_product_count.trailing_90d").value.count, 1);
  assert.equal(beliefs.get("products.top_product_revenue_share.trailing_90d").value.percentage, 75);
  assert.equal(beliefs.get("products.top_5_product_revenue_share.trailing_90d").value.percentage, 100);

  const byRevenue = beliefs.get("products.bestseller_by_revenue.trailing_90d");
  assert.equal(byRevenue.valueType, "structured");
  assert.equal(byRevenue.value.productId, "prod-alpha");
  assert.equal(byRevenue.value.title, "Alpha");
  assert.equal(byRevenue.value.revenue, 600);
  assert.equal(byRevenue.value.revenueSharePercent, 75);

  const byUnits = beliefs.get("products.bestseller_by_units.trailing_90d");
  assert.equal(byUnits.value.productId, "prod-alpha");
  assert.equal(byUnits.value.units, 6);

  for (const key of [
    "products.selling_product_count.trailing_90d",
    "products.top_product_revenue_share.trailing_90d",
    "products.bestseller_by_revenue.trailing_90d",
  ]) {
    assert.ok(bands.includes(beliefs.get(key).confidence), `${key} confidence not in calibrated band`);
  }
});

test("structured belief shares/rates ground generated percent claims", () => {
  // Regression for the merchant-facing generators (insights/goals/plan): structured
  // beliefs must expose shares, rates and changes as *Percent fields (0-100), so a
  // generator citing "75% of revenue" is accepted by the numeric-grounding guard
  // instead of being falsely rejected (which can hard-fail the whole generation).
  const bestseller = {
    key: "products.bestseller_by_revenue.trailing_90d",
    value: { title: "Alpha", revenue: 600, revenueSharePercent: 75, currency: "GBP" },
  };
  assert.equal(
    numericTextIsGrounded("Alpha is your top product at 600, 75% of revenue.", [bestseller]),
    true,
  );
  // The guard stays strict: an unsupported percentage is still rejected.
  assert.equal(numericTextIsGrounded("Alpha is 90% of revenue.", [bestseller]), false);

  const trend = {
    key: "business.revenue_trend.trailing_180d",
    value: { trend: "growing", changePercent: 25, recentRevenue: 1000, priorRevenue: 800 },
  };
  assert.equal(numericTextIsGrounded("Revenue is up 25% in the recent window.", [trend]), true);

  // The headline returned product sits at the value's top level (topReturnedProduct)
  // so it survives the generators' compactValue serialization; its rate grounds too.
  const returns = {
    key: "products.top_returned_products.trailing_180d",
    value: {
      topReturnedProduct: {
        title: "Beta",
        returnedUnits: 33,
        returnRatePercent: 33.33,
        refundValue: 500,
      },
      returnedProductCount: 4,
      currency: "GBP",
    },
  };
  assert.equal(
    numericTextIsGrounded("Beta is your most-returned product, a 33.33% return rate.", [returns]),
    true,
  );
});

function createCustomerMemoryPrisma() {
  const now = Date.now();
  // 5 repeat customers (>=2 orders) at 200 each; 10 one-time at 100 each.
  const customerIdentities = [
    ...Array.from({ length: 5 }, (_, i) => ({
      orderCount: 2,
      totalSpend: 200,
      rawPayload: { orderIds: [`r-${i}-a`, `r-${i}-b`] },
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      orderCount: 1,
      totalSpend: 100,
      rawPayload: { orderIds: [`o-${i}`] },
    })),
  ];
  // A few priced GBP orders so shop base currency resolves to GBP.
  const orders = Array.from({ length: 6 }, (_, i) => {
    const at = new Date(now - (i + 1) * 24 * 60 * 60 * 1000);
    return { id: `cust-order-${i + 1}`, externalId: `cust-x-${i + 1}`, currency: "GBP", totalPrice: "100.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `cust-c-${i + 1}`, financialStatus: "PAID" };
  });
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "cust.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Cust Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => customerIdentities },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("customer memory derives repeat revenue share, LTV and concentration (PII-safe)", async () => {
  const prisma = createCustomerMemoryPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["customers"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));

  const repeatShare = beliefs.get("customers.repeat_revenue_share.all_time");
  assert.equal(repeatShare.value.percentage, 50); // 1000 repeat / 2000 total
  assert.equal(repeatShare.value.repeatCustomerCount, 5);
  assert.equal(repeatShare.value.currency, "GBP");

  const ltv = beliefs.get("customers.average_lifetime_spend.all_time");
  assert.equal(ltv.valueType, "structured");
  assert.equal(ltv.value.averageLifetimeSpend, 133.33); // 2000 / 15
  assert.equal(ltv.value.repeatCustomerAverageSpend, 200);
  assert.equal(ltv.value.oneTimeCustomerAverageSpend, 100);
  assert.equal(ltv.value.customerCount, 15);

  const concentration = beliefs.get(
    "customers.top_customer_revenue_share.all_time",
  );
  assert.equal(concentration.value.percentage, 75); // top 10 (1500) / 2000
  assert.equal(concentration.value.topCustomerCount, 10);

  // PII-safe: no identity fields leak into any customer belief value.
  for (const key of [
    "customers.repeat_revenue_share.all_time",
    "customers.average_lifetime_spend.all_time",
    "customers.top_customer_revenue_share.all_time",
  ]) {
    const serialized = JSON.stringify(beliefs.get(key).value);
    assert.doesNotMatch(serialized, /email|maskedEmail|emailHash|@/i);
  }
});

function createInventoryVelocityPrisma() {
  const now = Date.now();
  const products = [
    { id: "prod-fast", title: "Fast Mover", status: "ACTIVE" },
    { id: "prod-slow", title: "Slow Mover", status: "ACTIVE" },
  ];
  const variants = [
    { id: "var-fast", productId: "prod-fast", sku: "F", title: "F", price: "20.00", currency: "GBP", inventoryItemExternalId: "inv-fast" },
    { id: "var-slow", productId: "prod-slow", sku: "S", title: "S", price: "20.00", currency: "GBP", inventoryItemExternalId: "inv-slow" },
  ];
  // Fast: 10 units in stock; Slow: 300 units in stock.
  const inventoryLevels = [
    { variantId: "var-fast", available: 10, inventoryItemExternalId: "inv-fast", locationExternalId: "loc-1", sourceUpdatedAt: new Date(now), observedAt: new Date(now) },
    { variantId: "var-slow", available: 300, inventoryItemExternalId: "inv-slow", locationExternalId: "loc-1", sourceUpdatedAt: new Date(now), observedAt: new Date(now) },
  ];
  // 15 orders across the last 15 days, each selling 2 Fast + 2 Slow => 30 units
  // of each over the 30-day window => a sell-rate of 1 unit/day each.
  const orders = [];
  const lineItems = [];
  for (let i = 0; i < 15; i += 1) {
    const id = `inv-order-${i + 1}`;
    const at = new Date(now - (i + 1) * 24 * 60 * 60 * 1000);
    orders.push({ id, externalId: `inv-x-${i + 1}`, currency: "GBP", totalPrice: "80.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `inv-c-${i + 1}`, financialStatus: "PAID" });
    lineItems.push({ orderId: id, productId: "prod-fast", variantId: "var-fast", quantity: 2, unitPrice: "20.00", totalPrice: "40.00" });
    lineItems.push({ orderId: id, productId: "prod-slow", variantId: "var-slow", quantity: 2, unitPrice: "20.00", totalPrice: "40.00" });
  }
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "inv.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Inv Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders", "read_inventory"] }],
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
    inventoryLevel: { findMany: async () => inventoryLevels },
  };
}

test("inventory velocity flags at-risk stockouts and the reorder list", async () => {
  const prisma = createInventoryVelocityPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["inventory"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));

  // Fast: 10 in stock / 1 per day = 10 days cover (< 21 => at risk).
  // Slow: 300 in stock / 1 per day = 300 days cover (not at risk).
  const atRisk = beliefs.get("inventory.at_risk_stockout_count.trailing_30d");
  assert.equal(atRisk.value.count, 1);

  const lowCover = beliefs.get("inventory.low_cover_products.trailing_30d");
  assert.equal(lowCover.valueType, "structured");
  assert.equal(lowCover.value.atRiskProductCount, 1);
  assert.equal(lowCover.value.topAtRiskProduct.title, "Fast Mover");
  assert.equal(lowCover.value.topAtRiskProduct.daysOfCover, 10);
  assert.equal(lowCover.value.items[0].available, 10);
  assert.equal(lowCover.value.items[0].dailyVelocity, 1);
});

function createRegionPrisma() {
  const now = Date.now();
  const orders = [];
  for (let i = 0; i < 10; i += 1) {
    const at = new Date(now - (i + 1) * 24 * 60 * 60 * 1000);
    // 6 orders ship to GB, 3 to US, 1 with no destination country.
    const country = i < 6 ? "GB" : i < 9 ? "US" : null;
    orders.push({
      id: `region-order-${i + 1}`,
      externalId: `region-x-${i + 1}`,
      currency: "GBP",
      totalPrice: "100.00",
      totalDiscount: "0.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `region-c-${i + 1}`,
      financialStatus: "PAID",
      shippingCountry: country,
    });
  }
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "region.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Region Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("revenue-by-region splits revenue by destination country, coverage-gated", async () => {
  const prisma = createRegionPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const region = beliefs.get("business.revenue_by_region.trailing_90d");

  // GB 600 + US 300 = 900 known of 1000 total => 90% coverage (>= 70%).
  assert.equal(region.valueType, "structured");
  assert.equal(region.value.countryCount, 2);
  assert.equal(region.value.knownRevenue, 900);
  assert.equal(region.value.topCountry.country, "GB");
  assert.equal(region.value.topCountry.revenue, 600);
  assert.equal(region.value.topCountry.sharePercent, 66.67);
  assert.equal(region.value.items[1].country, "US");
  assert.equal(region.value.items[1].sharePercent, 33.33);
  assert.equal(region.value.currency, "GBP");
});

function createRegionMarginPrisma() {
  const now = Date.now();
  const products = [
    { id: "prod-gb", title: "GB Line", status: "ACTIVE" },
    { id: "prod-us", title: "US Line", status: "ACTIVE" },
  ];
  // Same £100 price, different cost: GB cost 40 (60% margin), US cost 70 (30%).
  const variants = [
    { id: "var-gb", productId: "prod-gb", sku: "GB", title: "GB", price: "100.00", currency: "GBP", unitCost: "40.00", inventoryItemExternalId: "inv-gb" },
    { id: "var-us", productId: "prod-us", sku: "US", title: "US", price: "100.00", currency: "GBP", unitCost: "70.00", inventoryItemExternalId: "inv-us" },
  ];
  const orders = [];
  const lineItems = [];
  for (let i = 0; i < 10; i += 1) {
    const at = new Date(now - (i + 1) * 24 * 60 * 60 * 1000);
    const country = i < 6 ? "GB" : i < 9 ? "US" : null;
    const productId = country === "US" ? "prod-us" : "prod-gb";
    const variantId = country === "US" ? "var-us" : "var-gb";
    const id = `rm-order-${i + 1}`;
    orders.push({ id, externalId: `rm-x-${i + 1}`, currency: "GBP", totalPrice: "100.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `rm-c-${i + 1}`, financialStatus: "PAID", shippingCountry: country });
    lineItems.push({ orderId: id, productId, variantId, quantity: 1, unitPrice: "100.00", totalPrice: "100.00" });
  }
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "rm.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "RM Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders", "read_inventory"] }],
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
    inventoryLevel: { findMany: async () => [] },
  };
}

test("margin-by-region states gross margin per country, doubly coverage-gated", async () => {
  const prisma = createRegionMarginPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const margin = beliefs.get("business.margin_by_region.trailing_90d");

  assert.equal(margin.valueType, "structured");
  assert.equal(margin.value.regionCount, 2);
  // GB: (600 - 6*40) / 600 = 60%; US: (300 - 3*70) / 300 = 30%.
  assert.equal(margin.value.topRegion.country, "GB");
  assert.equal(margin.value.topRegion.marginPercent, 60);
  const us = margin.value.items.find((item) => item.country === "US");
  assert.equal(us.marginPercent, 30);
  assert.equal(margin.value.currency, "GBP");
});

function createDeadStockPrisma() {
  const now = Date.now();
  const products = [
    { id: "prod-dead", title: "Dead Widget", status: "ACTIVE" },
    { id: "prod-live", title: "Live Widget", status: "ACTIVE" },
  ];
  const variants = [
    { id: "var-dead", productId: "prod-dead", sku: "D", title: "D", price: "100.00", currency: "GBP", unitCost: "40.00", inventoryItemExternalId: "inv-d" },
    { id: "var-live", productId: "prod-live", sku: "L", title: "L", price: "100.00", currency: "GBP", unitCost: "40.00", inventoryItemExternalId: "inv-l" },
  ];
  const inventoryLevels = [
    { variantId: "var-dead", available: 10, inventoryItemExternalId: "inv-d", locationExternalId: "loc-1", sourceUpdatedAt: new Date(now), observedAt: new Date(now) },
    { variantId: "var-live", available: 5, inventoryItemExternalId: "inv-l", locationExternalId: "loc-1", sourceUpdatedAt: new Date(now), observedAt: new Date(now) },
  ];
  // 6 orders, all selling only the live product; the dead product never sells.
  const orders = [];
  const lineItems = [];
  for (let i = 0; i < 6; i += 1) {
    const at = new Date(now - (i + 1) * 24 * 60 * 60 * 1000);
    const id = `ds-order-${i + 1}`;
    orders.push({ id, externalId: `ds-x-${i + 1}`, currency: "GBP", totalPrice: "100.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `ds-c-${i + 1}`, financialStatus: "PAID" });
    lineItems.push({ orderId: id, productId: "prod-live", variantId: "var-live", quantity: 1, unitPrice: "100.00", totalPrice: "100.00" });
  }
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "ds.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "DS Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders", "read_inventory"] }],
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
    inventoryLevel: { findMany: async () => inventoryLevels },
  };
}

test("dead-stock belief surfaces in-stock, no-sale products with trapped capital", async () => {
  const prisma = createDeadStockPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const dead = beliefs.get("products.dead_stock.trailing_90d");

  assert.equal(dead.valueType, "structured");
  assert.equal(dead.value.deadStockProductCount, 1); // only the dead product
  assert.equal(dead.value.topDeadProduct.productId, "prod-dead");
  assert.equal(dead.value.topDeadProduct.trappedCapital, 400); // 10 units × £40 cost
  assert.equal(dead.value.totalTrappedCapital, 400);
  assert.equal(dead.value.currency, "GBP");
});

function createDiscountPrisma() {
  const now = Date.now();
  // 6 discounted orders (£90 + £10 off = £100 gross), 4 full-price (£100).
  const orders = [];
  for (let i = 0; i < 10; i += 1) {
    const at = new Date(now - (i + 1) * 24 * 60 * 60 * 1000);
    const discounted = i < 6;
    orders.push({
      id: `disc-order-${i + 1}`,
      externalId: `disc-x-${i + 1}`,
      currency: "GBP",
      totalPrice: discounted ? "90.00" : "100.00",
      totalDiscount: discounted ? "10.00" : "0.00",
      totalTax: "0.00",
      totalShipping: "0.00",
      processedAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      customerExternalId: `disc-c-${i + 1}`,
      financialStatus: "PAID",
    });
  }
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "disc.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Disc Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("discount-depth measures give-away share and penetration", async () => {
  const prisma = createDiscountPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const dd = beliefs.get("business.discount_depth.trailing_90d");

  // Discounts £60 of £1000 gross = 6%; 6 of 10 orders discounted = 60%.
  assert.equal(dd.value.percentage, 6);
  assert.equal(dd.value.discountedOrderSharePercent, 60);
  assert.equal(dd.value.totalDiscount, 60);
  assert.equal(dd.value.grossRevenue, 1000);
  assert.equal(dd.value.discountedOrderCount, 6);
  assert.equal(dd.value.currency, "GBP");
});

test("product-performance beliefs suppress below minimum order volume", async () => {
  const prisma = createProductPerformancePrisma(3);
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const skipped = new Map(result.skippedOutcomes.map((outcome) => [outcome.key, outcome]));
  assert.equal(skipped.get("products.selling_product_count.trailing_90d").status, "INSUFFICIENT_DATA");
  assert.equal(skipped.get("products.bestseller_by_revenue.trailing_90d").status, "INSUFFICIENT_DATA");
});

test("product-margin beliefs derive cost coverage and coverage-gated gross margin", async () => {
  const prisma = createProductPerformancePrisma(10);
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));
  const bands = [0.98, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6];

  assert.equal(beliefs.get("products.cost_coverage").value.percentage, 100);
  const margin = beliefs.get("products.gross_margin.trailing_90d");
  // Alpha 6 x (£100-£40) + Bravo 4 x (£50-£30): covered revenue £800, COGS £360 -> 55%.
  assert.equal(margin.value.percentage, 55);
  assert.equal(margin.value.coveredRevenue, 800);
  assert.equal(margin.value.revenueCoverage, 1);
  assert.ok(bands.includes(margin.confidence), "gross_margin confidence not in band");
});

test("gross margin suppresses when cost coverage is too thin, never guessed", async () => {
  const prisma = createProductPerformancePrisma(10);
  const variants = await prisma.variant.findMany();
  prisma.variant.findMany = async () =>
    variants.map((variant) =>
      variant.id === "var-alpha" ? { ...variant, unitCost: null } : variant,
    );
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const published = new Set(result.derivations.map((belief) => belief.key));
  const skippedKeys = new Set(result.skippedOutcomes.map((outcome) => outcome.key));
  // Alpha (~75% of revenue) loses its cost -> coverage < 70% -> margin suppressed, not guessed.
  assert.equal(published.has("products.gross_margin.trailing_90d"), false);
  assert.equal(skippedKeys.has("products.gross_margin.trailing_90d"), true);
  const coverage = new Map(result.derivations.map((b) => [b.key, b])).get(
    "products.cost_coverage",
  );
  assert.ok(coverage && coverage.value.percentage < 100);
});

test("revenue and margin beliefs normalize to shop base currency (multi-currency store)", async () => {
  const prisma = createProductPerformancePrisma(10);
  // A single store selling internationally: orders carry different *presentment*
  // currencies, but Shopify stamps every amount in the shop's base currency
  // (shopMoney), which is what we store — so beliefs must NOT skip on it.
  const orders = await prisma.order.findMany();
  prisma.order.findMany = async () =>
    orders.map((order, index) => ({
      ...order,
      currency: index % 5 === 0 ? "EUR" : index % 5 === 1 ? "USD" : "GBP",
    }));
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const beliefs = new Map(result.derivations.map((b) => [b.key, b]));
  // Publishes despite mixed presentment currencies (amounts are shop-currency).
  assert.equal(
    beliefs.get("products.top_product_revenue_share.trailing_90d").value.percentage,
    75,
  );
  const margin = beliefs.get("products.gross_margin.trailing_90d");
  assert.equal(margin.value.percentage, 55);
  // Labeled with the dominant base-currency proxy (GBP here), not skipped.
  assert.equal(margin.value.currency, "GBP");
});

test("online revenue share splits store vs online revenue from sourceName", async () => {
  const prisma = createProductPerformancePrisma(10);
  const orders = await prisma.order.findMany();
  // Uniform £100 orders: 7 online ("web") + 3 in-store ("pos") -> 70% online.
  prisma.order.findMany = async () =>
    orders.map((order, index) => ({
      ...order,
      totalPrice: "100.00",
      sourceName: index < 7 ? "web" : "pos",
    }));
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const share = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.online_revenue_share.trailing_90d",
  );
  assert.ok(share, "online_revenue_share should publish");
  assert.equal(share.value.percentage, 70);
  assert.equal(share.value.channelCoverage, 1);
  assert.equal(share.value.currency, "GBP");
  assert.equal(share.value.channels.online, 700);
  assert.equal(share.value.channels.pos, 300);
});

function createReturnsPrisma() {
  const products = [
    { id: "prod-alpha", title: "Alpha", status: "ACTIVE" },
    { id: "prod-bravo", title: "Bravo", status: "ACTIVE" },
  ];
  const variants = [
    { id: "var-alpha", productId: "prod-alpha", sku: "A", title: "A", price: "100.00", currency: "GBP", inventoryItemExternalId: "inv-a" },
    { id: "var-bravo", productId: "prod-bravo", sku: "B", title: "B", price: "100.00", currency: "GBP", inventoryItemExternalId: "inv-b" },
  ];
  const now = Date.now();
  const orders = [];
  const lineItems = [];
  for (let index = 0; index < 10; index += 1) {
    const isAlpha = index < 6;
    const id = `ro-${index + 1}`;
    const at = new Date(now - (index + 1) * 24 * 60 * 60 * 1000);
    orders.push({ id, externalId: `rox-${index + 1}`, currency: "GBP", totalPrice: "100.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `rc-${index + 1}`, financialStatus: "PAID" });
    lineItems.push({ orderId: id, externalId: `gid://shopify/LineItem/${index + 1}`, productId: isAlpha ? "prod-alpha" : "prod-bravo", variantId: isAlpha ? "var-alpha" : "var-bravo", quantity: 1, unitPrice: "100.00", totalPrice: "100.00" });
  }
  const refundNode = (lineItemExternalId, productExternalId) => ({
    node: { quantity: 1, subtotalSet: { shopMoney: { amount: "100.00", currencyCode: "GBP" } }, lineItem: { id: lineItemExternalId, product: { id: productExternalId } } },
  });
  const refunds = [
    { orderId: "ro-1", amount: "100.00", currency: "GBP", processedAt: new Date(now - 2 * 24 * 60 * 60 * 1000), rawPayload: { refundLineItems: { edges: [refundNode("gid://shopify/LineItem/1", "gid-alpha")] } } },
    { orderId: "ro-2", amount: "100.00", currency: "GBP", processedAt: new Date(now - 3 * 24 * 60 * 60 * 1000), rawPayload: { refundLineItems: { edges: [refundNode("gid://shopify/LineItem/2", "gid-alpha")] } } },
    // REST webhook shape with a numeric line_item_id: the real-time refund path
    // must map to the same product as the GraphQL backfill shape above.
    { orderId: "ro-7", amount: "100.00", currency: "GBP", processedAt: new Date(now - 4 * 24 * 60 * 60 * 1000), rawPayload: { refund_line_items: [{ line_item_id: 7, quantity: 1, subtotal_set: { shop_money: { amount: "100.00", currency_code: "GBP" } } }] } },
  ];
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Returns Merchant",
        shops: [{ id: "shop-test", shopDomain: "r.myshopify.com", historicalOrderAccess: "unknown", backfillCompletedAt: new Date(), rawPayload: { name: "R", iana_timezone: "Europe/London" }, connectorAccounts: [{ scopes: ["read_orders"] }], backfillStatuses: [{ domain: "orders", status: "complete" }] }],
      }),
    },
    product: { findMany: async () => products },
    variant: { findMany: async () => variants },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => lineItems },
    refund: { findMany: async () => refunds },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("top-returned-products maps GraphQL and REST webhook refund line items to products", async () => {
  const prisma = createReturnsPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const belief = new Map(result.derivations.map((b) => [b.key, b])).get(
    "products.top_returned_products.trailing_180d",
  );
  assert.ok(belief, "top_returned_products should publish");
  // Alpha: 2 returned of 6 sold -> 0.3333; Bravo: 1 of 4 -> 0.25.
  assert.equal(belief.value.items[0].productId, "prod-alpha");
  assert.equal(belief.value.items[0].returnedUnits, 2);
  assert.equal(belief.value.items[0].soldUnits, 6);
  assert.equal(belief.value.items[0].returnRatePercent, 33.33);
  assert.equal(belief.value.items[0].refundValue, 200);
  assert.equal(belief.value.items[1].productId, "prod-bravo");
  assert.equal(belief.value.items[1].returnedUnits, 1);
});

function createAttributePrisma() {
  const products = [
    { id: "prod-a", title: "A", status: "ACTIVE", productType: "Shirts", vendor: "Acme" },
    { id: "prod-b", title: "B", status: "ACTIVE", productType: "Shirts", vendor: "Beta" },
    { id: "prod-c", title: "C", status: "ACTIVE", productType: "Hats", vendor: "Acme" },
  ];
  const variants = [
    { id: "var-a", productId: "prod-a", sku: "A", title: "A", price: "100.00", currency: "GBP" },
    { id: "var-b", productId: "prod-b", sku: "B", title: "B", price: "100.00", currency: "GBP" },
    { id: "var-c", productId: "prod-c", sku: "C", title: "C", price: "100.00", currency: "GBP" },
  ];
  const now = Date.now();
  const orders = [];
  const lineItems = [];
  // 6x A (600), 3x B (300), 1x C (100) => total 1000. Types: Shirts 900 / Hats
  // 100. Vendors: Acme 700 (A+C) / Beta 300 (B).
  const plan = [...Array(6).fill("prod-a"), ...Array(3).fill("prod-b"), "prod-c"];
  plan.forEach((productId, index) => {
    const id = `ao-${index + 1}`;
    const at = new Date(now - (index + 1) * 24 * 60 * 60 * 1000);
    orders.push({ id, externalId: `aox-${index + 1}`, currency: "GBP", totalPrice: "100.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `ac-${index + 1}`, financialStatus: "PAID" });
    const variantId = productId === "prod-a" ? "var-a" : productId === "prod-b" ? "var-b" : "var-c";
    lineItems.push({ orderId: id, productId, variantId, quantity: 1, unitPrice: "100.00", totalPrice: "100.00" });
  });
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "attr.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(),
            rawPayload: { name: "Attr Shop", iana_timezone: "Europe/London" },
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
    inventoryLevel: { findMany: async () => [] },
  };
}

test("attribute-level performance groups revenue by product type and vendor", async () => {
  const prisma = createAttributePrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const beliefs = new Map(result.derivations.map((belief) => [belief.key, belief]));

  const byType = beliefs.get("products.revenue_by_product_type.trailing_90d");
  assert.equal(byType.valueType, "structured");
  assert.equal(byType.value.topType.name, "Shirts");
  assert.equal(byType.value.topType.sharePercent, 90); // (600+300)/1000
  assert.equal(byType.value.typeCount, 2);
  assert.equal(byType.value.items[0].revenue, 900);

  const byVendor = beliefs.get("products.revenue_by_vendor.trailing_90d");
  assert.equal(byVendor.value.topVendor.name, "Acme");
  assert.equal(byVendor.value.topVendor.sharePercent, 70); // (600+100)/1000
  assert.equal(byVendor.value.vendorCount, 2);
});

function createSeasonalityPrisma() {
  const orders = [];
  let index = 0;
  const push = (date) => {
    index += 1;
    orders.push({ id: `so-${index}`, externalId: `sox-${index}`, currency: "GBP", totalPrice: "100.00", totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: date, sourceCreatedAt: date, sourceUpdatedAt: date, customerExternalId: `sc-${index}`, financialStatus: "PAID" });
  };
  // One order on the 15th of each month, Jan 2025 through Jun 2026.
  for (let year = 2025; year <= 2026; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      if (year === 2026 && month > 5) break;
      push(new Date(Date.UTC(year, month, 15, 12, 0, 0)));
    }
  }
  // Extra November 2025 orders make it the unambiguous peak.
  for (let i = 0; i < 6; i += 1) push(new Date(Date.UTC(2025, 10, 10 + i, 12, 0, 0)));
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "seas.myshopify.com",
            historicalOrderAccess: "all",
            availableOrderHistoryDays: 720,
            backfillCompletedAt: new Date(Date.UTC(2026, 6, 1)),
            rawPayload: { name: "Seas Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders", "read_all_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("seasonality identifies the peak sales month across a year of history", async () => {
  const prisma = createSeasonalityPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const belief = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.peak_sales_month.all_time",
  );
  assert.ok(belief, "peak_sales_month should publish");
  assert.equal(belief.value.peakMonth, "November");
  assert.equal(belief.value.peakMonthNumber, 11);
  assert.equal(belief.value.currency, "GBP");
  assert.equal(belief.value.monthlyBreakdown.length, 12);
});

function createRecommendationPrisma() {
  const at = new Date(Date.UTC(2026, 5, 1));
  const recommendations = [
    { reviewStatus: "completed", acceptedAt: at, rejectedAt: null, completedAt: at },
    { reviewStatus: "accepted", acceptedAt: at, rejectedAt: null, completedAt: null },
    { reviewStatus: "accepted", acceptedAt: at, rejectedAt: null, completedAt: null },
    { reviewStatus: "rejected", acceptedAt: null, rejectedAt: at, completedAt: null },
    { reviewStatus: "proposed", acceptedAt: null, rejectedAt: null, completedAt: null },
  ];
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "rec.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: new Date(Date.UTC(2026, 6, 1)),
            rawPayload: { name: "Rec Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => [] },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
    merchantPlanRecommendation: { findMany: async () => recommendations },
  };
}

test("recommendation engagement summarizes accept/complete outcomes (Observe->Learn)", async () => {
  const prisma = createRecommendationPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const belief = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.recommendation_engagement.all_time",
  );
  assert.ok(belief, "recommendation_engagement should publish");
  assert.equal(belief.value.totalRecommendations, 5);
  assert.equal(belief.value.acceptedCount, 3); // 2 accepted + 1 completed
  assert.equal(belief.value.completedCount, 1);
  assert.equal(belief.value.rejectedCount, 1);
  assert.equal(belief.value.acceptanceRatePercent, 60); // 3/5
  assert.equal(belief.value.completionRatePercent, 20); // 1/5
});

function createClearancePrisma() {
  const at = new Date(Date.UTC(2026, 6, 1));
  // Three MEASURED clearance runs on the ledger: two moved stock, one didn't.
  const outcomes = [
    { outcome: { variantsCleared: 3, variantsSold: 2, unitsMoved: 5, revenueRecovered: 255 }, appliedAt: at },
    { outcome: { variantsCleared: 2, variantsSold: 2, unitsMoved: 4, revenueRecovered: 180 }, appliedAt: at },
    { outcome: { variantsCleared: 4, variantsSold: 0, unitsMoved: 0, revenueRecovered: 0 }, appliedAt: at },
  ];
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "clr.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: at,
            rawPayload: { name: "Clr Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => [] },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
    actionExecution: { findMany: async () => outcomes },
  };
}

test("clearance effectiveness aggregates measured outcomes (Observe->Learn)", async () => {
  const prisma = createClearancePrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const belief = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.clearance_effectiveness.all_time",
  );
  assert.ok(belief, "clearance_effectiveness should publish");
  assert.equal(belief.value.measuredRuns, 3);
  assert.equal(belief.value.runsThatMovedStock, 2); // runs 1 + 2 sold, run 3 didn't
  assert.equal(belief.value.variantsCleared, 9); // 3 + 2 + 4
  assert.equal(belief.value.variantsSold, 4); // 2 + 2 + 0
  assert.equal(belief.value.unitsMoved, 9); // 5 + 4 + 0
  assert.equal(belief.value.revenueRecovered, 435); // 255 + 180 + 0
  assert.equal(belief.value.runEffectivenessPercent, 66.67); // 2/3
  assert.equal(belief.value.variantSellThroughPercent, 44.44); // 4/9
});

function createDeclinePrisma() {
  const at = new Date(Date.UTC(2026, 6, 1));
  // Four declined actions; "too_aggressive" is the most common reason category.
  const declines = [
    { properties: { actionType: "price_markdown", reasonCategory: "too_aggressive", reasonText: null } },
    { properties: { actionType: "price_markdown", reasonCategory: "too_aggressive", reasonText: null } },
    { properties: { actionType: "price_markdown", reasonCategory: "wrong_products", reasonText: null } },
    { properties: { actionType: "price_markdown", reasonCategory: "bad_timing", reasonText: null } },
  ];
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Mock Merchant",
        shops: [
          {
            id: "shop-test",
            shopDomain: "dcl.myshopify.com",
            historicalOrderAccess: "unknown",
            backfillCompletedAt: at,
            rawPayload: { name: "Dcl Shop", iana_timezone: "Europe/London" },
            connectorAccounts: [{ scopes: ["read_orders"] }],
            backfillStatuses: [{ domain: "orders", status: "complete" }],
          },
        ],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => [] },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
    activityEvent: { findMany: async () => declines },
  };
}

test("action decline signal aggregates reason categories (Observe->Learn)", async () => {
  const prisma = createDeclinePrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const belief = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.action_decline_signal.all_time",
  );
  assert.ok(belief, "action_decline_signal should publish");
  assert.equal(belief.value.totalDeclines, 4);
  assert.equal(belief.value.topReasonCategory, "too_aggressive"); // 2 of 4
  assert.equal(belief.value.topReasonSharePercent, 50); // 2/4
  assert.equal(belief.value.byReasonCategory.too_aggressive, 2);
  assert.equal(belief.value.byReasonCategory.wrong_products, 1);
  assert.equal(belief.value.byActionType.price_markdown, 4);
});

function createMomentumPrisma() {
  const products = [
    { id: "prod-alpha", title: "Alpha", status: "ACTIVE" },
    { id: "prod-bravo", title: "Bravo", status: "ACTIVE" },
  ];
  const variants = [
    { id: "var-alpha", productId: "prod-alpha", sku: "A", title: "A", price: "100.00", currency: "GBP", inventoryItemExternalId: "inv-a" },
    { id: "var-bravo", productId: "prod-bravo", sku: "B", title: "B", price: "100.00", currency: "GBP", inventoryItemExternalId: "inv-b" },
  ];
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const orders = [];
  const lineItems = [];
  let n = 0;
  const addOrder = (daysAgo, productId, variantId, amount) => {
    n += 1;
    const id = `mo-${n}`;
    const at = new Date(now - daysAgo * day);
    orders.push({ id, externalId: `mox-${n}`, currency: "GBP", totalPrice: amount, totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `mc-${n}`, financialStatus: "PAID" });
    lineItems.push({ orderId: id, externalId: `mli-${n}`, productId, variantId, quantity: 1, unitPrice: amount, totalPrice: amount });
  };
  // Prior window (35-56 days ago): Alpha high (£100 x5), Bravo low (£20 x5).
  for (const d of [35, 40, 45, 50, 55]) addOrder(d, "prod-alpha", "var-alpha", "100.00");
  for (const d of [36, 41, 46, 51, 56]) addOrder(d, "prod-bravo", "var-bravo", "20.00");
  // Current window (5-26 days ago): Alpha low (£20 x5), Bravo high (£100 x5).
  for (const d of [5, 10, 15, 20, 25]) addOrder(d, "prod-alpha", "var-alpha", "20.00");
  for (const d of [6, 11, 16, 21, 26]) addOrder(d, "prod-bravo", "var-bravo", "100.00");
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Momentum Merchant",
        shops: [{ id: "shop-test", shopDomain: "m.myshopify.com", historicalOrderAccess: "unknown", backfillCompletedAt: new Date(), rawPayload: { name: "M", iana_timezone: "Europe/London" }, connectorAccounts: [{ scopes: ["read_orders"] }], backfillStatuses: [{ domain: "orders", status: "complete" }] }],
      }),
    },
    product: { findMany: async () => products },
    variant: { findMany: async () => variants },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => lineItems },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("product momentum flags risers and fallers, current 30d vs prior 30d", async () => {
  const prisma = createMomentumPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["products"],
  });
  const m = new Map(result.derivations.map((b) => [b.key, b])).get(
    "products.product_momentum.trailing_60d",
  );
  assert.ok(m, "product_momentum should publish");
  // Alpha £500->£100 (declining); Bravo £100->£500 (rising).
  assert.equal(m.value.risingProductCount, 1);
  assert.equal(m.value.decliningProductCount, 1);
  assert.equal(m.value.topRiser.productId, "prod-bravo");
  assert.equal(m.value.topFaller.productId, "prod-alpha");
});

function createYoyPrisma() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const orders = [];
  let n = 0;
  const addOrder = (daysAgo, amount) => {
    n += 1;
    const id = `yo-${n}`;
    const at = new Date(now - daysAgo * day);
    orders.push({ id, externalId: `yox-${n}`, currency: "GBP", totalPrice: amount, totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `yc-${n}`, financialStatus: "PAID" });
  };
  for (let i = 0; i < 10; i += 1) addOrder(5 + i * 5, "100.00"); // current 90d: 10 x £100
  for (let i = 0; i < 10; i += 1) addOrder(370 + i * 5, "80.00"); // same 90d a year ago: 10 x £80
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "YoY Merchant",
        shops: [{ id: "shop-test", shopDomain: "y.myshopify.com", historicalOrderAccess: "all_orders", backfillCompletedAt: new Date(), rawPayload: { name: "Y", iana_timezone: "Europe/London" }, connectorAccounts: [{ scopes: ["read_all_orders"] }], backfillStatuses: [{ domain: "orders", status: "complete" }] }],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("year-over-year revenue growth compares trailing 90d to a year prior", async () => {
  const prisma = createYoyPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const yoy = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.yoy_revenue_growth.trailing_90d",
  );
  assert.ok(yoy, "yoy_revenue_growth should publish");
  // £1000 now vs £800 a year ago -> +25%.
  assert.equal(yoy.value.percentage, 25);
  assert.equal(yoy.value.currentRevenue, 1000);
  assert.equal(yoy.value.priorYearRevenue, 800);
});

function createTrendPrisma() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const orders = [];
  let n = 0;
  const addOrder = (daysAgo, amount) => {
    n += 1;
    const id = `to-${n}`;
    const at = new Date(now - daysAgo * day);
    orders.push({ id, externalId: `tox-${n}`, currency: "GBP", totalPrice: amount, totalDiscount: "0.00", totalTax: "0.00", totalShipping: "0.00", processedAt: at, sourceCreatedAt: at, sourceUpdatedAt: at, customerExternalId: `tc-${n}`, financialStatus: "PAID" });
  };
  for (let i = 0; i < 10; i += 1) addOrder(5 + i * 4, "100.00"); // recent 90d: 10 x £100
  for (let i = 0; i < 10; i += 1) addOrder(100 + i * 4, "80.00"); // prior 90d: 10 x £80
  return {
    merchant: {
      findUniqueOrThrow: async () => ({
        id: "merchant-test",
        name: "Trend Merchant",
        shops: [{ id: "shop-test", shopDomain: "t.myshopify.com", historicalOrderAccess: "all_orders", backfillCompletedAt: new Date(), rawPayload: { name: "T", iana_timezone: "Europe/London" }, connectorAccounts: [{ scopes: ["read_all_orders"] }], backfillStatuses: [{ domain: "orders", status: "complete" }] }],
      }),
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
    order: { findMany: async () => orders },
    orderLineItem: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    customerIdentity: { findMany: async () => [] },
    inventoryLevel: { findMany: async () => [] },
  };
}

test("recent revenue trend compares last 90d to the prior 90d", async () => {
  const prisma = createTrendPrisma();
  const result = await deriveMerchantMemoryBeliefs(prisma, {
    merchantId: "merchant-test",
    shopId: "shop-test",
    categories: ["business"],
  });
  const trend = new Map(result.derivations.map((b) => [b.key, b])).get(
    "business.revenue_trend.trailing_180d",
  );
  assert.ok(trend, "revenue_trend should publish");
  // £1000 recent vs £800 prior -> +25% -> growing.
  assert.equal(trend.value.trend, "growing");
  assert.equal(trend.value.changePercent, 25);
  assert.equal(trend.value.recentRevenue, 1000);
  assert.equal(trend.value.priorRevenue, 800);
});

test("derived belief version bump creates supersession lineage without touching authoritative beliefs", async () => {
  const now = new Date("2026-07-23T12:00:00Z");
  const existing = {
    id: "belief-old",
    merchantId: "merchant-test",
    shopId: "shop-test",
    category: "orders",
    key: "orders.total_order_count",
    value: { count: 1 },
    valueType: "number",
    status: BELIEF_STATUS.inferred,
    confidence: "0.9000",
    confidenceReason: "old",
    precedence: 20,
    derivationVersion: "orders.total_order_count@v1",
    firstObservedAt: now,
    lastObservedAt: now,
    lastEvaluatedAt: now,
    updatedAt: now,
  };
  const prisma = createMockServicePrisma([existing]);
  const next = await upsertDerivedBelief(prisma, derivedBeliefInput({
    key: "orders.total_order_count",
    value: { count: 2 },
    derivationVersion: "orders.total_order_count@v2",
  }));

  assert.equal(next.superseded, true);
  assert.equal(next.belief.supersedesBeliefId, "belief-old");
  assert.equal(prisma.rows.find((belief) => belief.id === "belief-old").status, BELIEF_STATUS.superseded);
  assert.equal(prisma.rows.filter((belief) => belief.status === BELIEF_STATUS.inferred).length, 1);
  assert.equal(prisma.history.some((item) => item.changeReason === "derived_belief_superseded_by_new_derivation_version"), true);

  const sameVersion = await upsertDerivedBelief(prisma, derivedBeliefInput({
    key: "orders.total_order_count",
    value: { count: 3 },
    derivationVersion: "orders.total_order_count@v2",
  }));
  assert.equal(sameVersion.belief.id, next.belief.id);
  assert.equal(prisma.rows.filter((belief) => belief.key === "orders.total_order_count").length, 2);

  const authoritative = createMockServicePrisma([
    {
      ...existing,
      id: "belief-authoritative",
      status: BELIEF_STATUS.merchantCorrected,
      derivationVersion: "orders.total_order_count@v1",
    },
  ]);
  const skipped = await upsertDerivedBelief(authoritative, derivedBeliefInput({
    key: "orders.total_order_count",
    value: { count: 99 },
    derivationVersion: "orders.total_order_count@v2",
  }));
  assert.equal(skipped.skipped, true);
  assert.equal(authoritative.rows[0].status, BELIEF_STATUS.merchantCorrected);
});

test("Merchant Memory rebuild creates structured beliefs, evidence and idempotent active rows", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);

    const first = await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });
    const second = await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    const beliefs = await getBeliefsForMerchant(prisma, {
      merchantId: merchant.id,
      includeEvidence: true,
    });
    const averageOrderValue = beliefs.find(
      (belief) => belief.key === "orders.average_order_value.all_time",
    );
    const repeatRate = beliefs.find(
      (belief) => belief.key === "customers.repeat_customer_rate.all_time",
    );
    const piiInEvidence = beliefs.some((belief) =>
      (belief.evidence ?? []).some((item) =>
        `${item.summary} ${JSON.stringify(item.metadata)}`.includes("@example.com"),
      ),
    );

    assert.ok(first.createdOrUpdated >= 10);
    assert.equal(second.skipped, second.skippedOutcomes.length);
    assert.equal(averageOrderValue.value.amount, 75);
    assert.equal(averageOrderValue.value.currency, "GBP");
    assert.equal(repeatRate, undefined);
    assert.equal(
      second.skippedOutcomes.some(
        (outcome) => outcome.key === "customers.repeat_customer_rate.all_time",
      ),
      true,
    );
    assert.equal(piiInEvidence, false);

    const activeBeliefRows = await prisma.merchantMemoryBelief.findMany({
      where: {
        merchantId: merchant.id,
        key: "orders.average_order_value.all_time",
        status: { in: ["inferred", "merchant_confirmed", "merchant_corrected"] },
      },
    });
    const evidenceCount = await prisma.merchantMemoryEvidence.count({
      where: { merchantId: merchant.id },
    });
    const runCount = await prisma.merchantMemoryRefreshRun.count({
      where: { merchantId: merchant.id, status: "completed" },
    });

    assert.equal(activeBeliefRows.length, 1);
    assert.ok(evidenceCount >= beliefs.length);
    assert.equal(runCount, 2);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Merchant-authoritative corrections are not overwritten by recalculation", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });
    await correctBelief(prisma, {
      merchantId: merchant.id,
      key: "orders.total_order_count",
      value: { count: 999, correctionNote: "Imported test orders excluded." },
      valueType: "number",
      correctedBy: "merchant:test",
    });

    const result = await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      categories: ["orders"],
      logger: silentLogger,
    });
    const corrected = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "orders.total_order_count",
    });
    const skipHistory = await prisma.merchantMemoryBeliefHistory.count({
      where: {
        merchantId: merchant.id,
        key: "orders.total_order_count",
        changeReason: "derived_recalculation_skipped_authoritative_belief",
      },
    });

    assert.equal(result.skipped, result.skippedOutcomes.length + 1);
    assert.equal(corrected.status, BELIEF_STATUS.merchantCorrected);
    assert.equal(corrected.value.count, 999);
    assert.equal(skipHistory, 1);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Belief writes are atomic: a failure before evidence rolls back belief and history", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    const before = await prisma.merchantMemoryBelief.findFirstOrThrow({
      where: {
        merchantId: merchant.id,
        key: "orders.total_order_count",
        status: { in: ["inferred", "merchant_confirmed", "merchant_corrected"] },
      },
    });

    // Simulate a failure between the belief write and the evidence write by
    // making evidence.create throw *inside* the interactive transaction.
    await assert.rejects(
      () =>
        correctBelief(evidenceFailingClient(prisma), {
          merchantId: merchant.id,
          key: "orders.total_order_count",
          value: { count: 4242 },
          valueType: "number",
          correctedBy: "merchant:atomic",
          evidenceSummary: "This correction must never persist.",
        }),
      /simulated evidence failure/,
    );

    const after = await prisma.merchantMemoryBelief.findFirstOrThrow({
      where: { id: before.id },
    });
    const correctionHistory = await prisma.merchantMemoryBeliefHistory.count({
      where: {
        merchantId: merchant.id,
        key: "orders.total_order_count",
        changeReason: "merchant_corrected_belief",
      },
    });
    const correctionEvidence = await prisma.merchantMemoryEvidence.count({
      where: { merchantId: merchant.id, beliefId: before.id, evidenceType: "merchant_correction" },
    });

    // Whole unit rolled back: no partial belief, no orphaned history/evidence.
    assert.equal(after.status, BELIEF_STATUS.inferred);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.value, before.value);
    assert.equal(correctionHistory, 0);
    assert.equal(correctionEvidence, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Confirming an observation records the confirmation but keeps it re-derivable", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    // orders.total_order_count is registered with kind === "observation".
    const beforeConfirm = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "orders.total_order_count",
    });
    assert.equal(beforeConfirm.value.count, 2);

    await confirmBelief(prisma, {
      merchantId: merchant.id,
      key: "orders.total_order_count",
      confirmedBy: "merchant:test",
      evidenceSummary: "Yes, two orders is correct.",
    });

    const confirmed = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "orders.total_order_count",
      includeEvidence: true,
    });
    // Confirmation is recorded (lastConfirmedAt + evidence) but the belief stays
    // inferred and system-owned rather than being frozen at merchant_confirmed.
    assert.equal(confirmed.status, BELIEF_STATUS.inferred);
    assert.equal(confirmed.value.count, 2);
    assert.ok(confirmed.lastConfirmedAt);
    assert.equal(
      (confirmed.evidence ?? []).some(
        (item) => item.evidenceType === "merchant_confirmation",
      ),
      true,
    );

    // A new order arrives; a full rebuild must refresh the confirmed observation.
    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-three-${suffix}`,
        currency: "GBP",
        totalPrice: "70.00",
        processedAt: new Date("2026-07-22T10:00:00Z"),
      },
    });
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    const refreshed = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "orders.total_order_count",
    });
    // Refreshed to 3 (not pinned at 2), still inferred, confirmation preserved.
    assert.equal(refreshed.status, BELIEF_STATUS.inferred);
    assert.equal(refreshed.value.count, 3);
    assert.ok(refreshed.lastConfirmedAt);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("A deterministic metric that drops below its data threshold is retired on rebuild", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    const active = await prisma.merchantMemoryBelief.findFirst({
      where: {
        merchantId: merchant.id,
        key: "inventory.positive_available_units",
        status: BELIEF_STATUS.inferred,
      },
    });
    assert.ok(active, "positive_available_units should be active after first rebuild");
    assert.equal(active.precedence, BELIEF_PRECEDENCE.systemInference);

    // Remove the source so the derivation now returns INSUFFICIENT_DATA.
    await prisma.inventoryLevel.deleteMany({ where: { merchantId: merchant.id } });

    const rebuild = await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    assert.equal(
      rebuild.skippedOutcomes.some(
        (outcome) => outcome.key === "inventory.positive_available_units",
      ),
      true,
    );
    assert.ok(rebuild.obsoletedDeterministic >= 1);

    const retired = await prisma.merchantMemoryBelief.findFirstOrThrow({
      where: { id: active.id },
    });
    const obsoleteHistory = await prisma.merchantMemoryBeliefHistory.count({
      where: {
        merchantId: merchant.id,
        key: "inventory.positive_available_units",
        changeReason: "deterministic_derivation_no_longer_supported",
      },
    });
    const stillActive = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "inventory.positive_available_units",
    });

    assert.equal(retired.status, BELIEF_STATUS.obsolete);
    assert.ok(retired.supersededAt);
    assert.equal(obsoleteHistory, 1);
    assert.equal(stillActive, null);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("The rebuild reconciliation never obsoletes merchant-authoritative beliefs", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });

    // Merchant asserts a specific value for a metric that will later lose data.
    await correctBelief(prisma, {
      merchantId: merchant.id,
      key: "inventory.positive_available_units",
      value: { count: 42 },
      valueType: "number",
      correctedBy: "merchant:test",
    });
    const corrected = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "inventory.positive_available_units",
    });
    assert.equal(corrected.status, BELIEF_STATUS.merchantCorrected);

    // Drop the source so the derivation now returns INSUFFICIENT_DATA and the
    // key appears in skippedOutcomes for the reconciliation to consider.
    await prisma.inventoryLevel.deleteMany({ where: { merchantId: merchant.id } });
    const rebuild = await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });
    assert.equal(
      rebuild.skippedOutcomes.some(
        (outcome) => outcome.key === "inventory.positive_available_units",
      ),
      true,
    );

    const afterRebuild = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "inventory.positive_available_units",
    });
    const obsoleteHistory = await prisma.merchantMemoryBeliefHistory.count({
      where: {
        merchantId: merchant.id,
        key: "inventory.positive_available_units",
        changeReason: "deterministic_derivation_no_longer_supported",
      },
    });

    // Authoritative correction survives: never obsoleted, never overwritten.
    assert.equal(afterRebuild.status, BELIEF_STATUS.merchantCorrected);
    assert.equal(afterRebuild.value.count, 42);
    assert.equal(obsoleteHistory, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Merchant Memory lifecycle supports supersession and obsolescence", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      logger: silentLogger,
    });
    await markBeliefObsolete(prisma, {
      merchantId: merchant.id,
      key: "catalog.has_product_variants",
      reason: "test_obsolete",
    });
    await supersedeBelief(prisma, {
      merchantId: merchant.id,
      key: "catalog.total_variant_count",
      reason: "test_supersession",
      replacement: {
        merchantId: merchant.id,
        shopId: shop.id,
        category: "catalog",
        key: "catalog.total_variant_count",
        value: { count: 3 },
        valueType: "number",
        confidence: 0.8,
        confidenceReason: "Test replacement.",
        evidence: {
          sourceType: "system_derivation",
          sourceReference: "test",
          evidenceType: "deterministic_calculation",
          summary: "Test replacement evidence.",
          metadata: { formula: "test" },
          observedAt: new Date("2026-07-22T12:00:00Z"),
        },
      },
    });

    const obsolete = await prisma.merchantMemoryBelief.findFirstOrThrow({
      where: { merchantId: merchant.id, key: "catalog.has_product_variants" },
    });
    const variantRows = await prisma.merchantMemoryBelief.findMany({
      where: { merchantId: merchant.id, key: "catalog.total_variant_count" },
      orderBy: { createdAt: "asc" },
    });
    const history = await prisma.merchantMemoryBeliefHistory.count({
      where: { merchantId: merchant.id },
    });

    assert.equal(obsolete.status, BELIEF_STATUS.obsolete);
    assert.equal(
      variantRows.some((belief) => belief.status === BELIEF_STATUS.superseded),
      true,
    );
    assert.equal(
      variantRows.some((belief) => belief.status === BELIEF_STATUS.inferred),
      true,
    );
    assert.ok(history >= 3);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Merchant Memory refresh jobs are debounced, retryable and process without Shopify tokens", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Memory tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createMemoryFixture(prisma, suffix);
    await enqueueMerchantMemoryRefresh(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      categories: ["catalog"],
      reason: "test_repeat_webhook",
    });
    await enqueueMerchantMemoryRefresh(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      categories: ["catalog"],
      reason: "test_repeat_webhook",
      resetAttempts: false,
    });

    const jobCount = await prisma.backfillJob.count({
      where: { shopId: shop.id, jobType: MEMORY_REFRESH_JOB_TYPE },
    });
    await prisma.backfillJob.updateMany({
      where: {
        shopId: shop.id,
        jobType: MEMORY_REFRESH_JOB_TYPE,
        status: "queued",
      },
      data: { runAfter: new Date(0) },
    });
    const processed = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      shopId: shop.id,
      jobType: MEMORY_REFRESH_JOB_TYPE,
    });
    const catalogBeliefs = await prisma.merchantMemoryBelief.count({
      where: { merchantId: merchant.id, category: "catalog" },
    });
    const memoryStatus = await prisma.shopBackfillStatus.findUniqueOrThrow({
      where: {
        shopId_domain: { shopId: shop.id, domain: "merchant_memory" },
      },
    });

    assert.equal(jobCount, 1);
    if (!processed) {
      const jobs = await prisma.backfillJob.findMany({
        where: { shopId: shop.id },
        orderBy: [{ priority: "asc" }, { updatedAt: "asc" }],
        select: {
          jobType: true,
          status: true,
          priority: true,
          runAfter: true,
          startedAt: true,
          lastError: true,
        },
      });
      assert.fail(`Expected memory refresh job to process: ${JSON.stringify(jobs)}`);
    }
    assert.equal(processed.jobType, MEMORY_REFRESH_JOB_TYPE);
    assert.equal(processed.status, "succeeded");
    assert.ok(catalogBeliefs > 0);
    assert.equal(memoryStatus.status, "complete");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Memory Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

async function createMemoryFixture(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Memory Test Merchant ${suffix}`,
      shops: {
        create: {
          shopDomain: `memory-${suffix}.myshopify.com`,
          rawPayload: { name: `Memory Store ${suffix}` },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `product-${suffix}`,
      title: "Memory Product",
      status: "ACTIVE",
      variants: {
        create: [
          {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `variant-a-${suffix}`,
            title: "A",
            price: "20.00",
            currency: "GBP",
            inventoryItemExternalId: `inventory-a-${suffix}`,
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `variant-b-${suffix}`,
            title: "B",
            price: "40.00",
            currency: "GBP",
            inventoryItemExternalId: `inventory-b-${suffix}`,
          },
        ],
      },
    },
    include: { variants: true },
  });

  const orderOne = await prisma.order.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `order-one-${suffix}`,
      currency: "GBP",
      totalPrice: "100.00",
      processedAt: new Date("2026-07-20T10:00:00Z"),
      lineItems: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          productId: product.id,
          variantId: product.variants[0].id,
          externalId: `line-one-${suffix}`,
          quantity: 2,
          unitPrice: "20.00",
          totalPrice: "40.00",
        },
      },
    },
  });

  await prisma.order.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `order-two-${suffix}`,
      currency: "GBP",
      totalPrice: "50.00",
      processedAt: new Date("2026-07-21T10:00:00Z"),
      lineItems: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          productId: product.id,
          variantId: product.variants[1].id,
          externalId: `line-two-${suffix}`,
          quantity: 1,
          unitPrice: "40.00",
          totalPrice: "40.00",
        },
      },
    },
  });

  await prisma.refund.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      orderId: orderOne.id,
      externalId: `refund-${suffix}`,
      amount: "10.00",
      currency: "GBP",
      processedAt: new Date("2026-07-21T11:00:00Z"),
    },
  });

  await prisma.customerIdentity.createMany({
    data: [
      {
        merchantId: merchant.id,
        shopId: shop.id,
        emailHash: `repeat-hash-${suffix}`,
        maskedEmail: "r***@example.com",
        orderCount: 2,
        totalSpend: "100.00",
        averageOrderValue: "50.00",
        source: "shopify_order",
      },
      {
        merchantId: merchant.id,
        shopId: shop.id,
        emailHash: `single-hash-${suffix}`,
        maskedEmail: "s***@example.com",
        orderCount: 1,
        totalSpend: "50.00",
        averageOrderValue: "50.00",
        source: "shopify_order",
      },
    ],
  });

  await prisma.inventoryLevel.createMany({
    data: [
      {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: product.variants[0].id,
        inventoryItemExternalId: `inventory-a-${suffix}`,
        locationExternalId: `location-${suffix}`,
        available: 0,
        observedAt: new Date("2026-07-22T10:00:00Z"),
      },
      {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: product.variants[1].id,
        inventoryItemExternalId: `inventory-b-${suffix}`,
        locationExternalId: `location-${suffix}`,
        available: 5,
        observedAt: new Date("2026-07-22T10:00:00Z"),
      },
    ],
  });

  return { merchant, shop };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}

// Wraps a real Prisma client so that, inside an interactive transaction, the
// evidence write throws after the belief + history writes have been issued.
// Reads before the transaction (findFirst/findFirstOrThrow) delegate to the
// real client; the belief/history writes use the real transaction handle so
// they participate in — and roll back with — the aborted transaction.
function evidenceFailingClient(prisma) {
  return {
    merchantMemoryBelief: {
      findFirst: (args) => prisma.merchantMemoryBelief.findFirst(args),
      findFirstOrThrow: (args) => prisma.merchantMemoryBelief.findFirstOrThrow(args),
    },
    $transaction: (callback) =>
      prisma.$transaction((tx) =>
        callback({
          merchantMemoryBelief: {
            create: (args) => tx.merchantMemoryBelief.create(args),
            update: (args) => tx.merchantMemoryBelief.update(args),
          },
          merchantMemoryBeliefHistory: {
            create: (args) => tx.merchantMemoryBeliefHistory.create(args),
          },
          merchantMemoryEvidence: {
            create: async () => {
              throw new Error("simulated evidence failure");
            },
          },
        }),
      ),
  };
}

function createMockDerivationPrisma() {
  const products = [
    { id: "product-one", title: "Multi", status: "ACTIVE" },
    { id: "product-two", title: "Single", status: "ACTIVE" },
    { id: "product-three", title: "No variant", status: "ACTIVE" },
  ];
  const variants = [
    {
      id: "variant-one",
      productId: "product-one",
      sku: "SKU-1",
      title: "One",
      price: "10.00",
      currency: "GBP",
      inventoryItemExternalId: "inventory-one",
    },
    {
      id: "variant-two",
      productId: "product-one",
      sku: "SKU-2",
      title: "Two",
      price: "20.00",
      currency: "GBP",
      inventoryItemExternalId: "inventory-two",
    },
    {
      id: "variant-three",
      productId: "product-two",
      sku: "SKU-3",
      title: "Three",
      price: "30.00",
      currency: "GBP",
      inventoryItemExternalId: "inventory-three",
    },
  ];
  const now = Date.now();
  const orders = Array.from({ length: 20 }, (_, index) => ({
    id: `order-${index + 1}`,
    externalId: `external-order-${index + 1}`,
    currency: "GBP",
    totalPrice: "100.00",
    totalDiscount: "0.00",
    totalTax: "20.00",
    totalShipping: "5.00",
    processedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000),
    sourceCreatedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000),
    sourceUpdatedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000),
    customerExternalId: `customer-${index + 1}`,
    financialStatus: "PAID",
  }));
  const lineItems = orders.map((order, index) => ({
    orderId: order.id,
    productId: index % 2 === 0 ? "product-one" : "product-two",
    variantId: index % 2 === 0 ? "variant-one" : "variant-three",
    quantity: index % 3 === 0 ? 2 : 1,
    unitPrice: "100.00",
    totalPrice: "100.00",
  }));
  const customerIdentities = Array.from({ length: 10 }, (_, index) => ({
    orderCount: index < 5 ? 2 : 1,
    rawPayload: {
      orderIds: [`external-order-${index + 1}`],
    },
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
            rawPayload: {
              name: "Mock Shop",
              iana_timezone: "Europe/London",
            },
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
    refund: {
      findMany: async () => [
        {
          orderId: "order-1",
          amount: "10.00",
          currency: "GBP",
          processedAt: new Date(now - 60 * 60 * 1000),
          rawPayload: {},
        },
      ],
    },
    customerIdentity: { findMany: async () => customerIdentities },
    inventoryLevel: {
      findMany: async () => [
        {
          variantId: "variant-one",
          available: -2,
          inventoryItemExternalId: "inventory-one",
          locationExternalId: "location-one",
          sourceUpdatedAt: new Date(now - 60 * 60 * 1000),
          observedAt: new Date(now - 60 * 60 * 1000),
        },
        {
          variantId: "variant-two",
          available: 5,
          inventoryItemExternalId: "inventory-two",
          locationExternalId: "location-one",
          sourceUpdatedAt: new Date(now - 60 * 60 * 1000),
          observedAt: new Date(now - 60 * 60 * 1000),
        },
        {
          variantId: "variant-three",
          available: 0,
          inventoryItemExternalId: "inventory-three",
          locationExternalId: "location-one",
          sourceUpdatedAt: new Date(now - 60 * 60 * 1000),
          observedAt: new Date(now - 60 * 60 * 1000),
        },
      ],
    },
  };
}

function derivedBeliefInput(overrides = {}) {
  const now = new Date("2026-07-23T12:00:00Z");
  return {
    merchantId: "merchant-test",
    shopId: "shop-test",
    category: "orders",
    key: "orders.total_order_count",
    value: { count: 1 },
    valueType: "number",
    confidence: 0.9,
    confidenceReason: "Test confidence.",
    derivationVersion: "orders.total_order_count@v1",
    observedAt: now,
    evaluatedAt: now,
    evidence: {
      sourceType: "system_derivation",
      sourceReference: "test",
      evidenceType: "deterministic_calculation",
      summary: "Test evidence.",
      metadata: { formulaIdentifier: "test@v1" },
      observedAt: now,
    },
    ...overrides,
  };
}

function createMockServicePrisma(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  const history = [];
  const evidence = [];
  let nextId = 1;
  const prisma = {
    rows,
    history,
    evidence,
    merchantMemoryBelief: {
      findFirst: async ({ where }) => {
        return (
          rows
            .filter((row) => row.merchantId === where.merchantId)
            .filter((row) => row.key === where.key)
            .filter((row) => where.status.in.includes(row.status))
            .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0] ??
          null
        );
      },
      create: async ({ data }) => {
        const row = {
          id: data.id ?? `belief-new-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error(`Missing belief ${where.id}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    merchantMemoryBeliefHistory: {
      create: async ({ data }) => {
        history.push(data);
        return { id: `history-${history.length}`, ...data };
      },
    },
    merchantMemoryEvidence: {
      create: async ({ data }) => {
        evidence.push(data);
        return { id: `evidence-${evidence.length}`, ...data };
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  return prisma;
}
