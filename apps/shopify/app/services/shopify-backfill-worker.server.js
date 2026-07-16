// @ts-check

import { runShopifyBackfill } from "../lib/ingestion/shopify/backfill.server.js";
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server.js";
import {
  buildOrdersBackfillQueryFilter,
  ORDERS_COUNT_QUERY,
  PRODUCTS_COUNT_QUERY,
} from "../lib/shopify/queries.server.js";
import {
  bulkStatusMetadata,
  getShopifyBulkOperation,
  importShopifyBulkResult,
  startShopifyBulkBackfill,
} from "../lib/ingestion/shopify/bulk.server.js";
import { generateDailyBrief } from "./daily-brief.server.js";
import {
  DEFAULT_BACKFILL_DAYS,
  enqueueBackfillJob,
  FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS,
  hasReadAllOrders,
  splitScopes,
  upsertBackfillStatus,
} from "./shopify-backfill-status.server.js";

const LOOP_INTERVAL_MS = 15_000;
const BULK_POLL_INTERVAL_MS = 30_000;
const STALE_RUNNING_JOB_TIMEOUT_MS = 15 * 60_000;
const DELTA_SYNC_OVERLAP_HOURS = 24;

let loopStarted = false;
let loopRunning = false;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ intervalMs?: number; logger?: Pick<Console, "info" | "warn" | "error"> }} [options]
 */
export function startShopifyBackfillLoop(prisma, options = {}) {
  if (loopStarted || process.env.ENABLE_SHOPIFY_BACKFILL_LOOP === "false") {
    return;
  }

  loopStarted = true;
  const logger = options.logger ?? console;
  const intervalMs = options.intervalMs ?? LOOP_INTERVAL_MS;
  const tick = async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      await processNextBackfillJob(prisma, { logger });
    } catch (error) {
      logger.error("Shopify backfill loop failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      loopRunning = false;
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs).unref?.();
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} [options]
 */
export async function processNextBackfillJob(prisma, options = {}) {
  const now = new Date();
  await recoverStaleRunningBackfillJobs(prisma, { now, logger: options.logger });
  const job = await prisma.backfillJob.findFirst({
    where: {
      status: "queued",
      runAfter: { lte: now },
    },
    orderBy: [{ priority: "asc" }, { runAfter: "asc" }, { createdAt: "asc" }],
    include: { shop: true, merchant: true },
  });

  if (!job) return null;

  const claimed = await prisma.backfillJob.updateMany({
    where: { id: job.id, status: "queued" },
    data: {
      status: "running",
      startedAt: now,
      failedAt: null,
      lastError: null,
      attemptCount: { increment: 1 },
    },
  });

  if (claimed.count !== 1) return null;

  if (job.shop.status === "uninstalled") {
    await prisma.backfillJob.update({
      where: { id: job.id },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        resultJson: { reason: "shop_uninstalled" },
      },
    });
    return { status: "cancelled", jobType: job.jobType };
  }

  try {
    const result = /** @type {any} */ (
      await runBackfillJob(prisma, job, options)
    );
    if (result?.requeueJob) {
      await prisma.backfillJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          runAfter: result.runAfter ?? retryAfter(0),
          startedAt: null,
          completedAt: null,
          failedAt: null,
          lastError: null,
          resultJson: result,
        },
      });
      return { status: "queued", jobType: job.jobType, result };
    }

    await prisma.backfillJob.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        completedAt: new Date(),
        resultJson: result ?? {},
      },
    });
    return { status: "succeeded", jobType: job.jobType, result };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Backfill job failed.";
    const failedPermanently = job.attemptCount + 1 >= job.maxAttempts;
    await prisma.backfillJob.update({
      where: { id: job.id },
      data: {
        status: failedPermanently ? "failed" : "queued",
        failedAt: failedPermanently ? new Date() : null,
        runAfter: failedPermanently
          ? job.runAfter
          : retryAfter(job.attemptCount),
        lastError: message.slice(0, 1000),
      },
    });
    await prisma.shop.update({
      where: { id: job.shopId },
      data: { setupStatus: "backfill_partial" },
    });
    return { status: "failed", jobType: job.jobType, error: message };
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ now?: Date; timeoutMs?: number; logger?: Pick<Console, "info" | "warn" | "error"> }} [options]
 */
