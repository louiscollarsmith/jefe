// @ts-check
// Best-effort hook: enqueue the next proactive recommendation when the merchant finishes
// or rejects the current one. Uses a dynamic import of the plan service so action lifecycle
// modules can call this without a static import cycle.

import { maybeEnqueueProactivePlanAfterTerminalState } from "./proactive-recommendations.server.js";
import { storeTimeZoneFromPayload } from "../home/home-dates.js";
import { logger as baseLogger } from "../observability/logger.server.js";

const log = baseLogger.child({ component: "proactive-trigger" });

/**
 * Fire-and-forget: schedule the next proactive recommendation after a terminal state.
 * Never throws into the caller.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; trigger: string; timeZone?: string | null; shopRawPayload?: unknown }} input
 */
export function scheduleProactivePlanAfterTerminalState(prisma, input) {
  if (process.env.ENABLE_PROACTIVE_RECOMMENDATIONS !== "true") return;
  void triggerNextProactiveRecommendation(prisma, input).catch((error) => {
    log.warn("Proactive recommendation trigger failed (non-fatal)", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      trigger: input.trigger,
      err: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; trigger: string; timeZone?: string | null; shopRawPayload?: unknown }} input
 */
export async function triggerNextProactiveRecommendation(prisma, input) {
  const { ensureMerchantPlanQueued } = await import("./service.server.js");
  let timeZone = input.timeZone ?? null;
  if (!timeZone && input.shopRawPayload != null) {
    timeZone = storeTimeZoneFromPayload(input.shopRawPayload);
  }
  if (!timeZone && prisma?.shop?.findFirst) {
    const shop = await prisma.shop.findFirst({
      where: { id: input.shopId, merchantId: input.merchantId },
      select: { rawPayload: true },
    });
    timeZone = storeTimeZoneFromPayload(shop?.rawPayload);
  }
  const result = await maybeEnqueueProactivePlanAfterTerminalState(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    timeZone,
    ensureQueued: ensureMerchantPlanQueued,
  });
  if (result.enqueued) {
    log.info("Proactive recommendation enqueued after terminal state", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      trigger: input.trigger,
    });
  }
  return result;
}
