import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
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
  BELIEF_STATUS,
  MEMORY_REFRESH_JOB_TYPE,
} from "../app/lib/merchant-memory/constants.server.js";
import { evaluateConfidenceTemplate } from "../app/lib/merchant-memory/confidence-templates.server.js";
import { ratio, roundMoney } from "../app/lib/merchant-memory/calculation-primitives.server.js";
import { currentDefinitionVersion } from "../app/lib/merchant-memory/derivation-versioning.server.js";
import { deriveMerchantMemoryBeliefs } from "../app/lib/merchant-memory/shopify-derivations.server.js";
import { DETERMINISTIC_BELIEF_REGISTRY } from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";

const databaseUrl = process.env.DATABASE_URL;
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("deterministic belief registry contains only the first implementation tranches", () => {
  assert.equal(DETERMINISTIC_BELIEF_REGISTRY.length, 104);
  assert.deepEqual(
    new Set(DETERMINISTIC_BELIEF_REGISTRY.map((definition) => definition.tranche)),
    new Set([
      "0A — validate existing 19",
      "0B — data-quality guardrails",
      "1A — cheap deterministic expansion",
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

  assert.equal(result.registryDefinitionCount, 104);
  assert.equal(result.derivationReport.attempted, 104);
  assert.equal(
    result.derivationReport.published + result.derivationReport.suppressed,
    104,
  );
  assert.equal(result.derivationAttempts.length, 104);
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
    const processed = await processNextBackfillJob(prisma, {
      logger: silentLogger,
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
        normalizedEmail: `repeat-${suffix}@example.com`,
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
        normalizedEmail: `single-${suffix}@example.com`,
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
