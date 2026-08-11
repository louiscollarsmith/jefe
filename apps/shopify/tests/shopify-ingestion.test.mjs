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
  ensurePostOnboardingRecommendationsQueued,
  processNextBackfillJob,
  processReadyBackfillJobs,
  recoverStaleRunningBackfillJobs,
} from "../app/services/shopify-backfill-worker.server.js";
import {
  enqueueBackfillJob,
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  retryFailedBackfillJobs,
} from "../app/services/shopify-backfill-status.server.js";
import { upsertDerivedBelief } from "../app/lib/merchant-memory/service.server.js";
import { MEMORY_REFRESH_JOB_TYPE } from "../app/lib/merchant-memory/constants.server.js";
import { buildMerchantGoalSnapshot } from "../app/lib/merchant-goals/candidates.server.js";
import { buildMerchantPlanSnapshot } from "../app/lib/merchant-plan/candidates.server.js";
import { MERCHANT_INSIGHTS_JOB_TYPE } from "../app/lib/merchant-insights/constants.server.js";
import {
  MERCHANT_GOALS_JOB_TYPE,
  MERCHANT_GOALS_PROMPT_VERSION,
  MERCHANT_GOALS_SCHEMA_VERSION,
  MERCHANT_GOALS_SNAPSHOT_VERSION,
} from "../app/lib/merchant-goals/constants.server.js";
import {
  MERCHANT_PLAN_JOB_TYPE,
  MERCHANT_PLAN_PROMPT_VERSION,
  MERCHANT_PLAN_SCHEMA_VERSION,
  MERCHANT_PLAN_SNAPSHOT_VERSION,
} from "../app/lib/merchant-plan/constants.server.js";

const databaseUrl = process.env.DATABASE_URL;
const TEST_BACKFILL_JOB_HOLD_UNTIL = new Date("2999-01-01T00:00:00.000Z");
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

