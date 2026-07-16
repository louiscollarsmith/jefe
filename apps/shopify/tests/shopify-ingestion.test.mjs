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
import {
  importShopifyBulkResult,
  parseJsonlStream,
  startShopifyBulkBackfill,
} from "../app/lib/ingestion/shopify/bulk.server.js";
import { runShopifyBackfill } from "../app/lib/ingestion/shopify/backfill.server.js";
import { currencyCode } from "../app/lib/ingestion/shopify/normalize.server.js";
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

test("stale running Shopify backfill jobs are requeued", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `stale-running-${suffix}.myshopify.com`;
  const now = new Date("2026-07-16T12:00:00Z");

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: shopDomain,
        shops: { create: { shopDomain } },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];
    await prisma.backfillJob.createMany({
      data: [
        {
          merchantId: merchant.id,
          shopId: shop.id,
          jobType: "stale_running_job",
          status: "running",
          startedAt: new Date("2026-07-16T11:00:00Z"),
          priority: 20,
        },
        {
          merchantId: merchant.id,
          shopId: shop.id,
          jobType: "fresh_running_job",
          status: "running",
          startedAt: new Date("2026-07-16T11:59:00Z"),
          priority: 30,
        },
      ],
    });

    const result = await recoverStaleRunningBackfillJobs(prisma, {
      now,
      timeoutMs: 15 * 60_000,
      logger: silentLogger,
    });
    const jobs = await prisma.backfillJob.findMany({
      where: { shopId: shop.id },
      orderBy: { jobType: "asc" },
    });
    const fresh = jobs.find((job) => job.jobType === "fresh_running_job");
    const stale = jobs.find((job) => job.jobType === "stale_running_job");

    assert.equal(result.recovered, 1);
    assert.equal(stale?.status, "queued");
    assert.equal(stale?.startedAt, null);
    assert.equal(stale?.runAfter.toISOString(), now.toISOString());
    assert.equal(
      stale?.lastError,
      "Recovered stale running job after worker restart.",
    );
    assert.equal(fresh?.status, "running");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify bulk backfill starts products and stores operation status", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `bulk-start-${suffix}.myshopify.com`;

  try {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId: `session-${suffix}`,
      scopes: ["read_products", "read_orders", "read_all_orders"],
    });

    const result = await startShopifyBulkBackfill(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      domain: "products",
      logger: silentLogger,
      fetchImpl: createBulkStartFetch(`gid://shopify/BulkOperation/${suffix}`),
    });
    const status = await prisma.shopBackfillStatus.findUniqueOrThrow({
      where: {
        shopId_domain: { shopId: result.shop.id, domain: "products" },
      },
    });

    assert.equal(
      result.bulkOperation.id,
      `gid://shopify/BulkOperation/${suffix}`,
    );
    assert.equal(status.status, "bulk_running");
    assert.equal(status.bulkOperationId, result.bulkOperation.id);
    assert.equal(status.metadata.bulkOperationStatus, "CREATED");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify bulk JSONL parser streams and imports products and orders", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `bulk-import-${suffix}.myshopify.com`;

  try {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId: `session-${suffix}`,
      scopes: ["read_products", "read_orders", "read_all_orders"],
    });

    const parsed = [];
    for await (const row of parseJsonlStream(
      new Response(productsBulkJsonl(suffix)).body,
    )) {
      parsed.push(row);
    }
    assert.equal(parsed.length, 2);

    await importShopifyBulkResult(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      domain: "products",
      operation: completedOperation("products", suffix),
      logger: silentLogger,
      fetchImpl: createBulkResultFetch({
        "https://bulk.test/products.jsonl": productsBulkJsonl(suffix),
      }),
    });
    const firstOrderImport = await importShopifyBulkResult(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      domain: "orders",
      operation: completedOperation("orders", suffix),
      logger: silentLogger,
      fetchImpl: createBulkResultFetch({
        "https://bulk.test/orders.jsonl": ordersBulkJsonl(suffix),
      }),
    });
    const secondOrderImport = await importShopifyBulkResult(prisma, {
      shopDomain,
      accessToken: "test-token",
      sessionId: `session-${suffix}`,
      domain: "orders",
      operation: completedOperation("orders", suffix),
      logger: silentLogger,
      fetchImpl: createBulkResultFetch({
        "https://bulk.test/orders.jsonl": ordersBulkJsonl(suffix),
      }),
    });

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      include: {
        products: { include: { variants: true } },
        orders: { include: { lineItems: true, refunds: true } },
        customerIdentities: true,
      },
    });

    assert.equal(shop.products.length, 1);
    assert.equal(shop.products[0].variants.length, 1);
    assert.equal(firstOrderImport.refunds, 1);
    assert.equal(secondOrderImport.refunds, 1);
    assert.equal(shop.orders.length, 1);
    assert.equal(shop.orders[0].lineItems.length, 1);
    assert.equal(shop.orders[0].refunds.length, 1);
    assert.equal(shop.customerIdentities.length, 1);
    assert.equal(shop.customerIdentities[0].orderCount, 1);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify bulk finish webhook queues polling import", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopDomain = `bulk-webhook-${suffix}.myshopify.com`;
  const operationId = `gid://shopify/BulkOperation/${suffix}`;

  try {
    const job = await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId: `session-${suffix}`,
      scopes: ["read_products", "read_orders", "read_all_orders"],
    });
    await prisma.shopBackfillStatus.update({
      where: {
        shopId_domain: { shopId: job.shopId, domain: "products" },
      },
      data: { status: "bulk_running", bulkOperationId: operationId },
    });

    const result = await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({
        admin_graphql_api_id: operationId,
        status: "completed",
        object_count: 2,
        file_size: 500,
      }),
      topic: "bulk_operations/finish",
      shopDomain,
      webhookId: `bulk-webhook-${suffix}`,
      triggeredAt: "2026-07-15T12:00:00Z",
      apiVersion: "2026-07",
    });
    const pollJob = await prisma.backfillJob.findUniqueOrThrow({
      where: {
        shopId_jobType: { shopId: job.shopId, jobType: "products_bulk_poll" },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(pollJob.status, "queued");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("Shopify bulk polling imports completed result and falls back on failure", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const completeShopDomain = `bulk-poll-${suffix}.myshopify.com`;
  const fallbackShopDomain = `bulk-fallback-${suffix}.myshopify.com`;

  try {
    const completeJob = await prepareBulkPollShop(prisma, {
      shopDomain: completeShopDomain,
      suffix: `complete-${suffix}`,
      domain: "products",
    });
    await prisma.shopBackfillStatus.updateMany({
      where: {
        shopId: completeJob.shopId,
        domain: { in: ["orders", "inventory"] },
      },
      data: { status: "complete" },
    });
    const completeResult = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createBulkPollFetch({
        operation: completedOperation("products", `complete-${suffix}`),
        jsonlByUrl: {
          "https://bulk.test/products.jsonl": productsBulkJsonl(
            `complete-${suffix}`,
          ),
        },
      }),
    });
    const completeShop = await prisma.shop.findUniqueOrThrow({
      where: {
        platform_shopDomain: {
          platform: "shopify",
          shopDomain: completeShopDomain,
        },
      },
      include: { products: true, backfillStatuses: true },
    });

    assert.equal(completeResult.status, "succeeded");
    assert.equal(completeShop.products.length, 1);
    assert.equal(
      completeShop.backfillStatuses.find(
        (status) => status.domain === "products",
      )?.status,
      "bulk_imported",
    );
    assert.equal(
      completeShop.backfillStatuses.find(
        (status) => status.domain === "products",
      )?.recordsProcessed,
      1,
    );
    assert.ok(
      await prisma.backfillJob.findUnique({
        where: {
          shopId_jobType: {
            shopId: completeJob.shopId,
            jobType: "backfill_delta_sync",
          },
        },
      }),
    );

    await prepareBulkPollShop(prisma, {
      shopDomain: fallbackShopDomain,
      suffix: `fallback-${suffix}`,
      domain: "orders",
    });
    const fallbackResult = await processNextBackfillJob(prisma, {
      logger: silentLogger,
      fetchImpl: createBulkPollFetch({
        operation: failedOperation(`fallback-${suffix}`),
        paginatedSuffix: `fallback-${suffix}`,
      }),
    });
    const fallbackShop = await prisma.shop.findUniqueOrThrow({
      where: {
        platform_shopDomain: {
          platform: "shopify",
          shopDomain: fallbackShopDomain,
        },
      },
      include: { orders: true, backfillStatuses: true },
    });
    const orderStatus = fallbackShop.backfillStatuses.find(
      (status) => status.domain === "orders",
    );

    assert.equal(fallbackResult.status, "succeeded");
    assert.equal(fallbackShop.orders.length, 1);
    assert.equal(orderStatus?.status, "complete");
    assert.equal(orderStatus?.metadata.fallbackUsed, true);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { in: [completeShopDomain, fallbackShopDomain] } },
    });
    await prisma.$disconnect();
  }
});

