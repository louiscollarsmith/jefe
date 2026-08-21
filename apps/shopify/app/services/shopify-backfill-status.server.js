// @ts-check

import { randomUUID } from "node:crypto";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server.js";
import {
  MEMORY_BACKFILL_DOMAIN,
  MEMORY_REFRESH_JOB_TYPE,
} from "../lib/merchant-memory/constants.server.js";
import { MERCHANT_INSIGHTS_JOB_TYPE } from "../lib/merchant-insights/constants.server.js";
import { MERCHANT_GOALS_JOB_TYPE } from "../lib/merchant-goals/constants.server.js";
import { MERCHANT_PLAN_JOB_TYPE } from "../lib/merchant-plan/constants.server.js";
import { AGENTIC_RECOMMENDATION_JOB_TYPE } from "../lib/shopify/agentic-runtime/constants.server.js";
import { DEFAULT_BACKFILL_DAYS } from "../lib/shopify/backfill-window.server.js";
import { normalizeShopDomain } from "../lib/shopify/admin-graphql.server.js";
import { trackOnce } from "./analytics/event-log.server.js";

export { DEFAULT_BACKFILL_DAYS };
export const FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS = 60;
export const BOOTSTRAP_BACKFILL_DOMAIN = "bootstrap";
export const MERCHANT_BOOTSTRAP_JOB_TYPE = "merchant_memory_bootstrap";
export const BOOTSTRAP_ALTERNATIVE_JOB_TYPE = "merchant_bootstrap_alternative";
export const RECOMMENDATION_REVIEW_JOB_TYPE = "recommendation_review";
export const BACKFILL_DOMAINS = [
  "shop",
  "webhooks",
  "products",
  "orders",
  "customers",
  "inventory",
  "refunds",
  BOOTSTRAP_BACKFILL_DOMAIN,
  MEMORY_BACKFILL_DOMAIN,
];
export const INITIAL_COMMERCE_BACKFILL_DOMAINS = [
  "products",
  "inventory",
  "orders",
  "customers",
  "refunds",
];
export const FULL_BACKFILL_JOB_TYPES = [
  "shop_backfill_start",
  "products_backfill",
  "inventory_backfill",
  "orders_backfill_365d",
  "backfill_delta_sync",
  "backfill_finalize",
];

const JOB_PRIORITIES = {
  [MERCHANT_BOOTSTRAP_JOB_TYPE]: 5,
  [BOOTSTRAP_ALTERNATIVE_JOB_TYPE]: 6,
  shop_backfill_start: 10,
  products_backfill: 20,
  inventory_backfill: 30,
  orders_backfill_365d: 40,
  backfill_delta_sync: 50,
  backfill_finalize: 70,
  [MEMORY_REFRESH_JOB_TYPE]: 80,
  [MERCHANT_INSIGHTS_JOB_TYPE]: 90,
  [MERCHANT_GOALS_JOB_TYPE]: 100,
  [AGENTIC_RECOMMENDATION_JOB_TYPE]: 110,
  [MERCHANT_PLAN_JOB_TYPE]: 115,
  [RECOMMENDATION_REVIEW_JOB_TYPE]: 120,
};

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; sessionId?: string | null; scopes?: string[]; rawPayload?: unknown; force?: boolean }} input
 */
