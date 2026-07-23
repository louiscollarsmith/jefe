// @ts-check

import { PrismaClient } from "@prisma/client";
import { runShopifyBackfill } from "../lib/ingestion/shopify/backfill.server.js";
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server.js";
import {
  buildOrdersBackfillQueryFilter,
  ORDERS_COUNT_QUERY,
  PRODUCTS_COUNT_QUERY,
} from "../lib/shopify/queries.server.js";
import {
  DEFAULT_BACKFILL_DAYS,
  enqueueBackfillJob,
  FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS,
  hasReadAllOrders,
  splitScopes,
  upsertBackfillStatus,
} from "./shopify-backfill-status.server.js";
import {
  MEMORY_BACKFILL_DOMAIN,
  MEMORY_REFRESH_JOB_TYPE,
} from "../lib/merchant-memory/constants.server.js";
import { rebuildMerchantMemory } from "../lib/merchant-memory/service.server.js";
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server.js";

const LOOP_INTERVAL_MS = 15_000;
const INITIAL_LOOP_DELAY_MS = 5_000;
const STALE_RUNNING_JOB_TIMEOUT_MS = 15 * 60_000;
const DELTA_SYNC_OVERLAP_HOURS = 24;

let loopStarted = false;
let loopRunning = false;
/** @type {PrismaClient | null} */
let loopPrisma = null;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ intervalMs?: number; initialDelayMs?: number; logger?: Pick<Console, "info" | "warn" | "error"> }} [options]
 */
export function startShopifyBackfillLoop(prisma, options = {}) {
  if (loopStarted || process.env.ENABLE_SHOPIFY_BACKFILL_LOOP === "false") {
    return;
  }

  loopStarted = true;
  const logger = options.logger ?? console;
  const intervalMs = options.intervalMs ?? LOOP_INTERVAL_MS;
  const workerPrisma = createWorkerPrismaClient() ?? prisma;
  loopPrisma = workerPrisma;
  const initialDelayMs =
    options.initialDelayMs ??
    positiveInteger(process.env.SHOPIFY_BACKFILL_INITIAL_DELAY_MS, INITIAL_LOOP_DELAY_MS);
  const tick = async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      await processNextBackfillJob(workerPrisma, { logger });
    } catch (error) {
      logger.error("Shopify evidence backfill loop failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      loopRunning = false;
    }
  };

  setTimeout(() => {
    void tick();
  }, initialDelayMs).unref?.();
  setInterval(() => {
    void tick();
  }, intervalMs).unref?.();
  registerWorkerPrismaShutdown();
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
    const result = await runBackfillJob(prisma, job, options);
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
    const failure = backfillFailureDetails(error);
    const message = failure.message;
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
    if (job.jobType === MEMORY_REFRESH_JOB_TYPE) {
      await markMemoryFailed(prisma, job, failure);
    } else if (failedPermanently) {
      await markEvidenceFailed(prisma, job, failure);
      await prisma.shop.update({
        where: { id: job.shopId },
        data: { setupStatus: "backfill_partial" },
      });
    } else {
      await prisma.shop.update({
        where: { id: job.shopId },
        data: { setupStatus: "backfill_partial" },
      });
    }
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
    options.logger?.warn("Recovered stale Shopify evidence backfill jobs", {
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
  const requiresShopifyToken = job.jobType !== MEMORY_REFRESH_JOB_TYPE;
  const context = {
    merchantId: job.merchantId,
    shopId: job.shopId,
    shopDomain: job.shop.shopDomain,
    sessionId: stringValue(payload.sessionId),
    accessToken: requiresShopifyToken
      ? await loadAccessToken(prisma, {
          shopDomain: job.shop.shopDomain,
          sessionId: stringValue(payload.sessionId),
        })
      : null,
    fetchImpl: options.fetchImpl,
    logger: options.logger ?? console,
    scopes,
    orderHistoryDays,
    startedAt:
      parseDate(payload.backfillStartedAt) ?? job.shop.backfillStartedAt,
  };

  switch (job.jobType) {
    case "shop_backfill_start":
      return handleBackfillStart(prisma, context);
    case "products_backfill":
      return handleEvidenceBackfill(prisma, context, {
        domain: "products",
        backfillDomains: ["products"],
      });
    case "orders_backfill_365d":
      return handleEvidenceBackfill(prisma, context, {
        domain: "orders",
        backfillDomains: ["orders"],
      });
    case "inventory_backfill":
      return handleEvidenceBackfill(prisma, context, {
        domain: "inventory",
        backfillDomains: ["inventory"],
      });
    case "backfill_delta_sync":
      return handleDeltaSync(prisma, context);
    case "backfill_finalize":
      return handleFinalize(prisma, context);
    case MEMORY_REFRESH_JOB_TYPE:
      return handleMerchantMemoryRebuild(prisma, context, payload);
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
async function handleEvidenceBackfill(prisma, context, input) {
  await markRunning(prisma, context, input.domain);
  if (input.domain === "orders") {
    await markRunning(prisma, context, "refunds");
    await markRunning(prisma, context, "customers");
  }

  const totals = await runShopifyBackfill(prisma, {
    shopDomain: context.shopDomain,
    accessToken: requireAccessToken(context),
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

  await enqueueFinalizeIfEvidenceReady(prisma, context);

  return totals;
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
    accessToken: requireAccessToken(context),
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
async function enqueueFinalizeIfEvidenceReady(prisma, context) {
  const statuses = await prisma.shopBackfillStatus.findMany({
    where: { shopId: context.shopId },
  });
  const ready = ["products", "orders", "customers", "inventory"].every(
    (domain) =>
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
      jobType: "backfill_finalize",
      payload,
    }),
  ]);
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
  const requiredComplete = ["products", "orders", "customers", "inventory"].every(
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

  if (requiredComplete) {
    await enqueueMerchantMemoryRefresh(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      shopDomain: context.shopDomain,
      categories: [],
      reason: "shopify_backfill_completed",
    });
  }

  return {
    setupStatus: nextSetupStatus,
    failedDomains: failed.map((status) => status.domain),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {Record<string, any>} payload
 */
async function handleMerchantMemoryRebuild(prisma, context, payload) {
  const categories = Array.isArray(payload.categories)
    ? payload.categories.filter((category) => typeof category === "string")
    : [];

  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    lastError: null,
    metadata: {
      reason: stringValue(payload.reason) ?? "merchant_memory_rebuild",
      categories,
    },
  });

  const result = await rebuildMerchantMemory(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    categories,
    refreshType: categories.length > 0 ? "selective_refresh" : "full_rebuild",
    logger: context.logger,
  });

  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "complete",
    completedAt: new Date(),
    lastError: null,
    recordsProcessed: result.createdOrUpdated,
    metadata: result,
  });

  return result;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} job
 * @param {{ message: string; metadata: Record<string, any> }} failure
 */
