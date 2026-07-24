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
  ensureShopifyTenant,
  markShopifyInstallInactive,
} from "../app/lib/ingestion/shopify/tenant.server.js";
import {
  processNextBackfillJob,
  recoverStaleRunningBackfillJobs,
} from "../app/services/shopify-backfill-worker.server.js";
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
  const suffix = uniqueSuffix();
  const shopDomain = `webhook-${suffix}.myshopify.com`;
  const rawBody = JSON.stringify(mockRestProductPayload(suffix));

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
      "gid://shopify/InventoryItem/54200616911144",
    );
    assert.equal(shop.ledgerEvents.length, 1);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify product delete webhook marks existing products deleted", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `delete-${suffix}.myshopify.com`;
  const productGid = `gid://shopify/Product/${suffix}`;

  try {
    const { merchant, shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      scopes: ["read_products"],
    });
    await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: productGid,
        title: "Deleted product",
      },
    });

    await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({ id: productGid }),
      topic: "products/delete",
      shopDomain,
      webhookId: `delete-${suffix}`,
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { shopId_externalId: { shopId: shop.id, externalId: productGid } },
    });
    assert.equal(product.status, "deleted");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify tenant is reactivated after reinstall", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `reactivated-${suffix}.myshopify.com`;

  try {
    await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-${suffix}`,
      scopes: ["read_products"],
    });
    await markShopifyInstallInactive(prisma, shopDomain);

    const { shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-reinstalled-${suffix}`,
      scopes: ["read_products"],
    });
    const connector = await prisma.connectorAccount.findFirstOrThrow({
      where: { shopId: shop.id, connector: "shopify" },
    });

    assert.equal(shop.status, "active");
    assert.equal(shop.setupStatus, "installed");
    assert.equal(connector.status, "active");
    assert.deepEqual(connector.scopes, ["read_products"]);
    assert.equal(
      connector.readTokenRef,
      `shopify_session:offline-reinstalled-${suffix}`,
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify tenant creation is idempotent under concurrent requests", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `concurrent-${suffix}.myshopify.com`;

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ensureShopifyTenant(prisma, {
          shopDomain,
          accessTokenSessionId: `offline-concurrent-${index}`,
          scopes: ["read_products"],
          rawPayload: { source: `concurrent-${index}` },
        }),
      ),
    );

    assert.equal(new Set(results.map(({ merchant }) => merchant.id)).size, 1);
    assert.equal(new Set(results.map(({ shop }) => shop.id)).size, 1);
    assert.equal(
      await prisma.merchant.count({ where: { name: shopDomain } }),
      1,
    );
    assert.equal(
      await prisma.shop.count({
        where: { platform: "shopify", shopDomain },
      }),
      1,
    );
    assert.equal(
      await prisma.connectorAccount.count({
        where: { connector: "shopify", accountExternalId: shopDomain },
      }),
      1,
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify evidence backfill upserts commerce evidence and is idempotent", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `backfill-${suffix}.myshopify.com`;

  try {
    const first = await runShopifyBackfill(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const second = await runShopifyBackfill(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
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
    assert.equal(shop.orders[0].lineItems.length, 1);
    assert.equal(shop.orders[0].refunds.length, 1);
    assert.equal(shop.customerIdentities.length, 1);
    assert.equal(shop.inventoryLevels.length, 1);
    assert.equal(shop.ledgerEvents.length, 6);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Install evidence backfill jobs queue, run, finalise and retry failed work", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `jobs-${suffix}.myshopify.com`;
  const sessionId = `offline-${suffix}`;

  try {
    await prisma.session.create({
      data: {
        id: sessionId,
        shop: shopDomain,
        state: "test",
        isOnline: false,
        scope:
          "read_products,write_products,read_orders,write_orders,read_all_orders,read_customers,write_customers,read_inventory,write_inventory,read_locations,write_locations",
        accessToken: "test-token",
      },
    });

    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId,
      scopes: [
        "read_products",
        "write_products",
        "read_orders",
        "write_orders",
        "read_all_orders",
        "read_customers",
        "write_customers",
        "read_inventory",
        "write_inventory",
        "read_locations",
        "write_locations",
      ],
    });

    const start = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const products = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const orders = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const inventory = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const delta = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const finalize = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });
    const memory = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
    });

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      include: {
        products: true,
        orders: true,
        customerIdentities: true,
        inventoryLevels: true,
      },
    });
    const progress = await getShopBackfillProgress(prisma, { shopId: shop.id });

    assert.equal(start.jobType, "shop_backfill_start");
    assert.equal(products.jobType, "products_backfill");
    assert.equal(orders.jobType, "orders_backfill_365d");
    assert.equal(inventory.jobType, "inventory_backfill");
    assert.equal(delta.jobType, "backfill_delta_sync");
    assert.equal(finalize.jobType, "backfill_finalize");
    assert.equal(memory.jobType, "merchant_memory_rebuild");
    assert.equal(memory.status, "succeeded");
    assert.equal(shop.setupStatus, "ready");
    assert.equal(shop.products.length, 1);
    assert.equal(shop.orders.length, 1);
    assert.equal(shop.customerIdentities.length, 1);
    assert.equal(shop.inventoryLevels.length, 1);
    assert.equal(progress.productsComplete, true);
    assert.equal(progress.evidenceReady, true);

    await prisma.backfillJob.updateMany({
      where: { shopId: shop.id },
      data: { status: "failed" },
    });
    const retry = await retryFailedBackfillJobs(prisma, { shopId: shop.id });
    assert.equal(retry.retried, 7);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.session.deleteMany({ where: { shop: shopDomain } });
    await prisma.$disconnect();
  }
});

