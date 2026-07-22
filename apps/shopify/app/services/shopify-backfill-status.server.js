// @ts-check

import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server.js";
import {
  MEMORY_BACKFILL_DOMAIN,
  MEMORY_REFRESH_JOB_TYPE,
} from "../lib/merchant-memory/constants.server.js";

export const DEFAULT_BACKFILL_DAYS = 365;
export const FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS = 60;
export const BACKFILL_DOMAINS = [
  "shop",
  "webhooks",
  "products",
  "orders",
  "customers",
  "inventory",
  "refunds",
  MEMORY_BACKFILL_DOMAIN,
];

const JOB_PRIORITIES = {
  shop_backfill_start: 10,
  products_backfill: 20,
  orders_backfill_365d: 30,
  inventory_backfill: 40,
  backfill_delta_sync: 50,
  backfill_finalize: 70,
  [MEMORY_REFRESH_JOB_TYPE]: 80,
};

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; sessionId?: string | null; scopes?: string[]; rawPayload?: unknown }} input
 */
export async function queueInstallShopifyBackfill(prisma, input) {
  const scopes = input.scopes ?? [];
  const hasHistoricalOrders = hasReadAllOrders(scopes);
  const availableOrderHistoryDays = hasHistoricalOrders
    ? DEFAULT_BACKFILL_DAYS
    : FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS;
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: input.shopDomain,
    accessTokenSessionId: input.sessionId,
    scopes,
    rawPayload: Object.assign(
      { source: "install_evidence_backfill_queue" },
      jsonObject(input.rawPayload),
    ),
  });
  const backfillStartedAt = new Date();

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      status: "active",
      setupStatus: "backfill_queued",
      historicalOrderAccess: hasHistoricalOrders ? "full" : "limited",
      availableOrderHistoryDays,
      backfillStartedAt,
      backfillCompletedAt: null,
    },
  });

  await Promise.all(
    BACKFILL_DOMAINS.map((domain) =>
      upsertBackfillStatus(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        domain,
        status:
          domain === "shop" || domain === "webhooks" ? "complete" : "queued",
        startedAt:
          domain === "shop" || domain === "webhooks" ? backfillStartedAt : null,
        completedAt:
          domain === "shop" || domain === "webhooks" ? backfillStartedAt : null,
        recordsProcessed: 0,
        lastError: null,
        metadata:
          domain === "orders"
            ? {
                availableOrderHistoryDays,
                historicalOrderAccess: hasHistoricalOrders ? "full" : "limited",
              }
            : {},
      }),
    ),
  );

  return enqueueBackfillJob(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    jobType: "shop_backfill_start",
    payload: {
      shopDomain: shop.shopDomain,
      sessionId: input.sessionId ?? null,
      scopes,
      availableOrderHistoryDays,
      backfillStartedAt: backfillStartedAt.toISOString(),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; jobType: string; payload?: unknown; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function enqueueBackfillJob(prisma, input) {
  return prisma.backfillJob.upsert({
    where: {
      shopId_jobType: { shopId: input.shopId, jobType: input.jobType },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      jobType: input.jobType,
      status: "queued",
      priority: jobPriority(input.jobType),
      runAfter: input.runAfter ?? new Date(),
      payloadJson: jsonObject(input.payload),
    },
    update: {
      status: "queued",
      priority: jobPriority(input.jobType),
      runAfter: input.runAfter ?? new Date(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      attemptCount: input.resetAttempts === false ? undefined : 0,
      payloadJson: jsonObject(input.payload),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; domain: string; status: string; startedAt?: Date | null; completedAt?: Date | null; lastError?: string | null; recordsProcessed?: number; totalRecordsEstimate?: number | null; lastCursor?: string | null; bulkOperationId?: string | null; metadata?: unknown }} input
 */
export async function upsertBackfillStatus(prisma, input) {
  return prisma.shopBackfillStatus.upsert({
    where: { shopId_domain: { shopId: input.shopId, domain: input.domain } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      domain: input.domain,
      status: input.status,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      lastError: input.lastError ?? null,
      recordsProcessed: input.recordsProcessed ?? 0,
      totalRecordsEstimate: input.totalRecordsEstimate ?? null,
      lastCursor: input.lastCursor ?? null,
      bulkOperationId: input.bulkOperationId ?? null,
      metadata: jsonObject(input.metadata),
    },
    update: {
      status: input.status,
      startedAt: input.startedAt === undefined ? undefined : input.startedAt,
      completedAt:
        input.completedAt === undefined ? undefined : input.completedAt,
      lastError: input.lastError === undefined ? undefined : input.lastError,
      recordsProcessed:
        input.recordsProcessed === undefined
          ? undefined
          : input.recordsProcessed,
      totalRecordsEstimate:
        input.totalRecordsEstimate === undefined
          ? undefined
          : input.totalRecordsEstimate,
      lastCursor: input.lastCursor === undefined ? undefined : input.lastCursor,
      bulkOperationId:
        input.bulkOperationId === undefined ? undefined : input.bulkOperationId,
      metadata:
        input.metadata === undefined ? undefined : jsonObject(input.metadata),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string }} input
 */
export async function getShopBackfillProgress(prisma, input) {
  const shop = await prisma.shop.findUnique({
    where: { id: input.shopId },
    include: {
      backfillStatuses: { orderBy: { domain: "asc" } },
      backfillJobs: { orderBy: [{ priority: "asc" }, { updatedAt: "desc" }] },
    },
  });

  if (!shop) return null;

  const statusByDomain = Object.fromEntries(
    BACKFILL_DOMAINS.map((domain) => [
      domain,
      shop.backfillStatuses.find((status) => status.domain === domain) ?? null,
    ]),
  );

  return {
    shop,
    statuses: statusByDomain,
    jobs: shop.backfillJobs,
    productsComplete: isCompleteStatus(statusByDomain.products?.status),
    ordersComplete: isCompleteStatus(statusByDomain.orders?.status),
    customersComplete: isCompleteStatus(statusByDomain.customers?.status),
    inventoryComplete: isCompleteStatus(statusByDomain.inventory?.status),
    evidenceReady: ["products", "orders", "customers", "inventory"].every(
      (domain) => isCompleteStatus(statusByDomain[domain]?.status),
    ),
    historicalOrdersLimited: shop.historicalOrderAccess === "limited",
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string }} input
 */
export async function retryFailedBackfillJobs(prisma, input) {
  const result = await prisma.backfillJob.updateMany({
    where: {
      shopId: input.shopId,
      status: "failed",
    },
    data: {
      status: "queued",
      runAfter: new Date(),
      failedAt: null,
      lastError: null,
    },
  });

  return { retried: result.count };
}

/**
 * @param {string | string[] | null | undefined} scopes
 */
export function splitScopes(scopes) {
  return Array.isArray(scopes)
    ? scopes
    : String(scopes ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
}

/** @param {string | string[] | null | undefined} scopes */
export function hasReadAllOrders(scopes) {
  return splitScopes(scopes).includes("read_all_orders");
}

/** @param {string} jobType */
function jobPriority(jobType) {
  return Object.prototype.hasOwnProperty.call(JOB_PRIORITIES, jobType)
    ? JOB_PRIORITIES[/** @type {keyof typeof JOB_PRIORITIES} */ (jobType)]
    : 100;
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