async function markMemoryFailed(prisma, job, failure) {
  await upsertBackfillStatus(prisma, {
    merchantId: job.merchantId,
    shopId: job.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "failed",
    completedAt: null,
    lastError: failure.message.slice(0, 1000),
    metadata: { failedAt: new Date().toISOString(), ...failure.metadata },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; jobType: string }} job
 * @param {{ message: string; metadata: Record<string, any> }} failure
 */
async function markEvidenceFailed(prisma, job, failure) {
  await Promise.all(
    failedDomainsForJob(job.jobType).map((domain) =>
      upsertBackfillStatus(prisma, {
        merchantId: job.merchantId,
        shopId: job.shopId,
        domain,
        status: "failed",
        completedAt: null,
        lastError: failure.message.slice(0, 1000),
        metadata: { failedAt: new Date().toISOString(), ...failure.metadata },
      }),
    ),
  );
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
 */
async function markComplete(prisma, context, domain, recordsProcessed) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain,
    status: "complete",
    completedAt: new Date(),
    lastError: null,
    recordsProcessed,
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
      accessToken: requireAccessToken(context),
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
    context.logger.warn("Shopify evidence count estimate unavailable", {
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

/** @param {BackfillContext} context */
function requireAccessToken(context) {
  if (!context.accessToken) {
    throw new Error("No offline Shopify session token is available.");
  }
  return context.accessToken;
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

/** @param {string} jobType */
function failedDomainsForJob(jobType) {
  if (jobType === "products_backfill") return ["products"];
  if (jobType === "orders_backfill_365d") {
    return ["orders", "refunds", "customers"];
  }
  if (jobType === "inventory_backfill") return ["inventory"];
  if (jobType === "backfill_delta_sync") return ["orders", "refunds", "customers"];
  return [];
}

/** @param {unknown} error */
function backfillFailureDetails(error) {
  const baseMessage =
    error instanceof Error ? error.message : "Backfill job failed.";
  const shopifyErrors =
    error && typeof error === "object" && "errors" in error
      ? error.errors
      : null;
  const firstShopifyMessage = firstGraphqlErrorMessage(shopifyErrors);
  const requestId =
    error && typeof error === "object" && "requestId" in error
      ? error.requestId
      : null;
  const message = firstShopifyMessage
    ? `${baseMessage}: ${firstShopifyMessage}`
    : baseMessage;

  return {
    message,
    metadata: {
      requestId: typeof requestId === "string" ? requestId : null,
      shopifyErrors: safeJsonValue(shopifyErrors),
    },
  };
}

/** @param {unknown} errors */
function firstGraphqlErrorMessage(errors) {
  if (!Array.isArray(errors)) return null;
  const first = errors.find(
    (error) => typeof error?.message === "string" && error.message !== "",
  );
  return first?.message ?? null;
}

/** @param {unknown} value */
function safeJsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** @param {string | null | undefined} status */
function isCompleteStatus(status) {
  return status === "complete";
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

/** @param {unknown} value @param {number} fallback */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function createWorkerPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  try {
    const url = new URL(databaseUrl);
    url.searchParams.set("connection_limit", "1");
    return new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });
  } catch {
    return null;
  }
}

function registerWorkerPrismaShutdown() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (loopPrisma && typeof loopPrisma.$disconnect === "function") {
        void loopPrisma.$disconnect();
      }
    });
  }
}

/**
 * @typedef {{
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   sessionId: string | null;
 *   accessToken: string | null;
 *   fetchImpl?: typeof fetch;
 *   logger: Pick<Console, "info" | "warn" | "error">;
 *   scopes: string[];
 *   orderHistoryDays: number;
 *   startedAt: Date | null;
 * }} BackfillContext
 */
