import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  ShopifyAdminGraphqlClient,
  ShopifyAdminGraphqlError,
} from "../app/lib/shopify/admin-graphql.server.js";
import { verifyShopifyWebhookHmac } from "../app/lib/shopify/webhook-hmac.server.js";
import { processShopifyWebhook } from "../app/lib/ingestion/shopify/webhooks.server.js";
import { runShopifyBackfill } from "../app/lib/ingestion/shopify/backfill.server.js";
import { currencyCode } from "../app/lib/ingestion/shopify/normalize.server.js";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  retryFailedBackfillJobs,
} from "../app/services/shopify-backfill-status.server.js";

const databaseUrl = process.env.DATABASE_URL;
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("Shopify GraphQL client throws structured errors", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "test-token",
    logger: silentLogger,
    fetchImpl: async () =>
      new Response(JSON.stringify({ errors: [{ message: "Nope" }] }), {
        status: 500,
        headers: { "x-request-id": "request-1" },
      }),
  });

  await assert.rejects(
    () => client.request("query Broken { shop { name } }"),
    (error) => {
      assert.ok(error instanceof ShopifyAdminGraphqlError);
      assert.equal(error.status, 500);
      assert.equal(error.requestId, "request-1");
      return true;
    },
  );
});

test("Shopify GraphQL client retries throttled requests", async () => {
  let calls = 0;
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "test-token",
    maxRetries: 1,
    logger: silentLogger,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ errors: [{ message: "Slow down" }] }),
          {
            status: 429,
            headers: { "retry-after": "0" },
          },
        );
      }
      return Response.json({ data: { shop: { name: "Example" } } });
    },
  });

  const data = await client.request("query ShopName { shop { name } }");
  assert.equal(calls, 2);
  assert.equal(data.shop.name, "Example");
});

test("Shopify webhook HMAC verification accepts valid signatures only", () => {
  const secret = "test-secret";
  const rawBody = JSON.stringify({ id: 1 });
  const valid = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  assert.equal(verifyShopifyWebhookHmac(rawBody, valid, secret), true);
  assert.equal(verifyShopifyWebhookHmac(rawBody, "invalid", secret), false);
});

test("Shopify currency normalization does not treat string prices as currency codes", () => {
  assert.equal(currencyCode("49.00"), "GBP");
  assert.equal(currencyCode("GBP"), "GBP");
  assert.equal(currencyCode({ amount: "49.00", currencyCode: "GBP" }), "GBP");
  assert.equal(currencyCode({ amount: "49.00", currencyCode: "49.00" }), "GBP");
});