test("stale running evidence backfill jobs are recovered", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `stale-${suffix}.myshopify.com`;

  try {
    const { merchant, shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      scopes: ["read_products"],
    });
    await prisma.backfillJob.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: "products_backfill",
        status: "running",
        startedAt: new Date("2026-07-13T08:00:00Z"),
      },
    });

    const result = await recoverStaleRunningBackfillJobs(prisma, {
      now: new Date("2026-07-13T09:00:00Z"),
      timeoutMs: 15 * 60 * 1000,
      logger: silentLogger,
    });
    const job = await prisma.backfillJob.findFirstOrThrow({
      where: { shopId: shop.id },
    });

    assert.equal(result.recovered, 1);
    assert.equal(job.status, "queued");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}

function mockRestProductPayload(suffix) {
  return {
    id: 9000,
    admin_graphql_api_id: `gid://shopify/Product/${suffix}`,
    title: "Backfill Tee",
    handle: "backfill-tee",
    status: "active",
    vendor: "Jefe",
    product_type: "T-Shirts",
    created_at: "2026-07-13T08:00:00Z",
    updated_at: "2026-07-13T08:30:00Z",
    variants: [
      {
        id: 9100,
        admin_graphql_api_id: `gid://shopify/ProductVariant/${suffix}`,
        sku: `SKU-${suffix}`,
        title: "Default",
        price: "29.00",
        inventory_item_id: 54200616911144,
        created_at: "2026-07-13T08:00:00Z",
        updated_at: "2026-07-13T08:30:00Z",
      },
    ],
  };
}

function mockGraphqlProductPayload(suffix) {
  return {
    id: `gid://shopify/Product/${suffix}`,
    title: "Backfill Tee",
    handle: "backfill-tee",
    status: "ACTIVE",
    vendor: "Jefe",
    productType: "T-Shirts",
    createdAt: "2026-07-13T08:00:00Z",
    updatedAt: "2026-07-13T08:30:00Z",
    variants: {
      edges: [
        {
          node: {
            id: `gid://shopify/ProductVariant/${suffix}`,
            sku: `SKU-${suffix}`,
            title: "Default",
            price: "29.00",
            createdAt: "2026-07-13T08:00:00Z",
            updatedAt: "2026-07-13T08:30:00Z",
            inventoryItem: {
              id: `gid://shopify/InventoryItem/${suffix}`,
            },
          },
        },
      ],
    },
  };
}

