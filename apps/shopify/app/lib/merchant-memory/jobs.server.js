// @ts-check

import {
  enqueueBackfillJob,
  upsertBackfillStatus,
} from "../../services/shopify-backfill-status.server.js";
import {
  MEMORY_BACKFILL_DOMAIN,
  MEMORY_REFRESH_JOB_TYPE,
} from "./constants.server.js";

/** @type {Record<string, string[]>} */
const TOPIC_CATEGORIES = {
  "products/create": ["catalog", "inventory"],
  "products/update": ["catalog", "inventory"],
  "products/delete": ["catalog", "inventory"],
  "orders/create": ["orders", "customers", "refunds", "inventory", "business"],
  "orders/updated": ["orders", "customers", "refunds", "inventory", "business"],
  "orders/cancelled": ["orders", "customers", "refunds", "inventory"],
  "refunds/create": ["refunds", "orders", "business"],
  "inventory_levels/update": ["inventory", "catalog"],
};

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain?: string | null; categories?: string[]; reason: string; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function enqueueMerchantMemoryRefresh(prisma, input) {
  await upsertBackfillStatus(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    metadata: {
      reason: input.reason,
      categories: input.categories ?? [],
      queuedAt: new Date().toISOString(),
    },
  });

  return enqueueBackfillJob(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    jobType: MEMORY_REFRESH_JOB_TYPE,
    runAfter: input.runAfter,
    resetAttempts: input.resetAttempts,
    payload: {
      shopDomain: input.shopDomain ?? null,
      categories: input.categories ?? [],
      reason: input.reason,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain?: string | null; topic: string }} input
 */
export async function enqueueMerchantMemoryRefreshForWebhook(prisma, input) {
  const categories = TOPIC_CATEGORIES[input.topic];
  if (!categories) return null;

  return enqueueMerchantMemoryRefresh(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    categories,
    reason: `shopify_webhook:${input.topic}`,
    runAfter: new Date(Date.now() + 30_000),
    resetAttempts: false,
  });
}
