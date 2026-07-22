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
} from "../app/lib/merchant-memory/service.server.js";
import { processNextBackfillJob } from "../app/services/shopify-backfill-worker.server.js";
import { enqueueMerchantMemoryRefresh } from "../app/lib/merchant-memory/jobs.server.js";
import {
  BELIEF_STATUS,
  MEMORY_REFRESH_JOB_TYPE,
} from "../app/lib/merchant-memory/constants.server.js";

const databaseUrl = process.env.DATABASE_URL;
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

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
    assert.equal(second.skipped, 0);
    assert.equal(averageOrderValue.value.amount, 75);
    assert.equal(averageOrderValue.value.currency, "GBP");
    assert.equal(repeatRate.value.percentage, 50);
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

    assert.equal(result.skipped, 1);
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