function createBackfillFetch(suffix) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes("JefeProductsCount")) {
      return Response.json({
        data: {
          productsCount: { count: 1 },
        },
      });
    }
    if (body.query.includes("JefeOrdersCount")) {
      return Response.json({
        data: {
          ordersCount: { count: 1 },
        },
      });
    }
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
      assert.ok(!body.query.includes("acceptsMarketing"));
      return Response.json({
        data: {
          orders: connection([mockGraphqlOrder(suffix)]),
        },
      });
    }
    throw new Error("Unexpected query");
  };
}

function createBulkStartFetch(operationId) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.query.includes("JefeBulkOperationRun"));
    assert.ok(body.variables.query.includes("products"));
    assert.ok(!body.variables.query.includes("inventoryManagement"));
    assert.ok(!body.variables.query.includes("requiresShipping"));
    return Response.json({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: {
            id: operationId,
            status: "CREATED",
            errorCode: null,
            createdAt: "2026-07-15T12:00:00Z",
            completedAt: null,
            objectCount: 0,
            fileSize: null,
            url: null,
            partialDataUrl: null,
          },
          userErrors: [],
        },
      },
    });
  };
}

function createBulkResultFetch(jsonlByUrl) {
  return async (url) => {
    const body = jsonlByUrl[String(url)];
    if (body === undefined) throw new Error(`Unexpected bulk URL ${url}`);
    return new Response(body, { status: 200 });
  };
}