test("Shopify webhook ingestion dedupes and upserts products", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `webhook-${suffix}.myshopify.com`;
  const rawBody = JSON.stringify(mockProductPayload(suffix));

  try {
    const first = await processShopifyWebhook(prisma, {
      rawBody,
      topic: "products/update",
      shopDomain,
      webhookId: `webhook-${suffix}`,
      triggeredAt: "2026-07-13T08:00:00Z",
      apiVersion: "2026-07",
    });
    const second = await processShopifyWebhook(prisma, {
      rawBody,
      topic: "products/update",
      shopDomain,
      webhookId: `webhook-${suffix}`,
      triggeredAt: "2026-07-13T08:00:00Z",
      apiVersion: "2026-07",
    });

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      include: {
        products: { include: { variants: true } },
        ledgerEvents: true,
      },
    });

    assert.equal(first.status, "processed");
    assert.equal(second.status, "duplicate");
    assert.equal(shop.products.length, 1);
    assert.equal(shop.products[0].variants.length, 1);
    assert.equal(
      shop.products[0].variants[0].inventoryItemExternalId,
      `gid://shopify/InventoryItem/inv-${suffix}`,
    );
    assert.equal(shop.ledgerEvents.length, 1);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify backfill upserts commerce state and is idempotent", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `backfill-${suffix}.myshopify.com`;

  try {
    const first = await runShopifyBackfill(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      logger: silentLogger,
      fetchImpl: createBackfillFetch(suffix),
    });
    const second = await runShopifyBackfill(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      logger: silentLogger,
      fetchImpl: createBackfillFetch(suffix),
    });

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      include: {
        products: { include: { variants: true } },
        orders: { include: { lineItems: true, refunds: true } },
        inventoryLevels: true,
        customerIdentities: true,
        ledgerEvents: true,
      },
    });

    assert.equal(first.products, 1);
    assert.equal(first.variants, 1);
    assert.equal(first.orders, 1);
    assert.equal(first.lineItems, 1);
    assert.equal(first.refunds, 1);
    assert.equal(first.inventoryLevels, 1);
    assert.equal(first.ledgerEventsCreated, 6);
    assert.equal(second.ledgerEventsCreated, 0);
    assert.equal(shop.products.length, 1);
    assert.equal(shop.products[0].variants[0].sku, `SKU-${suffix}`);
    assert.equal(shop.orders.length, 1);
    assert.equal(shop.orders[0].financialStatus, "PAID");
    assert.equal(shop.orders[0].lineItems.length, 1);
    assert.equal(shop.orders[0].refunds.length, 1);
    assert.equal(shop.inventoryLevels[0].available, 12);
    assert.equal(shop.customerIdentities.length, 1);
    assert.equal(shop.customerIdentities[0].orderCount, 1);
    assert.match(shop.customerIdentities[0].maskedEmail, /^b\*+@example\.com$/);
    assert.equal(shop.ledgerEvents.length, 6);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify install queues async backfill with 365-day and 60-day scope behaviour", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fullShopDomain = `install-full-${suffix}.myshopify.com`;
  const limitedShopDomain = `install-limited-${suffix}.myshopify.com`;

  try {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: fullShopDomain,
      sessionId: `offline-${suffix}`,
      scopes: [
        "read_products",
        "read_orders",
        "read_all_orders",
        "read_inventory",
        "read_locations",
        "read_customers",
      ],
    });
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: limitedShopDomain,
      sessionId: `offline-limited-${suffix}`,
      scopes: ["read_products", "read_orders", "read_inventory"],
    });

    const [fullShop, limitedShop] = await Promise.all([
      prisma.shop.findUniqueOrThrow({
        where: {
          platform_shopDomain: {
            platform: "shopify",
            shopDomain: fullShopDomain,
          },
        },
      }),
      prisma.shop.findUniqueOrThrow({
        where: {
          platform_shopDomain: {
            platform: "shopify",
            shopDomain: limitedShopDomain,
          },
        },
      }),
    ]);
    const fullProgress = await getShopBackfillProgress(prisma, {
      shopId: fullShop.id,
    });
    const limitedProgress = await getShopBackfillProgress(prisma, {
      shopId: limitedShop.id,
    });

    assert.equal(fullShop.setupStatus, "backfill_queued");
    assert.equal(fullShop.availableOrderHistoryDays, 365);
    assert.equal(fullShop.historicalOrderAccess, "full");
    assert.equal(fullProgress.statuses.orders.status, "queued");
    assert.equal(fullProgress.jobs.length, 1);
    assert.equal(fullProgress.jobs[0].jobType, "shop_backfill_start");
    assert.equal(limitedShop.availableOrderHistoryDays, 60);
    assert.equal(limitedShop.historicalOrderAccess, "limited");
    assert.equal(limitedProgress.historicalOrdersLimited, true);
    assert.equal(limitedProgress.readyForWinback, false);
  } finally {
    await prisma.merchant.deleteMany({
      where: {
        name: { in: [fullShopDomain, limitedShopDomain] },
      },
    });
    await prisma.$disconnect();
  }
});

test("failed Shopify backfill jobs can be retried", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `retry-${suffix}.myshopify.com`;

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: shopDomain,
        shops: { create: { shopDomain } },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];

    await prisma.backfillJob.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: "products_backfill",
        status: "failed",
        lastError: "temporary Shopify error",
        failedAt: new Date(),
      },
    });

    const result = await retryFailedBackfillJobs(prisma, { shopId: shop.id });
    const job = await prisma.backfillJob.findFirstOrThrow({
      where: { shopId: shop.id, jobType: "products_backfill" },
    });

    assert.equal(result.retried, 1);
    assert.equal(job.status, "queued");
    assert.equal(job.lastError, null);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

function createBackfillFetch(suffix) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes("JefeProductsBackfill")) {
      return Response.json({
        data: {
          products: connection([mockGraphqlProduct(suffix)]),
        },
      });
    }
    if (body.query.includes("JefeInventoryBackfill")) {
      return Response.json({
        data: {
          inventoryItems: connection([mockGraphqlInventoryItem(suffix)]),
        },
      });
    }
    if (body.query.includes("JefeOrdersBackfill")) {
      return Response.json({
        data: {
          orders: connection([mockGraphqlOrder(suffix)]),
        },
      });
    }
    throw new Error("Unexpected query");
  };
}

