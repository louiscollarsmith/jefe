// @ts-check

/**
 * Activity feed — a chronological "what's been going on in Jefe" stream, built
 * from data the app already writes (install/onboarding timestamps, completed
 * backfills, memory rebuilds, generation runs, channel connections). No new
 * tables and no per-event instrumentation: the CLI/digest fetches recent rows,
 * maps each to a normalized event, and hands them here.
 *
 * The point (per the founder) is a PUSH surface — a compact digest posted to the
 * ops Slack channel on a schedule — not another dashboard to remember to open.
 * So this module produces both the structured feed and a Slack-ready text block.
 *
 * Events carry no customer PII — shop domain (the merchant's own store handle)
 * and event type only.
 */

/**
 * @typedef {object} ActivityEvent
 * @property {string} ts ISO timestamp.
 * @property {string} type One of the keys in EVENT_META.
 * @property {string} shopDomain Merchant store handle (not customer data).
 * @property {string} [detail] Short extra context (e.g. which generation failed).
 */

/**
 * Display metadata per event type. `severity: "warn"` surfaces under Needs attention.
 * @type {Record<string, { emoji: string; label: string; severity: string }>}
 */
export const EVENT_META = {
  shop_installed: { emoji: "🆕", label: "installed", severity: "info" },
  onboarding_completed: { emoji: "✅", label: "onboarding completed", severity: "info" },
  backfill_completed: { emoji: "📦", label: "evidence backfilled", severity: "info" },
  memory_rebuilt: { emoji: "🧠", label: "memory rebuilt", severity: "info" },
  insights_generated: { emoji: "💡", label: "insights generated", severity: "info" },
  goals_generated: { emoji: "🎯", label: "goals generated", severity: "info" },
  plan_generated: { emoji: "📋", label: "plan generated", severity: "info" },
  channel_connected: { emoji: "🔌", label: "channel connected", severity: "info" },
  generation_failed: { emoji: "⚠️", label: "generation failed", severity: "warn" },
  job_failed: { emoji: "⚠️", label: "job failed", severity: "warn" },
};

/**
 * @param {string} type
 */
function metaFor(type) {
  return EVENT_META[type] ?? { emoji: "•", label: type, severity: "info" };
}

/**
 * Build the structured activity feed over a trailing window.
 *
 * @param {ActivityEvent[]} events
 * @param {{ now: Date; windowHours?: number }} options
 */
export function buildActivityFeed(events, options) {
  const windowHours = options.windowHours ?? 24;
  const cutoff = options.now.getTime() - windowHours * 60 * 60 * 1000;

  const inWindow = events
    .filter((e) => {
      const t = new Date(e.ts).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  /** @type {Record<string, number>} */
  const byType = {};
  const shops = new Set();
  for (const e of inWindow) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    shops.add(e.shopDomain);
  }

  const attention = inWindow.filter((e) => metaFor(e.type).severity === "warn");

  return {
    generatedAt: options.now.toISOString(),
    windowHours,
    totalEvents: inWindow.length,
    activeShops: shops.size,
    byType,
    attention,
    events: inWindow,
  };
}

/**
 * @param {string} ts ISO timestamp
 * @returns {string} "MM-DD HH:MM" (UTC)
 */
function shortTime(ts) {
  // "2026-07-28T21:40:12.000Z" -> "07-28 21:40"
  return `${ts.slice(5, 10)} ${ts.slice(11, 16)}`;
}

/**
 * Render the feed as a compact Slack-friendly digest.
 *
 * @param {ReturnType<typeof buildActivityFeed>} feed
 * @param {{ recentLimit?: number }} [options]
 * @returns {string}
 */
export function formatActivityDigest(feed, options = {}) {
  const recentLimit = options.recentLimit ?? 12;
  const lines = [];

  lines.push(
    `📊 *Jefe activity — last ${feed.windowHours}h*  ·  ${feed.totalEvents} events across ${feed.activeShops} shop${feed.activeShops === 1 ? "" : "s"}`,
  );

  if (feed.totalEvents === 0) {
    lines.push("_No activity in the window._");
    return lines.join("\n");
  }

  // One-line summary of counts by type (most frequent first).
  const summary = Object.entries(feed.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${metaFor(type).emoji} ${metaFor(type).label} ${n}`)
    .join("  ·  ");
  lines.push(summary);

  if (feed.attention.length) {
    lines.push("");
    lines.push(`*Needs attention (${feed.attention.length})*`);
    for (const e of feed.attention.slice(0, 8)) {
      lines.push(
        `• ${shortTime(e.ts)}  ${metaFor(e.type).emoji} ${metaFor(e.type).label}${e.detail ? ` (${e.detail})` : ""}  ${e.shopDomain}`,
      );
    }
  }

  lines.push("");
  lines.push("*Recent*");
  for (const e of feed.events.slice(0, recentLimit)) {
    lines.push(
      `• ${shortTime(e.ts)}  ${metaFor(e.type).emoji} ${metaFor(e.type).label}${e.detail ? ` (${e.detail})` : ""}  ${e.shopDomain}`,
    );
  }
  if (feed.events.length > recentLimit) {
    lines.push(`_…and ${feed.events.length - recentLimit} more_`);
  }

  return lines.join("\n");
}