test("duplicate app/uninstalled keeps the shop uninstalled (bug #13)", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `uninstall-${suffix}.myshopify.com`;
  const rawBody = JSON.stringify({ shop_domain: shopDomain });
  const webhookId = `uninstall-${suffix}`;

  try {
    // Install, then deliver app/uninstalled twice with the same webhook id (the
    // Shopify at-least-once retry case that the ledger dedupe collapses).
    await ensureShopifyTenant(prisma, { shopDomain, scopes: ["read_products"] });

    const first = await processShopifyWebhook(prisma, {
      rawBody,
      topic: "app/uninstalled",
      shopDomain,
      webhookId,
      triggeredAt: "2026-07-29T00:00:00Z",
    });
    const afterFirst = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    });

    const second = await processShopifyWebhook(prisma, {
      rawBody,
      topic: "app/uninstalled",
      shopDomain,
      webhookId,
      triggeredAt: "2026-07-29T00:00:00Z",
    });
    const afterSecond = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    });

    const churnEvents = await prisma.activityEvent.count({
      where: { shopDomain, type: "shop_uninstalled" },
    });

    assert.equal(first.status, "processed");
    assert.equal(afterFirst.status, "uninstalled");
    assert.ok(afterFirst.uninstalledAt, "uninstalledAt is set on uninstall");

    // The regression: the duplicate delivery is deduped by the ledger, but the
    // shop must STILL be uninstalled — not reactivated by ensureShopifyTenant and
    // left stuck "active".
    assert.equal(second.status, "duplicate");
    assert.equal(afterSecond.status, "uninstalled");
    assert.equal(afterSecond.setupStatus, "uninstalled");

    // Churn is captured exactly once (first delivery only), not on the retry.
    assert.equal(churnEvents, 1);
  } finally {
    await prisma.activityEvent
      .deleteMany({ where: { shopDomain } })
      .catch(() => {});
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
  const sessionId = `offline_${shopDomain}`;

  try {
    await prisma.shop.deleteMany({
      where: { platform: "shopify", shopDomain },
    });
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
    const queuedShop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      select: { id: true },
    });

    const processedJobs = [];
    for (const jobType of [
      "shop_backfill_start",
      "products_backfill",
      "inventory_backfill",
      "orders_backfill_365d",
      "backfill_delta_sync",
      "backfill_finalize",
      MEMORY_REFRESH_JOB_TYPE,
    ]) {
      processedJobs.push(
        await processNextBackfillJobEventually(prisma, {
          jobType,
          logger: silentLogger,
          fetchImpl: createEvidenceBackfillFetch(suffix),
          shopId: queuedShop.id,
          // Stub the offline-token load: the backfill worker refreshes via the real
          // unauthenticated.admin OAuth path, which throws in tests (no refresh-token
          // grant). Injecting a token exercises the job chain + fetchImpl, same as the
          // pre-refresh code read a token from the session row.
          loadOfflineToken: async () => "test-token",
        }),
      );
    }

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
    const jobsAtAssertion = await prisma.backfillJob.findMany({
      where: { shopId: shop.id },
      orderBy: [{ priority: "asc" }, { updatedAt: "asc" }],
      select: {
        jobType: true,
        status: true,
        priority: true,
        lastError: true,
        resultJson: true,
      },
    });
    const jobStateMessage = JSON.stringify(jobsAtAssertion);

    for (const jobType of [
      "shop_backfill_start",
      "products_backfill",
      "inventory_backfill",
      "orders_backfill_365d",
      "backfill_delta_sync",
      "backfill_finalize",
      "merchant_memory_rebuild",
    ]) {
      assert.equal(
        jobsAtAssertion.find((job) => job.jobType === jobType)?.status,
        "succeeded",
        jobStateMessage,
      );
    }
    assert.equal(
      jobsAtAssertion.some((job) => job.status === "failed"),
      false,
      jobStateMessage,
    );
    assert.deepEqual(
      jobsAtAssertion
        .filter((job) =>
          ["products_backfill", "inventory_backfill", "orders_backfill_365d"].includes(
            job.jobType,
          ),
        )
        .map((job) => [job.jobType, job.priority]),
      [
        ["products_backfill", 20],
        ["inventory_backfill", 30],
        ["orders_backfill_365d", 40],
      ],
    );
    assert.equal(shop.setupStatus, "ready");
    assert.equal(shop.products.length, 1);
    assert.equal(shop.orders.length, 1);
    assert.equal(shop.customerIdentities.length, 1);
    assert.equal(shop.inventoryLevels.length, 1);
    assert.equal(progress.productsComplete, true);
    assert.equal(progress.evidenceReady, true);
    assert.equal(progress.statuses.products.totalRecordsEstimate, 1);
    assert.equal(progress.statuses.customers.totalRecordsEstimate, 1);
    assert.equal(progress.statuses.orders.totalRecordsEstimate, 1);

    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId,
      scopes: [
        "read_products",
        "read_orders",
        "read_all_orders",
        "read_customers",
        "read_inventory",
        "read_locations",
      ],
      rawPayload: { source: "same_install_oauth_callback" },
    });
    const normalOauthProgress = await getShopBackfillProgress(prisma, {
      shopId: shop.id,
    });
    const queuedCommerceJobsAfterOauth = await prisma.backfillJob.count({
      where: {
        shopId: shop.id,
        status: "queued",
        jobType: {
          in: [
            "shop_backfill_start",
            "products_backfill",
            "inventory_backfill",
            "orders_backfill_365d",
          ],
        },
      },
    });
    assert.equal(queuedCommerceJobsAfterOauth, 0);
    assert.equal(normalOauthProgress.statuses.products.status, "complete");
    assert.equal(normalOauthProgress.statuses.inventory.status, "complete");
    assert.equal(normalOauthProgress.statuses.orders.status, "complete");
    assert.equal(normalOauthProgress.statuses.customers.status, "complete");
    assert.equal(normalOauthProgress.statuses.refunds.status, "complete");

    await enqueueBackfillJob(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      jobType: "shop_backfill_start",
      payload: {
        shopDomain,
        sessionId,
        scopes: [
          "read_products",
          "read_orders",
          "read_all_orders",
          "read_customers",
          "read_inventory",
          "read_locations",
        ],
      },
    });
    const guardedStart = await processNextBackfillJobEventually(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
      shopId: shop.id,
      jobType: "shop_backfill_start",
      loadOfflineToken: async () => "test-token",
    });
    const queuedCommerceJobsAfterGuardedStart = await prisma.backfillJob.count({
      where: {
        shopId: shop.id,
        status: "queued",
        jobType: {
          in: [
            "products_backfill",
            "inventory_backfill",
            "orders_backfill_365d",
          ],
        },
      },
    });
    assert.equal(guardedStart.jobType, "shop_backfill_start");
    assert.equal(guardedStart.result.queued, 0);
    assert.deepEqual(guardedStart.result.incompleteDomains, []);
    assert.equal(queuedCommerceJobsAfterGuardedStart, 0);

    await markShopifyInstallInactive(prisma, shopDomain);
    await prisma.session.create({
      data: {
        id: `${sessionId}-reinstall`,
        shop: shopDomain,
        state: "test",
        isOnline: false,
        scope:
          "read_products,read_orders,read_all_orders,read_customers,read_inventory,read_locations",
        accessToken: "test-token",
      },
    });
    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId: `${sessionId}-reinstall`,
      scopes: [
        "read_products",
        "read_orders",
        "read_all_orders",
        "read_customers",
        "read_inventory",
        "read_locations",
      ],
      rawPayload: { source: "reinstall_oauth_callback" },
    });
    const reinstalledProgress = await getShopBackfillProgress(prisma, {
      shopId: shop.id,
    });
    const requeuedStart = await prisma.backfillJob.findUniqueOrThrow({
      where: {
        shopId_jobType: { shopId: shop.id, jobType: "shop_backfill_start" },
      },
    });
    assert.equal(requeuedStart.status, "queued");
    assert.equal(reinstalledProgress.statuses.products.status, "queued");
    assert.equal(reinstalledProgress.statuses.inventory.status, "queued");
    assert.equal(reinstalledProgress.statuses.orders.status, "queued");
    assert.equal(reinstalledProgress.statuses.customers.status, "queued");
    assert.equal(reinstalledProgress.statuses.refunds.status, "queued");

    await prisma.backfillJob.updateMany({
      where: { shopId: shop.id },
      data: { status: "failed" },
    });
    const failedForRetry = await prisma.backfillJob.count({
      where: { shopId: shop.id, status: "failed" },
    });
    const retry = await retryFailedBackfillJobs(prisma, { shopId: shop.id });
    assert.equal(retry.retried, failedForRetry);
  } finally {
    await prisma.shop.deleteMany({
      where: { platform: "shopify", shopDomain },
    });
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.session.deleteMany({ where: { shop: shopDomain } });
    await prisma.$disconnect();
  }
});