export async function queueInstallShopifyBackfill(prisma, input) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const existingShop = await prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    include: { backfillStatuses: true, backfillJobs: true },
  });
  const isReinstall = wasUninstalled(existingShop);
  const scopes = input.scopes ?? [];
  const hasHistoricalOrders = hasReadAllOrders(scopes);
  const availableOrderHistoryDays = hasHistoricalOrders
    ? DEFAULT_BACKFILL_DAYS
    : FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS;
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain,
    accessTokenSessionId: input.sessionId,
    scopes,
    rawPayload: Object.assign(
      { source: "install_evidence_backfill_queue" },
      jsonObject(input.rawPayload),
    ),
  });

  if (
    !input.force &&
    existingShop &&
    !isReinstall &&
    hasInstallBackfillState(existingShop)
  ) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        status: "active",
        uninstalledAt: null,
        historicalOrderAccess: hasHistoricalOrders ? "full" : "limited",
        availableOrderHistoryDays,
      },
    });
    const existingBootstrap = existingShop.backfillJobs.some(
      (job) => job.jobType === MERCHANT_BOOTSTRAP_JOB_TYPE,
    );
    if (!existingShop.onboardingCompletedAt || existingBootstrap) {
      await ensureMerchantBootstrapQueued(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        sessionId: input.sessionId,
        scopes,
      });
    }
    return prisma.backfillJob.findUnique({
      where: {
        shopId_jobType: { shopId: shop.id, jobType: "shop_backfill_start" },
      },
    });
  }

  const backfillStartedAt = new Date();
  const onboardingEpoch = randomUUID();
  const fullBackfillEpoch = randomUUID();

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      status: "active",
      // Belt-and-suspenders with ensureShopifyTenant's reactivation: any Shop→active
      // write clears the uninstall stamp so it never lingers on a live shop.
      uninstalledAt: null,
      setupStatus: "backfill_queued",
      historicalOrderAccess: hasHistoricalOrders ? "full" : "limited",
      availableOrderHistoryDays,
      backfillStartedAt,
      backfillCompletedAt: null,
    },
  });

  await Promise.all(
    BACKFILL_DOMAINS.map((domain) => {
      if (!shouldResetBackfillDomain(existingShop, domain, isReinstall)) {
        return Promise.resolve(null);
      }

      return upsertBackfillStatus(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        domain,
        status:
          domain === "shop" || domain === "webhooks" ? "complete" : "queued",
        startedAt:
          domain === "shop" || domain === "webhooks"
            ? backfillStartedAt
            : null,
        completedAt:
          domain === "shop" || domain === "webhooks"
            ? backfillStartedAt
            : null,
        recordsProcessed: 0,
        lastError: null,
        metadata:
          domain === "orders"
            ? {
                availableOrderHistoryDays,
                historicalOrderAccess: hasHistoricalOrders
                  ? "full"
                  : "limited",
              }
            : {},
      });
    }),
  );

  const payload = {
    shopDomain: shop.shopDomain,
    sessionId: input.sessionId ?? null,
    scopes,
    availableOrderHistoryDays,
    backfillStartedAt: backfillStartedAt.toISOString(),
    fullBackfillEpoch,
  };
  const [fullJob] = await Promise.all([
    enqueueBackfillJob(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      jobType: "shop_backfill_start",
      payload,
    }),
    ensureMerchantBootstrapQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      sessionId: input.sessionId,
      scopes,
      reset: isReinstall,
      onboardingEpoch,
    }),
    trackOnce(prisma, {
      type: "shopify_connected",
      topic: "onboarding",
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      dedupeKey: `shopify_connected:${shop.id}:${onboardingEpoch}`,
      summary: `Shopify connected for ${shop.shopDomain}`,
      properties: {
        backfillStartedAt: backfillStartedAt.toISOString(),
        onboardingEpoch,
        fullBackfillEpoch,
      },
    }),
  ]);
  return fullJob;
}

/**
 * Ensure bootstrap exists without resetting queued/running/succeeded work.
 * Explicit retry/reinstall is the only reset path.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; sessionId?: string | null; scopes?: string[]; reset?: boolean; onboardingEpoch?: string }} input
 */
export async function ensureMerchantBootstrapQueued(prisma, input) {
  const existing = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType: MERCHANT_BOOTSTRAP_JOB_TYPE } },
  });
  const existingPayload = jsonObject(existing?.payloadJson);
  const onboardingEpoch =
    input.onboardingEpoch ??
    (!input.reset && typeof existingPayload.onboardingEpoch === "string"
      ? existingPayload.onboardingEpoch
      : !input.reset && existing?.id
        ? existing.id
        : randomUUID());
  const payload = {
    shopDomain: input.shopDomain,
    sessionId: input.sessionId ?? null,
    scopes: input.scopes ?? [],
    onboardingEpoch,
  };
  if (existing && !input.reset) {
    if (typeof existingPayload.onboardingEpoch === "string") return existing;
    return prisma.backfillJob.update({
      where: { id: existing.id },
      data: {
        payloadJson: { ...existingPayload, ...payload },
      },
    });
  }

  await upsertBackfillStatus(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    domain: BOOTSTRAP_BACKFILL_DOMAIN,
    status: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    metadata: {
      phase: "queued",
      queuedAt: new Date().toISOString(),
      onboardingEpoch,
    },
  });
  if (existing) {
    return prisma.backfillJob.update({
      where: { id: existing.id },
      data: {
        status: "queued",
        priority: jobPriority(MERCHANT_BOOTSTRAP_JOB_TYPE),
        runAfter: new Date(),
        startedAt: null,
        completedAt: null,
        failedAt: null,
        lastError: null,
        attemptCount: 0,
        payloadJson: payload,
        resultJson: {},
      },
    });
  }
  try {
    return await prisma.backfillJob.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        jobType: MERCHANT_BOOTSTRAP_JOB_TYPE,
        status: "queued",
        priority: jobPriority(MERCHANT_BOOTSTRAP_JOB_TYPE),
        payloadJson: payload,
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return prisma.backfillJob.findUnique({
        where: { shopId_jobType: { shopId: input.shopId, jobType: MERCHANT_BOOTSTRAP_JOB_TYPE } },
      });
    }
    throw error;
  }
}