export async function recoverStaleRunningBackfillJobs(prisma, options = {}) {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? STALE_RUNNING_JOB_TIMEOUT_MS;
  const staleStartedBefore = new Date(now.getTime() - timeoutMs);
  const result = await prisma.backfillJob.updateMany({
    where: {
      status: "running",
      startedAt: { lt: staleStartedBefore },
    },
    data: {
      status: "queued",
      runAfter: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: "Recovered stale running job after worker restart.",
    },
  });

  if (result.count > 0) {
    options.logger?.warn("Recovered stale Shopify backfill jobs", {
      count: result.count,
      staleStartedBefore: staleStartedBefore.toISOString(),
    });
  }

  return { recovered: result.count };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").BackfillJob & { shop: import("@prisma/client").Shop; merchant: import("@prisma/client").Merchant }} job
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} options
 */
async function runBackfillJob(prisma, job, options) {
  const payload = jsonObject(job.payloadJson);
  const scopes = splitScopes(payload.scopes);
  const orderHistoryDays = hasReadAllOrders(scopes)
    ? DEFAULT_BACKFILL_DAYS
    : FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS;
  const jobContext = {
    merchantId: job.merchantId,
    shopId: job.shopId,
    shopDomain: job.shop.shopDomain,
    sessionId: stringValue(payload.sessionId),
    accessToken: await loadAccessToken(prisma, {
      shopDomain: job.shop.shopDomain,
      sessionId: stringValue(payload.sessionId),
    }),
    fetchImpl: options.fetchImpl,
    logger: options.logger ?? console,
    scopes,
    orderHistoryDays,
    startedAt:
      parseDate(payload.backfillStartedAt) ?? job.shop.backfillStartedAt,
  };

  switch (job.jobType) {
    case "shop_backfill_start":
      return handleBackfillStart(prisma, jobContext);
    case "products_backfill":
      return handleCommerceBackfill(prisma, jobContext, {
        domain: "products",
        backfillDomains: ["products"],
      });
    case "orders_backfill_365d":
      return handleCommerceBackfill(prisma, jobContext, {
        domain: "orders",
        backfillDomains: ["orders"],
      });
    case "inventory_backfill":
      return handleCommerceBackfill(prisma, jobContext, {
        domain: "inventory",
        backfillDomains: ["inventory"],
      });
    case "products_bulk_poll":
      return handleBulkPoll(prisma, jobContext, {
        domain: "products",
        fallbackDomains: ["products"],
      });
    case "orders_bulk_poll":
      return handleBulkPoll(prisma, jobContext, {
        domain: "orders",
        fallbackDomains: ["orders"],
      });
    case "backfill_delta_sync":
      return handleDeltaSync(prisma, jobContext);
    case "derived_metrics_recompute":
      return handleDerivedMetrics(prisma, jobContext);
    case "backfill_finalize":
      return handleFinalize(prisma, jobContext);
    default:
      return {};
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleBackfillStart(prisma, context) {
  await prisma.shop.update({
    where: { id: context.shopId },
    data: {
      setupStatus: "backfill_running",
      historicalOrderAccess: hasReadAllOrders(context.scopes)
        ? "full"
        : "limited",
      availableOrderHistoryDays: context.orderHistoryDays,
      backfillStartedAt: context.startedAt ?? new Date(),
    },
  });

  const payload = {
    shopDomain: context.shopDomain,
    sessionId: context.sessionId,
    scopes: context.scopes,
    availableOrderHistoryDays: context.orderHistoryDays,
    backfillStartedAt: (context.startedAt ?? new Date()).toISOString(),
  };

  await applyBackfillCountEstimates(prisma, context);

  await Promise.all([
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "products_backfill",
      payload,
    }),
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "orders_backfill_365d",
      payload,
    }),
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "inventory_backfill",
      payload,
    }),
  ]);

  return { queued: 3, orderHistoryDays: context.orderHistoryDays };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {{ domain: string; backfillDomains: Array<"products" | "orders" | "inventory"> }} input
 */