test("routine OAuth does not reset an in-flight install backfill", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for ingestion tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  const shopDomain = `oauth-inflight-${suffix}.myshopify.com`;
  const sessionId = `offline_${shopDomain}`;

  try {
    await prisma.shop.deleteMany({
      where: { platform: "shopify", shopDomain },
    });
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
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      select: { id: true },
    });

    const startJob = await processNextBackfillJobEventually(prisma, {
      logger: silentLogger,
      fetchImpl: createEvidenceBackfillFetch(suffix),
      shopId: shop.id,
      jobType: "shop_backfill_start",
      loadOfflineToken: async () => "test-token",
    });
    assert.equal(startJob?.jobType, "shop_backfill_start");

    const queuedOrderJob = await prisma.backfillJob.findUniqueOrThrow({
      where: {
        shopId_jobType: { shopId: shop.id, jobType: "orders_backfill_365d" },
      },
    });
    assert.ok(
      queuedOrderJob.runAfter > new Date("2020-01-01T00:00:00Z"),
      "newly spawned child jobs should be immediately eligible without a 1970 runAfter",
    );

    const originalStartedAt = new Date();
    const originalRunAfter = new Date(originalStartedAt.getTime() - 1_000);
    await prisma.backfillJob.update({
      where: {
        shopId_jobType: { shopId: shop.id, jobType: "orders_backfill_365d" },
      },
      data: {
        status: "running",
        runAfter: originalRunAfter,
        startedAt: originalStartedAt,
        attemptCount: 1,
        resultJson: { orders: 305, lineItems: 559 },
      },
    });

    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId,
      scopes: [
        "read_products",
        "read_orders",
        "read_all_orders",
        "read_customers",
        "read_inventory",
        "read_locations",
      ],
      rawPayload: { source: "routine_oauth_callback" },
    });

    const orderJobAfterOauth = await prisma.backfillJob.findUniqueOrThrow({
      where: {
        shopId_jobType: { shopId: shop.id, jobType: "orders_backfill_365d" },
      },
    });
    assert.equal(orderJobAfterOauth.status, "running");
    assert.equal(orderJobAfterOauth.attemptCount, 1);
    assert.equal(
      orderJobAfterOauth.runAfter.toISOString(),
      originalRunAfter.toISOString(),
    );
    assert.equal(
      orderJobAfterOauth.startedAt.toISOString(),
      originalStartedAt.toISOString(),
    );
    assert.deepEqual(orderJobAfterOauth.resultJson, {
      orders: 305,
      lineItems: 559,
    });
  } finally {
    await prisma.shop.deleteMany({
      where: { platform: "shopify", shopDomain },
    });
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
    const now = new Date();
    const staleForExplicitCall = new Date(now.getTime() - 1_000);
    await prisma.backfillJob.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: "products_backfill",
        status: "running",
        startedAt: staleForExplicitCall,
      },
    });

    const result = await recoverStaleRunningBackfillJobs(prisma, {
      now,
      timeoutMs: 0,
      logger: silentLogger,
      shopId: shop.id,
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

test("completed full memory rebuild queues Insights; downstream generation cascades", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for recommendation refresh tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const fixture = await seedRecommendationFixture(prisma, suffix, {
      onboarded: true,
    });
    await seedCompletedGoalRun(prisma, {
      ...fixture,
      beliefSnapshotHash: `goal-${suffix}`,
    });

    await enqueueBackfillJob(prisma, {
      merchantId: fixture.merchant.id,
      shopId: fixture.shop.id,
      jobType: MEMORY_REFRESH_JOB_TYPE,
      payload: { reason: "test_new_orders", categories: [] },
    });
    const result = await processNextBackfillJobEventually(prisma, {
      logger: silentLogger,
      shopId: fixture.shop.id,
      jobType: MEMORY_REFRESH_JOB_TYPE,
    });

    const insightsJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_INSIGHTS_JOB_TYPE },
    });

    assert.equal(result?.jobType, MEMORY_REFRESH_JOB_TYPE);
    assert.equal(result?.status, "succeeded");
    assert.ok(insightsJob, "Insights job should be queued after a full rebuild");
    assert.match(insightsJob.status, /^(queued|running)$/);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Recommendation Refresh Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("completed full memory rebuild does not queue Plan or Goals before onboarding is complete", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for recommendation refresh tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const fixture = await seedRecommendationFixture(prisma, suffix, {
      onboarded: false,
    });
    await seedCompletedGoalRun(prisma, {
      ...fixture,
      beliefSnapshotHash: `goal-${suffix}`,
    });

    await enqueueBackfillJob(prisma, {
      merchantId: fixture.merchant.id,
      shopId: fixture.shop.id,
      jobType: MEMORY_REFRESH_JOB_TYPE,
      payload: { reason: "test_new_orders", categories: [] },
    });
    const result = await processNextBackfillJobEventually(prisma, {
      logger: silentLogger,
      shopId: fixture.shop.id,
      jobType: MEMORY_REFRESH_JOB_TYPE,
    });

    const planJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_PLAN_JOB_TYPE },
    });
    const goalsJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_GOALS_JOB_TYPE },
    });
    const insightsJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_INSIGHTS_JOB_TYPE },
    });

    assert.equal(result?.status, "succeeded");
    assert.equal(
      planJob,
      null,
      "Plan must not be queued mid-onboarding; the funnel drives it",
    );
    assert.equal(
      goalsJob,
      null,
      "Goals must not be queued mid-onboarding; the funnel drives it",
    );
    assert.ok(
      insightsJob,
      "Insights still refresh on a full rebuild regardless of onboarding state",
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Recommendation Refresh Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("an unchanged belief snapshot reuses completed Plan and Goals runs without wasteful regeneration", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for recommendation refresh tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const fixture = await seedRecommendationFixture(prisma, suffix, {
      onboarded: true,
    });

    // Seed a completed Goal run whose hash matches the CURRENT goal snapshot so
    // the snapshot-hash cache treats the belief snapshot as unchanged.
    const goalSnapshot = await buildMerchantGoalSnapshot(prisma, {
      merchantId: fixture.merchant.id,
      shopId: fixture.shop.id,
    });
    await seedCompletedGoalRun(prisma, {
      ...fixture,
      beliefSnapshotHash: goalSnapshot.snapshotHash,
      snapshotVersion: MERCHANT_GOALS_SNAPSHOT_VERSION,
      promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
      schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
    });

    // Seed a completed Plan run whose hash matches the CURRENT plan snapshot
    // (the plan snapshot is read after the goal run exists, so it is stable).
    const planSnapshot = await buildMerchantPlanSnapshot(prisma, {
      merchantId: fixture.merchant.id,
      shopId: fixture.shop.id,
    });
    await prisma.merchantPlanRun.create({
      data: {
        merchantId: fixture.merchant.id,
        shopId: fixture.shop.id,
        status: "completed",
        snapshotVersion: MERCHANT_PLAN_SNAPSHOT_VERSION,
        snapshotHash: planSnapshot.snapshotHash,
        relevantBeliefIds: planSnapshot.beliefIds,
        insightRunId: planSnapshot.insightRunId,
        goalRunId: planSnapshot.goalRunId,
        promptVersion: MERCHANT_PLAN_PROMPT_VERSION,
        schemaVersion: MERCHANT_PLAN_SCHEMA_VERSION,
        completedAt: new Date(),
      },
    });

    const planRunsBefore = await prisma.merchantPlanRun.count({
      where: { shopId: fixture.shop.id },
    });
    const goalRunsBefore = await prisma.merchantGoalRun.count({
      where: { shopId: fixture.shop.id },
    });

    // Simulate the post-rebuild hook with an unchanged belief snapshot.
    const outcome = await ensurePostOnboardingRecommendationsQueued(prisma, {
      merchantId: fixture.merchant.id,
      shopId: fixture.shop.id,
    });

    const planRunsAfter = await prisma.merchantPlanRun.count({
      where: { shopId: fixture.shop.id },
    });
    const goalRunsAfter = await prisma.merchantGoalRun.count({
      where: { shopId: fixture.shop.id },
    });
    const planRun = await prisma.merchantPlanRun.findFirst({
      where: { shopId: fixture.shop.id },
    });
    const planJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_PLAN_JOB_TYPE },
    });
    const goalsJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_GOALS_JOB_TYPE },
    });
    const insightsJob = await prisma.backfillJob.findFirst({
      where: { shopId: fixture.shop.id, jobType: MERCHANT_INSIGHTS_JOB_TYPE },
    });

    assert.equal(outcome.status, "ensured");
    assert.equal(outcome.insights, "queued");
    assert.equal(
      planRunsAfter,
      planRunsBefore,
      "No new Plan run is created for an unchanged belief snapshot",
    );
    assert.equal(
      goalRunsAfter,
      goalRunsBefore,
      "No new Goal run is created for an unchanged belief snapshot",
    );
    assert.equal(
      planRun.status,
      "completed",
      "The completed Plan run stays completed and is not re-queued",
    );
    assert.equal(planJob, null);
    assert.equal(goalsJob, null);
    assert.equal(insightsJob?.status, "queued");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Recommendation Refresh Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

