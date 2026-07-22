import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;

test("inserts and reads retained Shopify evidence foundation rows", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for schema tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Schema Test Merchant ${suffix}`,
        shops: {
          create: {
            shopDomain: `schema-test-${suffix}.myshopify.com`,
            externalShopId: `gid://shopify/Shop/${suffix}`,
            rawPayload: { source: "test" },
          },
        },
      },
      include: { shops: true },
    });

    const shop = merchant.shops[0];
    assert.ok(shop.id);
    assert.equal(shop.merchantId, merchant.id);

    await prisma.connectorAccount.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        connector: "shopify",
        accountExternalId: shop.shopDomain,
        scopes: [
          "read_products",
          "read_orders",
          "read_all_orders",
          "read_inventory",
          "read_locations",
        ],
        readTokenRef: `shopify_session:${suffix}`,
        authMetadata: { tokenStorage: "shopify_session_storage" },
        rawPayload: { source: "test" },
        connectedAt: new Date("2026-07-22T08:00:00Z"),
      },
    });

    const ledgerEvent = await prisma.ledgerEvent.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        eventType: "shopify.backfill.product",
        source: "shopify",
        dedupeKey: `ledger-${suffix}`,
        payload: { productId: `product-${suffix}` },
        rawPayload: { test: true },
        eventTs: new Date("2026-07-22T08:00:00Z"),
      },
    });

    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `product-${suffix}`,
        title: "Hero Product",
        handle: "hero-product",
        status: "ACTIVE",
        vendor: "Jefe",
        productType: "Test",
        rawPayload: { source: "test" },
        variants: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `variant-${suffix}`,
            sku: "HERO-1",
            title: "Default",
            price: "49.00",
            inventoryItemExternalId: `inventory-${suffix}`,
            rawPayload: { source: "test" },
          },
        },
      },
      include: { variants: true },
    });
    const variant = product.variants[0];

    const order = await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-${suffix}`,
        orderName: `#${suffix.slice(0, 6)}`,
        customerExternalId: `customer-${suffix}`,
        financialStatus: "PAID",
        fulfillmentStatus: "FULFILLED",
        currency: "GBP",
        totalPrice: "49.00",
        processedAt: new Date("2026-07-22T08:05:00Z"),
        rawPayload: { source: "test" },
        lineItems: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            productId: product.id,
            variantId: variant.id,
            externalId: `line-item-${suffix}`,
            sku: "HERO-1",
            title: "Hero Product",
            quantity: 1,
            unitPrice: "49.00",
            totalPrice: "49.00",
            rawPayload: { source: "test" },
          },
        },
        refunds: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `refund-${suffix}`,
            amount: "5.00",
            currency: "GBP",
            processedAt: new Date("2026-07-22T08:10:00Z"),
            rawPayload: { source: "test" },
          },
        },
      },
      include: { lineItems: true, refunds: true },
    });

    await prisma.customerIdentity.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        normalizedEmail: `buyer-${suffix}@example.com`,
        emailHash: `hash-${suffix}`,
        maskedEmail: "b***@example.com",
        firstSeenOrderAt: new Date("2026-07-22T08:05:00Z"),
        lastOrderAt: new Date("2026-07-22T08:05:00Z"),
        orderCount: 1,
        totalSpend: "49.00",
        averageOrderValue: "49.00",
        source: "shopify_order",
        shopifyCustomerId: `customer-${suffix}`,
        rawPayload: { source: "test" },
      },
    });

    await prisma.inventoryLevel.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: variant.id,
        inventoryItemExternalId: `inventory-${suffix}`,
        locationExternalId: `location-${suffix}`,
        available: 12,
        committed: 1,
        incoming: 3,
        observedAt: new Date("2026-07-22T08:15:00Z"),
        rawPayload: { source: "test" },
      },
    });

    await prisma.shopBackfillStatus.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        domain: "orders",
        status: "complete",
        startedAt: new Date("2026-07-22T08:00:00Z"),
        completedAt: new Date("2026-07-22T08:01:00Z"),
        recordsProcessed: 1,
        totalRecordsEstimate: 1,
      },
    });

    await prisma.backfillJob.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: "orders_backfill_365d",
        status: "succeeded",
        priority: 20,
        resultJson: { products: 1 },
      },
    });

    const memoryBelief = await prisma.merchantMemoryBelief.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        category: "orders",
        key: "orders.average_order_value.all_time",
        value: {
          amount: 49,
          currency: "GBP",
          window: "all_stored_history",
        },
        valueType: "currency_amount",
        status: "inferred",
        confidence: "0.9000",
        confidenceReason: "Schema test deterministic calculation.",
        firstObservedAt: new Date("2026-07-22T08:05:00Z"),
        lastObservedAt: new Date("2026-07-22T08:05:00Z"),
        lastEvaluatedAt: new Date("2026-07-22T08:20:00Z"),
        evidence: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            sourceType: "system_derivation",
            sourceReference: "schema-test",
            evidenceType: "deterministic_calculation",
            summary: "Average order value calculated from stored orders.",
            metadata: {
              formula: "sum(order.total_price) / priced_order_count",
              sourceRecordCounts: { orders: 1 },
            },
            observedAt: new Date("2026-07-22T08:05:00Z"),
          },
        },
        history: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            key: "orders.average_order_value.all_time",
            newStatus: "inferred",
            newValue: { amount: 49, currency: "GBP" },
            changeReason: "derived_belief_created",
          },
        },
      },
      include: { evidence: true, history: true },
    });

    await prisma.merchantMemoryRefreshRun.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        refreshType: "full_rebuild",
        status: "completed",
        requestedCategories: [],
        result: { createdOrUpdated: 1 },
        startedAt: new Date("2026-07-22T08:20:00Z"),
        completedAt: new Date("2026-07-22T08:20:01Z"),
      },
    });

    const readBack = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchant.id },
      include: {
        shops: {
          include: {
            connectorAccounts: true,
            products: { include: { variants: true } },
            orders: { include: { lineItems: true, refunds: true } },
            customerIdentities: true,
            inventoryLevels: true,
            ledgerEvents: true,
            backfillStatuses: true,
            backfillJobs: true,
            memoryBeliefs: {
              include: {
                evidence: true,
                history: true,
              },
            },
            memoryRefreshRuns: true,
          },
        },
      },
    });

    const readShop = readBack.shops[0];
    assert.equal(readShop.connectorAccounts[0].connector, "shopify");
    assert.deepEqual(readShop.connectorAccounts[0].scopes, [
      "read_products",
      "read_orders",
      "read_all_orders",
      "read_inventory",
      "read_locations",
    ]);
    assert.equal(readShop.ledgerEvents[0].id, ledgerEvent.id);
    assert.equal(readShop.products[0].id, product.id);
    assert.equal(readShop.products[0].variants[0].sku, "HERO-1");
    assert.equal(readShop.orders[0].id, order.id);
    assert.equal(readShop.orders[0].lineItems[0].sku, "HERO-1");
    assert.equal(readShop.orders[0].refunds[0].externalId, `refund-${suffix}`);
    assert.equal(readShop.customerIdentities[0].emailHash, `hash-${suffix}`);
    assert.equal(readShop.inventoryLevels[0].available, 12);
    assert.equal(readShop.backfillStatuses[0].domain, "orders");
    assert.equal(readShop.backfillJobs[0].jobType, "orders_backfill_365d");
    assert.equal(readShop.memoryBeliefs[0].id, memoryBelief.id);
    assert.equal(readShop.memoryBeliefs[0].evidence[0].sourceType, "system_derivation");
    assert.equal(readShop.memoryBeliefs[0].history[0].changeReason, "derived_belief_created");
    assert.equal(readShop.memoryRefreshRuns[0].status, "completed");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Schema Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});
