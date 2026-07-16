// @ts-check

import {
  BACKFILL_DOMAINS,
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "./shopify-backfill-status.server.js";
import {
  generateDailyBrief,
  getLatestDailyBrief,
} from "./daily-brief.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; sessionId?: string | null; scopes?: string[]; source: string; generateIfImportComplete?: boolean }} input
 */
export async function getDailyBriefReadiness(prisma, input) {
  const progress = await ensureBackfillProgress(prisma, input);
  let latestBrief = await getLatestDailyBrief(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
  });
  const importComplete = allBackfillDomainsComplete(progress);

  if (
    importComplete &&
    input.generateIfImportComplete &&
    !isReadyDailyBriefStatus(latestBrief?.status)
  ) {
    latestBrief = await generateDailyBrief(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
    });
  }

  return {
    progress,
    latestBrief,
    importComplete,
    briefReady: importComplete && isReadyDailyBriefStatus(latestBrief?.status),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; shopDomain: string; sessionId?: string | null; scopes?: string[]; source: string }} input
 */
export async function ensureBackfillProgress(prisma, input) {
  let progress = await getShopBackfillProgress(prisma, {
    shopId: input.shopId,
  });
  const hasBackfillRows =
    progress &&
    (progress.jobs.length > 0 ||
      Object.values(progress.statuses).some(Boolean));

  if (progress && !hasBackfillRows) {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: input.shopDomain,
      sessionId: input.sessionId,
      scopes: splitScopes(input.scopes),
      rawPayload: { source: input.source },
    });
    progress = await getShopBackfillProgress(prisma, {
      shopId: input.shopId,
    });
  }

  return progress;
}

/** @param {Awaited<ReturnType<typeof getShopBackfillProgress>>} progress */
export function allBackfillDomainsComplete(progress) {
  if (!progress) return false;

  return BACKFILL_DOMAINS.every((domain) =>
    isCompleteBackfillStatus(progress.statuses[domain]?.status),
  );
}

/** @param {string | null | undefined} status */
export function isCompleteBackfillStatus(status) {
  return status === "complete" || status === "bulk_imported";
}

/** @param {string | null | undefined} status */
export function isReadyDailyBriefStatus(status) {
  return status === "generated" || status === "degraded";
}