async function seedRecommendationFixture(prisma, suffix, { onboarded }) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Recommendation Refresh Test ${suffix}`,
      shops: {
        create: {
          shopDomain: `rec-refresh-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
          onboardingCompletedAt: onboarded ? new Date() : null,
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const beliefs = [];
  for (const belief of [
    {
      key: "business.description",
      category: "business",
      value: { text: "Specialist wine merchant" },
    },
    {
      key: "customers.repeat_purchase_rate",
      category: "customers",
      value: { percentage: 24, period: "stored history" },
      valueType: "percentage",
    },
    {
      key: "orders.average_order_value.all_time",
      category: "orders",
      value: { amount: 64, currency: "GBP" },
      valueType: "currency_amount",
    },
  ]) {
    const result = await upsertDerivedBelief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      category: belief.category,
      key: belief.key,
      value: belief.value,
      valueType: belief.valueType ?? "string",
      confidence: 0.9,
      confidenceReason: "Test fixture.",
      observedAt: new Date("2026-07-26T09:00:00Z"),
      evidence: {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: `Fixture belief for ${belief.key}.`,
        observedAt: new Date("2026-07-26T09:00:00Z"),
      },
    });
    beliefs.push(result.belief);
  }
  // Promote to merchant-confirmed (authoritative) so a real full memory rebuild
  // never supersedes them, keeping the belief snapshot deterministic across the
  // rebuild the worker runs.
  await prisma.merchantMemoryBelief.updateMany({
    where: { shopId: shop.id },
    data: { status: "merchant_confirmed", precedence: 60 },
  });

  const insightRun = await prisma.merchantInsightRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      status: "completed",
      beliefSnapshotVersion: "test",
      beliefSnapshotHash: `insight-${suffix}`,
      relevantBeliefIds: beliefs.map((belief) => belief.id),
      promptVersion: "test",
      schemaVersion: "test",
      completedAt: new Date("2026-07-26T09:05:00Z"),
      findings: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          orderIndex: 1,
          title: "Repeat purchase has room to grow",
          finding: "A repeat-purchase signal is present in Merchant Memory.",
          whyItMatters: "It can shape the first practical action.",
          confidence: "medium",
          category: "retention",
          supportingBeliefIds: [beliefs[1].id],
          reviewStatus: "confirmed",
        },
      },
    },
    include: { findings: true },
  });

  return { merchant, shop, beliefs, insightRun };
}