async function handleCommerceBackfill(prisma, context, input) {
  if (input.domain === "products" || input.domain === "orders") {
    return handleBulkStart(prisma, context, {
      domain: input.domain,
      fallbackDomains: input.backfillDomains,
    });
  }

  await markRunning(prisma, context, input.domain);
  if (input.domain === "orders") {
    await markRunning(prisma, context, "refunds");
    await markRunning(prisma, context, "customers");
  }

  const totals = await runShopifyBackfill(prisma, {
    shopDomain: context.shopDomain,
    accessToken: context.accessToken,
    sessionId: context.sessionId,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
    domains: input.backfillDomains,
    orderBackfillDays: context.orderHistoryDays,
  });

  await markComplete(
    prisma,
    context,
    input.domain,
    domainTotal(totals, input.domain),
  );

  if (input.domain === "orders") {
    await markComplete(prisma, context, "refunds", totals.refunds);
    const customerCount = await prisma.customerIdentity.count({
      where: { shopId: context.shopId },
    });
    await markComplete(prisma, context, "customers", customerCount);
  }

  await enqueuePostImportJobsIfReady(prisma, context);

  return totals;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {{ domain: "products" | "orders"; fallbackDomains: Array<"products" | "orders" | "inventory"> }} input
 */
async function handleBulkStart(prisma, context, input) {
  const totalRecordsEstimate = await loadBackfillCountEstimate(
    context,
    input.domain,
  );
  await markRunning(
    prisma,
    context,
    input.domain,
    "bulk_queued",
    totalRecordsEstimate,
  );
  if (input.domain === "orders") {
    await markRunning(prisma, context, "refunds", "bulk_queued");
    await markRunning(prisma, context, "customers", "bulk_queued");
  }

  try {
    const { bulkOperation } = await startShopifyBulkBackfill(prisma, {
      shopDomain: context.shopDomain,
      accessToken: context.accessToken,
      domain: input.domain,
      sessionId: context.sessionId,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      orderBackfillDays: context.orderHistoryDays,
      logger: context.logger,
      fetchImpl: context.fetchImpl,
    });

    await enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType:
        input.domain === "products" ? "products_bulk_poll" : "orders_bulk_poll",
      payload: {
        shopDomain: context.shopDomain,
        sessionId: context.sessionId,
        scopes: context.scopes,
        backfillStartedAt: (context.startedAt ?? new Date()).toISOString(),
        domain: input.domain,
        bulkOperationId: bulkOperation.id,
      },
    });

    return { bulkOperationId: bulkOperation.id, status: bulkOperation.status };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Shopify bulk operation failed.";
    context.logger.warn("Shopify bulk start failed; using paginated fallback", {
      shopDomain: context.shopDomain,
      domain: input.domain,
      error: message,
    });
    return runPaginatedFallback(prisma, context, {
      domain: input.domain,
      fallbackDomains: input.fallbackDomains,
      errorMessage: message,
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {{ domain: "products" | "orders"; fallbackDomains: Array<"products" | "orders" | "inventory"> }} input
 */
async function handleBulkPoll(prisma, context, input) {
  const status = await prisma.shopBackfillStatus.findUnique({
    where: {
      shopId_domain: { shopId: context.shopId, domain: input.domain },
    },
  });
  const statusMetadata = jsonObject(status?.metadata);
  const operationId =
    stringValue(status?.bulkOperationId) ||
    stringValue(jsonObject(statusMetadata).bulkOperationId);
  if (!operationId) {
    throw new Error(`No bulk operation ID found for ${input.domain}.`);
  }

  const operation = await getShopifyBulkOperation(
    {
      shopDomain: context.shopDomain,
      accessToken: context.accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: context.logger,
      fetchImpl: context.fetchImpl,
    },
    operationId,
  );
  await updateBulkStatus(prisma, context, input.domain, operation, {
    status:
      operation.status === "COMPLETED" ? "bulk_completed" : "bulk_running",
  });

  if (operation.status === "RUNNING" || operation.status === "CREATED") {
    return {
      requeueJob: true,
      runAfter: new Date(Date.now() + BULK_POLL_INTERVAL_MS),
      bulkOperationId: operationId,
      bulkStatus: operation.status,
    };
  }

  if (operation.status !== "COMPLETED") {
    const message =
      operation.errorCode || `Shopify bulk operation ${operation.status}`;
    return runPaginatedFallback(prisma, context, {
      domain: input.domain,
      fallbackDomains: input.fallbackDomains,
      errorMessage: message,
    });
  }

  await updateBulkStatus(prisma, context, input.domain, operation, {
    status: "bulk_downloading",
  });
  await updateBulkStatus(prisma, context, input.domain, operation, {
    status: "bulk_importing",
  });

  try {
    const totals = await importShopifyBulkResult(prisma, {
      shopDomain: context.shopDomain,
      accessToken: context.accessToken,
      sessionId: context.sessionId,
      domain: input.domain,
      operation,
      logger: context.logger,
      fetchImpl: context.fetchImpl,
    });
    const importedAt = new Date().toISOString();
    const recordsProcessed =
      input.domain === "products" && "products" in totals
        ? totals.products
        : "orders" in totals
          ? totals.orders
          : 0;
    await updateBulkStatus(prisma, context, input.domain, operation, {
      status: "bulk_imported",
      recordsProcessed,
      importedAt,
    });

    if (input.domain === "orders") {
      await updateBulkStatus(prisma, context, "refunds", operation, {
        status: "bulk_imported",
        recordsProcessed: "refunds" in totals ? totals.refunds : 0,
        importedAt,
      });
      const customerCount = await prisma.customerIdentity.count({
        where: { shopId: context.shopId },
      });
      await updateBulkStatus(prisma, context, "customers", operation, {
        status: "bulk_imported",
        recordsProcessed: customerCount,
        importedAt,
      });
    }

    await enqueuePostImportJobsIfReady(prisma, context);

    return totals;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Shopify bulk import failed.";
    return runPaginatedFallback(prisma, context, {
      domain: input.domain,
      fallbackDomains: input.fallbackDomains,
      errorMessage: message,
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {{ domain: string; fallbackDomains: Array<"products" | "orders" | "inventory">; errorMessage: string }} input
 */
async function runPaginatedFallback(prisma, context, input) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain: input.domain,
    status: "fallback_paginated_running",
    startedAt: new Date(),
    lastError: input.errorMessage,
    metadata: { fallbackUsed: true, fallbackReason: input.errorMessage },
  });

  const totals = await runShopifyBackfill(prisma, {
    shopDomain: context.shopDomain,
    accessToken: context.accessToken,
    sessionId: context.sessionId,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
    domains: input.fallbackDomains,
    orderBackfillDays: context.orderHistoryDays,
  });

  await markComplete(
    prisma,
    context,
    input.domain,
    domainTotal(totals, input.domain),
    { fallbackUsed: true, fallbackReason: input.errorMessage },
  );

  if (input.domain === "orders") {
    await markComplete(prisma, context, "refunds", totals.refunds, {
      fallbackUsed: true,
      fallbackReason: input.errorMessage,
    });
    const customerCount = await prisma.customerIdentity.count({
      where: { shopId: context.shopId },
    });
    await markComplete(prisma, context, "customers", customerCount, {
      fallbackUsed: true,
      fallbackReason: input.errorMessage,
    });
  }

  await enqueuePostImportJobsIfReady(prisma, context);

  return { ...totals, fallbackUsed: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleDeltaSync(prisma, context) {
  const updatedAfter = new Date(
    (context.startedAt ?? new Date()).getTime() -
      DELTA_SYNC_OVERLAP_HOURS * 60 * 60 * 1000,
  );
  const totals = await runShopifyBackfill(prisma, {
    shopDomain: context.shopDomain,
    accessToken: context.accessToken,
    sessionId: context.sessionId,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
    domains: ["orders"],
    orderUpdatedAfter: updatedAfter,
    orderBackfillDays: context.orderHistoryDays,
  });

  return { ...totals, updatedAfter: updatedAfter.toISOString() };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function enqueuePostImportJobsIfReady(prisma, context) {
  const statuses = await prisma.shopBackfillStatus.findMany({
    where: { shopId: context.shopId },
  });
  const ready = ["products", "orders", "inventory"].every((domain) =>
    isCompleteStatus(
      statuses.find((status) => status.domain === domain)?.status,
    ),
  );
  if (!ready) return;

  const payload = {
    shopDomain: context.shopDomain,
    sessionId: context.sessionId,
    scopes: context.scopes,
    backfillStartedAt: (context.startedAt ?? new Date()).toISOString(),
  };

  await Promise.all([
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "backfill_delta_sync",
      payload,
    }),
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "derived_metrics_recompute",
      payload,
    }),
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "backfill_finalize",
      payload,
    }),
  ]);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleDerivedMetrics(prisma, context) {
  await markRunning(prisma, context, "derived_metrics");
  const brief = await generateDailyBrief(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
  });
  await markComplete(prisma, context, "derived_metrics", 1);

  return { dailyBriefId: brief.id, status: brief.status };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleFinalize(prisma, context) {
  const statuses = await prisma.shopBackfillStatus.findMany({
    where: { shopId: context.shopId },
  });
  const failed = statuses.filter((status) => status.status === "failed");
  const requiredComplete = ["products", "orders", "derived_metrics"].every(
    (domain) =>
      isCompleteStatus(
        statuses.find((status) => status.domain === domain)?.status,
      ),
  );
  const nextSetupStatus =
    failed.length > 0
      ? "backfill_partial"
      : requiredComplete
        ? "ready"
        : "backfill_partial";

  await prisma.shop.update({
    where: { id: context.shopId },
    data: {
      setupStatus: nextSetupStatus,
      backfillCompletedAt: new Date(),
    },
  });

  return {
    setupStatus: nextSetupStatus,
    failedDomains: failed.map((status) => status.domain),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {string} domain
 * @param {string} [status]
 * @param {number | null | undefined} [totalRecordsEstimate]
 */
async function markRunning(
  prisma,
  context,
  domain,
  status = "running",
  totalRecordsEstimate = undefined,
) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain,
    status,
    startedAt: new Date(),
    completedAt: null,
    lastError: null,
    totalRecordsEstimate,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {string} domain
 * @param {number} recordsProcessed
 * @param {unknown} [metadata]
 */
async function markComplete(
  prisma,
  context,
  domain,
  recordsProcessed,
  metadata = undefined,
) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain,
    status: "complete",
    completedAt: new Date(),
    lastError: null,
    recordsProcessed,
    metadata,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {string} domain
 * @param {import("../lib/ingestion/shopify/bulk.server.js").BulkOperationState} operation
 * @param {{ status: string; recordsProcessed?: number; importedAt?: string }} input
 */
async function updateBulkStatus(prisma, context, domain, operation, input) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain,
    status: input.status,
    completedAt:
      input.status === "bulk_imported" || input.status === "bulk_completed"
        ? new Date()
        : undefined,
    lastError: operation.errorCode ?? null,
    recordsProcessed: input.recordsProcessed,
    bulkOperationId: operation.id,
    metadata: bulkStatusMetadata({
      bulkOperation: operation,
      fallbackUsed: false,
      importedAt: input.importedAt ?? null,
    }),
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function applyBackfillCountEstimates(prisma, context) {
  const [products, orders] = await Promise.all([
    loadBackfillCountEstimate(context, "products"),
    loadBackfillCountEstimate(context, "orders"),
  ]);

  await Promise.all(
    [
      ["products", products],
      ["orders", orders],
    ]
      .filter((entry) => typeof entry[1] === "number")
      .map(([domain, totalRecordsEstimate]) =>
        prisma.shopBackfillStatus.update({
          where: {
            shopId_domain: {
              shopId: context.shopId,
              domain: /** @type {string} */ (domain),
            },
          },
          data: {
            totalRecordsEstimate: /** @type {number} */ (
              totalRecordsEstimate
            ),
          },
        }),
      ),
  );
}

/**
 * @param {BackfillContext} context
 * @param {"products" | "orders"} domain
 */
async function loadBackfillCountEstimate(context, domain) {
  try {
    const client = new ShopifyAdminGraphqlClient({
      shopDomain: context.shopDomain,
      accessToken: context.accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: context.logger,
      fetchImpl: context.fetchImpl,
    });

    if (domain === "products") {
      const data = /** @type {{ productsCount?: { count?: number } }} */ (
        await client.request(PRODUCTS_COUNT_QUERY)
      );
      const count = data.productsCount?.count;
      return typeof count === "number" && Number.isFinite(count) ? count : null;
    }

    const data = /** @type {{ ordersCount?: { count?: number } }} */ (
      await client.request(ORDERS_COUNT_QUERY, {
        query: buildOrdersBackfillQueryFilter(context.orderHistoryDays),
      })
    );
    const count = data.ordersCount?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  } catch (error) {
    context.logger.warn("Shopify backfill count estimate unavailable", {
      shopDomain: context.shopDomain,
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; sessionId?: string | null }} input
 */
async function loadAccessToken(prisma, input) {
  const session = input.sessionId
    ? await prisma.session.findFirst({
        where: { id: input.sessionId, shop: input.shopDomain },
      })
    : await prisma.session.findFirst({
        where: { shop: input.shopDomain, isOnline: false },
        orderBy: { expires: "desc" },
      });

  if (!session?.accessToken) {
    throw new Error("No offline Shopify session token is available.");
  }

  return session.accessToken;
}

/** @param {number} attemptCount */
function retryAfter(attemptCount) {
  return new Date(Date.now() + Math.min(5, attemptCount + 1) * 60_000);
}

/**
 * @param {{ products: number; orders: number; inventoryLevels: number }} totals
 * @param {string} domain
 */
function domainTotal(totals, domain) {
  if (domain === "products") return totals.products;
  if (domain === "orders") return totals.orders;
  if (domain === "inventory") return totals.inventoryLevels;
  return 0;
}

/** @param {string | null | undefined} status */
function isCompleteStatus(status) {
  return status === "complete" || status === "bulk_imported";
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/** @param {unknown} value */
function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @typedef {{
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   sessionId: string | null;
 *   accessToken: string;
 *   fetchImpl?: typeof fetch;
 *   logger: Pick<Console, "info" | "warn" | "error">;
 *   scopes: string[];
 *   orderHistoryDays: number;
 *   startedAt: Date | null;
 * }} BackfillContext
 */