/**
 * Queue one idempotent alternative-contract generation while retaining the
 * current insight. Duplicate clicks reuse the same per-shop job.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; contractKey: string }} input
 */
export async function ensureBootstrapAlternativeQueued(prisma, input) {
  const existing = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType: BOOTSTRAP_ALTERNATIVE_JOB_TYPE } },
  });
  if (existing?.status === "queued" || existing?.status === "running") return existing;
  return enqueueBackfillJob(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    jobType: BOOTSTRAP_ALTERNATIVE_JOB_TYPE,
    payload: { contractKey: input.contractKey },
  });
}

/** Preserve the earliest due review and never reset a running review job. */
/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runAfter: Date | string; payload?: unknown }} input
 */
export async function ensureRecommendationReviewQueued(prisma, input) {
  const existing = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType: RECOMMENDATION_REVIEW_JOB_TYPE } },
  });
  const runAfter = input.runAfter instanceof Date ? input.runAfter : new Date(input.runAfter);
  if (!existing) {
    return enqueueBackfillJob(prisma, { ...input, jobType: RECOMMENDATION_REVIEW_JOB_TYPE, runAfter });
  }
  if (existing.status === "running") {
    const existingPayload = jsonObject(existing.payloadJson);
    const requestedRunAfter =
      existingPayload.requestedRunAfter &&
      new Date(existingPayload.requestedRunAfter) < runAfter
        ? new Date(existingPayload.requestedRunAfter)
        : runAfter;
    return prisma.backfillJob.update({
      where: { id: existing.id },
      data: {
        payloadJson: {
          ...existingPayload,
          ...jsonObject(input.payload),
          rescanRequested: true,
          requestedRunAfter: requestedRunAfter.toISOString(),
        },
      },
    });
  }
  const earliest = existing.status === "queued" && existing.runAfter < runAfter ? existing.runAfter : runAfter;
  return prisma.backfillJob.update({
    where: { id: existing.id },
    data: {
      status: "queued",
      priority: jobPriority(RECOMMENDATION_REVIEW_JOB_TYPE),
      runAfter: earliest,
      completedAt: null,
      failedAt: null,
      lastError: null,
      attemptCount: 0,
      startedAt: null,
      payloadJson: jsonObject(input.payload),
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
 * @param {{ shopId: string; jobTypes?: string[] }} input
 */
export async function retryFailedBackfillJobs(prisma, input) {
  const result = await prisma.backfillJob.updateMany({
    where: {
      shopId: input.shopId,
      status: "failed",
      jobType: input.jobTypes?.length ? { in: input.jobTypes } : undefined,
    },
    data: {
      status: "queued",
      runAfter: new Date(),
      failedAt: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
      attemptCount: 0,
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

/**
 * @param {{ status?: string | null; setupStatus?: string | null; uninstalledAt?: Date | string | null } | null} shop
 */
function wasUninstalled(shop) {
  return Boolean(
    shop &&
      (shop.status === "uninstalled" ||
        shop.setupStatus === "uninstalled" ||
        shop.uninstalledAt),
  );
}

/**
 * A routine OAuth callback must not restart an install backfill that is already
 * queued, running, failed or complete. Reinstall is handled before this guard.
 * @param {{ backfillStartedAt?: Date | string | null; backfillCompletedAt?: Date | string | null; backfillStatuses?: Array<{ domain: string }>; backfillJobs?: Array<{ jobType: string }> } | null} shop
 */
function hasInstallBackfillState(shop) {
  if (!shop) return false;
  if (shop.backfillStartedAt || shop.backfillCompletedAt) return true;
  if ((shop.backfillStatuses ?? []).length > 0) return true;
  return (shop.backfillJobs ?? []).length > 0;
}

/**
 * @param {{ backfillStatuses?: Array<{ domain: string; status: string | null }> } | null} shop
 * @param {string} domain
 * @param {boolean} isReinstall
 */
function shouldResetBackfillDomain(shop, domain, isReinstall) {
  if (isReinstall) return true;
  if (domain === "shop" || domain === "webhooks") return true;
  return !isCompleteStatus(
    shop?.backfillStatuses?.find((status) => status.domain === domain)?.status,
  );
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