async function seedCompletedGoalRun(prisma, input) {
  const { merchant, shop, beliefs, insightRun } = input;
  return prisma.merchantGoalRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      status: "completed",
      beliefSnapshotVersion: input.snapshotVersion ?? "test",
      beliefSnapshotHash: input.beliefSnapshotHash,
      relevantBeliefIds: beliefs.map((belief) => belief.id),
      insightRunId: insightRun.id,
      promptVersion: input.promptVersion ?? "test",
      schemaVersion: input.schemaVersion ?? "test",
      completedAt: new Date("2026-07-26T09:10:00Z"),
      horizons: {
        create: [
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "threeMonths",
            orderIndex: 1,
            title: "Grow repeat revenue",
            description: "Use supported customer behaviour to build repeat sales.",
            supportingBeliefIds: [beliefs[1].id],
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "sixMonths",
            orderIndex: 2,
            title: "Increase customer value",
            description: "Build from early repeat-purchase learning.",
            supportingBeliefIds: [beliefs[1].id],
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "twelveMonths",
            orderIndex: 3,
            title: "Grow revenue with discipline",
            description: "Scale the strongest supported growth loop.",
            supportingBeliefIds: [beliefs[2].id],
          },
        ],
      },
    },
  });
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}

async function processNextBackfillJobEventually(prisma, options) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (options?.shopId) {
      await prisma.backfillJob.updateMany({
        where: { shopId: options.shopId, status: "queued" },
        data: { runAfter: TEST_BACKFILL_JOB_HOLD_UNTIL },
      });
    }
    const result = await processNextBackfillJob(prisma, {
      ...options,
      ignoreRunAfter: true,
      holdQueuedJobsUntil: TEST_BACKFILL_JOB_HOLD_UNTIL,
    });
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
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
    if (body.query.includes("JefeProductVariantsCount")) {
      return Response.json({ data: { productVariantsCount: { count: 1 } } });
    }
    if (body.query.includes("JefeCustomersCount")) {
      return Response.json({ data: { customersCount: { count: 1 } } });
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