function createBulkPollFetch({ operation, jsonlByUrl = {}, paginatedSuffix }) {
  return async (url, init = {}) => {
    if (String(url).startsWith("https://bulk.test/")) {
      const body = jsonlByUrl[String(url)];
      if (body === undefined) throw new Error(`Unexpected bulk URL ${url}`);
      return new Response(body, { status: 200 });
    }

    const body = JSON.parse(init.body);
    if (body.query.includes("JefeBulkOperationNode")) {
      return Response.json({ data: { node: operation } });
    }

    if (paginatedSuffix) {
      return createBackfillFetch(paginatedSuffix)(url, init);
    }

    throw new Error("Unexpected query");
  };
}

async function prepareBulkPollShop(prisma, { shopDomain, suffix, domain }) {
  const sessionId = `session-${suffix}`;
  const job = await queueInstallShopifyBackfill(prisma, {
    shopDomain,
    sessionId,
    scopes: ["read_products", "read_orders", "read_all_orders"],
  });
  await prisma.session.create({
    data: {
      id: sessionId,
      shop: shopDomain,
      state: `state-${suffix}`,
      isOnline: false,
      accessToken: "test-token",
    },
  });
  await prisma.backfillJob.deleteMany({
    where: { shopId: job.shopId, jobType: "shop_backfill_start" },
  });
  await prisma.shopBackfillStatus.update({
    where: { shopId_domain: { shopId: job.shopId, domain } },
    data: {
      status: "bulk_running",
      bulkOperationId: `gid://shopify/BulkOperation/${suffix}`,
    },
  });
  await prisma.backfillJob.create({
    data: {
      merchantId: job.merchantId,
      shopId: job.shopId,
      jobType:
        domain === "products" ? "products_bulk_poll" : "orders_bulk_poll",
      status: "queued",
      priority: domain === "products" ? 35 : 36,
      payloadJson: {
        sessionId,
        scopes: ["read_products", "read_orders", "read_all_orders"],
        backfillStartedAt: "2026-07-15T12:00:00Z",
      },
    },
  });
  return job;
}