function mockGraphqlOrderPayload(suffix) {
  return {
    id: `gid://shopify/Order/${suffix}`,
    name: `#${suffix.slice(0, 6)}`,
    createdAt: "2026-07-13T09:00:00Z",
    processedAt: "2026-07-13T09:05:00Z",
    updatedAt: "2026-07-13T09:10:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "GBP",
    email: `buyer-${suffix}@example.com`,
    customer: {
      id: `gid://shopify/Customer/${suffix}`,
      email: `buyer-${suffix}@example.com`,
    },
    currentSubtotalPriceSet: {
      shopMoney: { amount: "29.00", currencyCode: "GBP" },
    },
    currentTotalPriceSet: {
      shopMoney: { amount: "29.00", currencyCode: "GBP" },
    },
    currentTotalDiscountsSet: {
      shopMoney: { amount: "0.00", currencyCode: "GBP" },
    },
    currentTotalTaxSet: {
      shopMoney: { amount: "0.00", currencyCode: "GBP" },
    },
    totalShippingPriceSet: {
      shopMoney: { amount: "0.00", currencyCode: "GBP" },
    },
    lineItems: {
      edges: [
        {
          node: {
            id: `gid://shopify/LineItem/${suffix}`,
            sku: `SKU-${suffix}`,
            title: "Backfill Tee",
            quantity: 1,
            originalUnitPriceSet: {
              shopMoney: { amount: "29.00", currencyCode: "GBP" },
            },
            discountedTotalSet: {
              shopMoney: { amount: "29.00", currencyCode: "GBP" },
            },
            discountAllocations: [],
            product: { id: `gid://shopify/Product/${suffix}` },
            variant: { id: `gid://shopify/ProductVariant/${suffix}` },
          },
        },
      ],
    },
    refunds: [
      {
        id: `gid://shopify/Refund/${suffix}`,
        createdAt: "2026-07-13T10:00:00Z",
        note: "test refund",
        totalRefundedSet: {
          shopMoney: { amount: "5.00", currencyCode: "GBP" },
        },
      },
    ],
  };
}

function mockGraphqlInventoryItemPayload(suffix) {
  return {
    id: `gid://shopify/InventoryItem/${suffix}`,
    updatedAt: "2026-07-13T09:00:00Z",
    variant: { id: `gid://shopify/ProductVariant/${suffix}` },
    inventoryLevels: {
      edges: [
        {
          node: {
            id: `gid://shopify/InventoryLevel/${suffix}`,
            updatedAt: "2026-07-13T09:00:00Z",
            quantities: [
              { name: "available", quantity: 12 },
              { name: "committed", quantity: 1 },
              { name: "incoming", quantity: 3 },
            ],
            location: { id: `gid://shopify/Location/${suffix}` },
          },
        },
      ],
    },
  };
}

function createEvidenceBackfillFetch(suffix) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes("JefeProductsCount")) {
      return Response.json({ data: { productsCount: { count: 1 } } });
    }
    if (body.query.includes("JefeOrdersCount")) {
      return Response.json({ data: { ordersCount: { count: 1 } } });
    }
    if (body.query.includes("JefeInventoryItemsBackfill")) {
      return Response.json({
        data: {
          inventoryItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [{ node: mockGraphqlInventoryItemPayload(suffix) }],
          },
        },
      });
    }
    if (body.query.includes("JefeOrdersBackfill")) {
      return Response.json({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [{ node: mockGraphqlOrderPayload(suffix) }],
          },
        },
      });
    }
    return Response.json({
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ node: mockGraphqlProductPayload(suffix) }],
        },
      },
    });
  };
}
