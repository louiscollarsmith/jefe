// @ts-check

import { buildActivityFeed, formatActivityDigest } from "./activity-feed.server.js";
import { listRecentActivity } from "./event-log.server.js";
import { logger as baseLogger } from "../../lib/observability/logger.server.js";

/**
 * Build (and optionally post) the activity digest from the event log — the
 * push-model "what happened" pulse for the ops Slack channel. Reads
 * activity_events (the canonical log) so it matches the panel exactly.
 *
 * Never throws: a digest failure must not disturb the worker loop that schedules
 * it. Returns { text, posted, feed } for callers/tests.
 */

const log = baseLogger.child({ component: "activity-digest" });

/**
 * @param {{ activityEvent: { findMany: (args: any) => Promise<any[]> } }} prisma
 * @param {{ windowHours?: number; now?: Date; webhookUrl?: string; fetchImpl?: typeof fetch }} [options]
 */
export async function runActivityDigest(prisma, options = {}) {
  const windowHours = options.windowHours ?? 24;
  const now = options.now ?? new Date();

  let events = [];
  try {
    const rows = await listRecentActivity(prisma, {
      sinceHours: windowHours,
      limit: 500,
    });
    events = rows.map((r) => ({
      ts: new Date(r.createdAt).toISOString(),
      type: r.type,
      shopDomain: r.shopDomain ?? "unknown",
      detail: r.topic ?? undefined,
    }));
  } catch (error) {
    log.warn("Activity digest: failed to read events", { err: error });
    return { text: "", posted: false, feed: null };
  }

  const feed = buildActivityFeed(events, { now, windowHours });
  const text = formatActivityDigest(feed);

  const webhookUrl = options.webhookUrl;
  const fetchImpl =
    options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);

  if (!webhookUrl || !fetchImpl) {
    return { text, posted: false, feed };
  }

  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}`);
    return { text, posted: true, feed };
  } catch (error) {
    log.warn("Activity digest: failed to post to Slack", { err: error });
    return { text, posted: false, feed };
  }
}