function completedOperation(domain, suffix) {
  return {
    id: `gid://shopify/BulkOperation/${suffix}`,
    status: "COMPLETED",
    errorCode: null,
    createdAt: "2026-07-15T12:00:00Z",
    completedAt: "2026-07-15T12:01:00Z",
    objectCount: domain === "products" ? 2 : 3,
    fileSize: 500,
    url:
      domain === "products"
        ? "https://bulk.test/products.jsonl"
        : "https://bulk.test/orders.jsonl",
    partialDataUrl: null,
  };
}

function failedOperation(suffix) {
  return {
    id: `gid://shopify/BulkOperation/${suffix}`,
    status: "FAILED",
    errorCode: "INTERNAL_SERVER_ERROR",
    createdAt: "2026-07-15T12:00:00Z",
    completedAt: "2026-07-15T12:01:00Z",
    objectCount: 0,
    fileSize: null,
    url: null,
    partialDataUrl: null,
  };
}

function productsBulkJsonl(suffix) {
  const productId = `gid://shopify/Product/bulk-product-${suffix}`;
  return [
    {
      __typename: "Product",
      id: productId,
      title: "Bulk Product",
      handle: `bulk-product-${suffix}`,
      status: "ACTIVE",
      vendor: "Jefe",
      productType: "Supplements",
      tags: ["bulk"],
      createdAt: "2026-07-01T08:00:00Z",
      updatedAt: "2026-07-13T08:00:00Z",
    },
    {
      __typename: "ProductVariant",
      __parentId: productId,
      id: `gid://shopify/ProductVariant/bulk-variant-${suffix}`,
      title: "Default",
      sku: `BULK-SKU-${suffix}`,
      price: "49.00",
      createdAt: "2026-07-01T08:00:00Z",
      updatedAt: "2026-07-13T08:00:00Z",
      inventoryItem: { id: `gid://shopify/InventoryItem/bulk-inv-${suffix}` },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
}

function ordersBulkJsonl(suffix) {
  const orderId = `gid://shopify/Order/bulk-order-${suffix}`;
  return [
    {
      __typename: "Order",
      id: orderId,
      name: "#2001",
      createdAt: "2026-07-12T08:00:00Z",
      updatedAt: "2026-07-13T08:00:00Z",
      processedAt: "2026-07-12T08:05:00Z",
      email: `bulk-${suffix}@example.com`,
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
      currentTotalTaxSet: {
        shopMoney: { amount: "8.17", currencyCode: "GBP" },
      },
      totalShippingPriceSet: {
        shopMoney: { amount: "0.00", currencyCode: "GBP" },
      },
      customer: {
        id: `gid://shopify/Customer/bulk-customer-${suffix}`,
        email: `bulk-${suffix}@example.com`,
      },
    },
    {
      __typename: "LineItem",
      __parentId: orderId,
      id: `gid://shopify/LineItem/bulk-line-${suffix}`,
      sku: `BULK-SKU-${suffix}`,
      title: "Bulk Product",
      quantity: 1,
      originalUnitPriceSet: {
        shopMoney: { amount: "49.00", currencyCode: "GBP" },
      },
      discountedTotalSet: {
        shopMoney: { amount: "49.00", currencyCode: "GBP" },
      },
      discountAllocations: [],
      product: { id: `gid://shopify/Product/bulk-product-${suffix}` },
      variant: { id: `gid://shopify/ProductVariant/bulk-variant-${suffix}` },
    },
    {
      __typename: "Refund",
      __parentId: orderId,
      id: `gid://shopify/Refund/bulk-refund-${suffix}`,
      createdAt: "2026-07-13T09:00:00Z",
      note: "Bulk refund",
      totalRefundedSet: {
        shopMoney: { amount: "5.00", currencyCode: "GBP" },
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
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
