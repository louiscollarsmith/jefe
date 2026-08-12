// @ts-check

import { redact } from "../../lib/observability/redact.server.js";
import { logger as baseLogger } from "../../lib/observability/logger.server.js";

/**
 * The activity/event log — the write + read side of the internal observability
 * panel. `track()` records one event per meaningful user/system action; the
 * panel (and the Slack digest) read these back, filtered by topic/merchant and
 * searched by summary text.
 *
 * Design:
 * - **Never breaks the action it describes.** `track()` is best-effort and
 *   self-catching; a logging failure must not fail an install, a webhook, or a
 *   generation run. Callers `void track(...)` (fire-and-forget) or await it in a
 *   context where its rejection is already handled — either way it never throws.
 * - **PII-free.** Events carry shop domain + type/topic + a short summary +
 *   small properties. `properties` is passed through `redact()` as a safety net,
 *   but callers must not put customer data in events in the first place.
 */

const log = baseLogger.child({ component: "activity-log" });

/**
 * @typedef {object} ActivityEventInput
 * @property {string} type Machine event type, e.g. "shop_installed", "memory_rebuilt".
 * @property {string} [topic] Coarse category for filtering, e.g. "onboarding", "memory".
 * @property {string} [summary] Human-readable, searchable one-liner.
 * @property {string} [merchantId]
 * @property {string} [shopId]
 * @property {string} [shopDomain]
 * @property {Record<string, unknown>} [properties] Small, PII-free extra context.
 * @property {string} [dedupeKey] Stable key for one-time milestones.
 */

/**
 * Record an activity event. Best-effort and non-throwing.
 *
 * @param {{ activityEvent: { create: (args: any) => Promise<unknown> } }} prisma
 * @param {ActivityEventInput} event
 * @returns {Promise<boolean>} true if written, false if it was skipped/failed.
 */
export async function track(prisma, event) {
  if (!event || !event.type) return false;
  try {
    await prisma.activityEvent.create({
      data: {
        type: event.type,
        topic: event.topic ?? null,
        summary: event.summary ?? null,
        merchantId: event.merchantId ?? null,
        shopId: event.shopId ?? null,
        shopDomain: event.shopDomain ?? null,
        properties: event.properties
          ? /** @type {any} */ (redact(event.properties))
          : {},
        dedupeKey: event.dedupeKey ?? null,
      },
    });
    return true;
  } catch (error) {
    // Swallow — recording an event must never break the thing it describes.
    log.warn("Failed to record activity event", { err: error, type: event.type });
    return false;
  }
}

/**
 * Record a milestone once. Unlike `track`, duplicate-key conflicts count as a
 * successful no-op; all other failures retain the activity log's best-effort,
 * non-throwing contract.
 * @param {{ activityEvent: { create: (args: any) => Promise<unknown> } }} prisma
 * @param {ActivityEventInput & { dedupeKey: string }} event
 */
export async function trackOnce(prisma, event) {
  if (!event?.type || !event.dedupeKey) return false;
  try {
    await prisma.activityEvent.create({
      data: {
        type: event.type,
        topic: event.topic ?? null,
        summary: event.summary ?? null,
        merchantId: event.merchantId ?? null,
        shopId: event.shopId ?? null,
        shopDomain: event.shopDomain ?? null,
        dedupeKey: event.dedupeKey,
        properties: event.properties
          ? /** @type {any} */ (redact(event.properties))
          : {},
      },
    });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return true;
    }
    log.warn("Failed to record one-time activity event", {
      err: error,
      type: event.type,
    });
    return false;
  }
}

/**
 * Read recent activity, newest first, with optional filters. Powers the panel
 * and the digest. `search` matches the summary (case-insensitive substring).
 *
 * @param {{ activityEvent: { findMany: (args: any) => Promise<any[]> } }} prisma
 * @param {{ type?: string; topic?: string; shopDomain?: string; search?: string; sinceHours?: number; limit?: number }} [filters]
 * @returns {Promise<any[]>}
 */
export async function listRecentActivity(prisma, filters = {}) {
  /** @type {Record<string, unknown>} */
  const where = {};
  if (filters.type) where.type = filters.type;
  if (filters.topic) where.topic = filters.topic;
  if (filters.shopDomain) where.shopDomain = filters.shopDomain;
  if (filters.search) where.summary = { contains: filters.search, mode: "insensitive" };
  if (filters.sinceHours) {
    where.createdAt = {
      gte: new Date(Date.now() - filters.sinceHours * 60 * 60 * 1000),
    };
  }

  return prisma.activityEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 100, 500),
  });
}