function connection(nodes) {
  return {
    pageInfo: { hasNextPage: false, endCursor: null },
    edges: nodes.map((node) => ({ node })),
  };
}

function mockProductPayload(suffix) {
  return {
    admin_graphql_api_id: `gid://shopify/Product/product-${suffix}`,
    title: "Webhook Product",
    status: "active",
    vendor: "Jefe",
    product_type: "Supplements",
    created_at: "2026-07-01T08:00:00Z",
    updated_at: "2026-07-13T08:00:00Z",
    variants: [
      {
        admin_graphql_api_id: `gid://shopify/ProductVariant/variant-${suffix}`,
        sku: `SKU-${suffix}`,
        title: "Default",
        price: "49.00",
        inventory_item_id: `inv-${suffix}`,
        created_at: "2026-07-01T08:00:00Z",
        updated_at: "2026-07-13T08:00:00Z",
      },
    ],
  };
}

function mockGraphqlProduct(suffix) {
  return {
    id: `gid://shopify/Product/product-${suffix}`,
    title: "Backfill Product",
    handle: `backfill-product-${suffix}`,
    status: "ACTIVE",
    vendor: "Jefe",
    productType: "Supplements",
    createdAt: "2026-07-01T08:00:00Z",
    updatedAt: "2026-07-13T08:00:00Z",
    variants: connection([
      {
        id: `gid://shopify/ProductVariant/variant-${suffix}`,
        sku: `SKU-${suffix}`,
        title: "Default",
        price: "49.00",
        createdAt: "2026-07-01T08:00:00Z",
        updatedAt: "2026-07-13T08:00:00Z",
        inventoryItem: { id: `gid://shopify/InventoryItem/inv-${suffix}` },
      },
    ]),
  };
}

function mockGraphqlInventoryItem(suffix) {
  return {
    id: `gid://shopify/InventoryItem/inv-${suffix}`,
    updatedAt: "2026-07-13T08:00:00Z",
    variant: { id: `gid://shopify/ProductVariant/variant-${suffix}` },
    inventoryLevels: connection([
      {
        id: `gid://shopify/InventoryLevel/level-${suffix}`,
        updatedAt: "2026-07-13T08:00:00Z",
        quantities: [
          { name: "available", quantity: 12 },
          { name: "committed", quantity: 2 },
          { name: "incoming", quantity: 5 },
        ],
        location: { id: `gid://shopify/Location/location-${suffix}` },
      },
    ]),
  };
}

function mockGraphqlOrder(suffix) {
  return {
    id: `gid://shopify/Order/order-${suffix}`,
    name: "#1001",
    createdAt: "2026-07-12T08:00:00Z",
    updatedAt: "2026-07-13T08:00:00Z",
    processedAt: "2026-07-12T08:05:00Z",
    email: `backfill-${suffix}@example.com`,
    contactEmail: `contact-${suffix}@example.com`,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currencyCode: "GBP",
    currentSubtotalPriceSet: {
      shopMoney: { amount: "49.00", currencyCode: "GBP" },
    },
    currentTotalPriceSet: {
      shopMoney: { amount: "49.00", currencyCode: "GBP" },
    },
    currentTotalDiscountsSet: {
      shopMoney: { amount: "0.00", currencyCode: "GBP" },
    },
    currentTotalTaxSet: { shopMoney: { amount: "8.17", currencyCode: "GBP" } },
    totalShippingPriceSet: {
      shopMoney: { amount: "0.00", currencyCode: "GBP" },
    },
    lineItems: connection([
      {
        id: `gid://shopify/LineItem/line-${suffix}`,
        sku: `SKU-${suffix}`,
        title: "Backfill Product",
        quantity: 1,
        originalUnitPriceSet: {
          shopMoney: { amount: "49.00", currencyCode: "GBP" },
        },
        discountedTotalSet: {
          shopMoney: { amount: "49.00", currencyCode: "GBP" },
        },
        discountAllocations: [],
        product: { id: `gid://shopify/Product/product-${suffix}` },
        variant: { id: `gid://shopify/ProductVariant/variant-${suffix}` },
      },
    ]),
    refunds: [
      {
        id: `gid://shopify/Refund/refund-${suffix}`,
        createdAt: "2026-07-13T09:00:00Z",
        note: "Test refund",
        totalRefundedSet: {
          shopMoney: { amount: "5.00", currencyCode: "GBP" },
        },
      },
    ],
  };
}
