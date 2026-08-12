// @ts-check

// Store-grounded Horizon for the 13a Daily Home.
//
// The Horizon section answers "what's coming that you can still do something
// about." Historically it rendered ONLY a deterministic seasonal calendar
// (back-to-school, BFCM, …). This service adds the store-grounded half the 13a
// design calls for, computed from REAL merchant data — never fabricated:
//
//   near      → concrete, dated near-term items:
//                 • stock run-out dates from the low-cover belief
//                   (available units ÷ recent daily sell-rate)
//                 • a refund projection from the trailing-30d refund count
//                 • the seasonal timeline, merged in and sorted by date
//   watching  → "Watching, not acting": things Jefe can see but won't act on
//               yet, each with an honest revisit date:
//                 • at-risk stock that lands just outside the two-week window
//                 • a refund signal too thin to call a trend
//
// Everything is derived from persisted deterministic facts (the low-cover
// belief, computed by shopify-derivations) or a single scoped count. Numbers
// are read defensively and, if a read fails, the section degrades to the
// seasonal timeline only — it never guesses a stockout or a refund.

import { logger as baseLogger } from "../observability/logger.server.js";
import { getBelief } from "./service.server.js";

const log = baseLogger.child({ component: "horizon" });

/** @typedef {import("../../components/app-home/sections").HorizonItem} HorizonItem */
/** @typedef {import("../../components/app-home/sections").HorizonWatch} HorizonWatch */
/** @typedef {{ productId: string; title: string; available: number; dailyVelocity: number; daysOfCover: number }} LowCoverItem */
/** @typedef {{ key: string; title: string; date: Date; note: string; dateLabel: string }} SeasonalEntry */

// The belief computed by shopify-derivations (lowCoverProducts): selling
// products under STOCKOUT_RISK_DAYS (21) of stock cover, ranked by soonest
// run-out. Reading the persisted belief keeps this on the Daily Home's
// read-only path (no re-derivation on render).
const LOW_COVER_KEY = "inventory.low_cover_products.trailing_30d";

// "Near" = the next two weeks, matching the section's "Next two weeks" header.
export const HORIZON_NEAR_DAYS = 14;
const REFUND_WINDOW_DAYS = 30;
const MIN_REFUNDS_TO_PROJECT = 2;
const MAX_NEAR_STOCKOUTS = 5;
const MAX_WATCH_STOCKOUTS = 5;
const REVISIT_DAYS = 14;

/**
 * Read-only: fetch the real signals, then compute the horizon. Resilient — if a
 * read throws, it falls back to the deterministic seasonal timeline only so the
 * Daily Home render never breaks on a non-critical section.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 * @returns {Promise<{ near: HorizonItem[]; watching: HorizonWatch[] }>}
 */
export async function getLatestHorizon(
  prisma,
  { merchantId, shopId, now = new Date() },
) {
  const refundSince = addDays(now, -REFUND_WINDOW_DAYS);
  try {
    const [lowCoverBelief, recentRefundCount] = await Promise.all([
      getBelief(prisma, { merchantId, key: LOW_COVER_KEY }),
      prisma.refund.count({
        where: { merchantId, shopId, processedAt: { gte: refundSince } },
      }),
    ]);
    return computeHorizon({
      now,
      lowCoverItems: extractLowCoverItems(lowCoverBelief ? lowCoverBelief.value : null),
      recentRefundCount: Number.isFinite(recentRefundCount) ? recentRefundCount : 0,
    });
  } catch (error) {
    log.warn("horizon_read_failed", {
      merchantId,
      beliefKey: LOW_COVER_KEY,
      error: error instanceof Error ? error.message : String(error),
    });
    return computeHorizon({ now, lowCoverItems: [], recentRefundCount: 0 });
  }
}

/**
 * Pure horizon assembly from already-fetched real signals. No I/O and no
 * ambient clock — fully deterministic given its inputs, so it's straightforward
 * to unit-test.
 *
 * @param {{ now: Date; lowCoverItems: LowCoverItem[]; recentRefundCount: number }} input
 * @returns {{ near: HorizonItem[]; watching: HorizonWatch[] }}
 */
export function computeHorizon({ now, lowCoverItems, recentRefundCount }) {
  /** @type {Array<{ at: Date; item: HorizonItem }>} */
  const nearRaw = [];
  /** @type {HorizonWatch[]} */
  const watching = [];

  // ── Stock runway (from the low-cover belief) ─────────────────────────────
  const byCover = [...lowCoverItems].sort((a, b) => a.daysOfCover - b.daysOfCover);

  const nearStockouts = byCover
    .filter((it) => it.daysOfCover <= HORIZON_NEAR_DAYS)
    .slice(0, MAX_NEAR_STOCKOUTS);
  for (const it of nearStockouts) {
    const runOut = addDays(now, clampDays(it.daysOfCover));
    const rate = formatRate(it.dailyVelocity);
    nearRaw.push({
      at: runOut,
      item: {
        id: `stockout-${it.productId}`,
        date: dayLabel(runOut),
        title: `${it.title} runs out soon`,
        body:
          it.available > 0
            ? `About ${Math.round(it.available)} left, selling ~${rate}/day — likely out around ${dayLabel(runOut)}.`
            : `Almost gone, selling ~${rate}/day — likely out around ${dayLabel(runOut)}.`,
        action: null,
      },
    });
  }

  // Stock that's at risk but lands just outside the two-week window: Jefe can
  // see it, but won't act yet. Honest revisit date = when it enters the window.
  const laterStockouts = byCover
    .filter((it) => it.daysOfCover > HORIZON_NEAR_DAYS)
    .slice(0, MAX_WATCH_STOCKOUTS);
  for (const it of laterStockouts) {
    const days = clampDays(it.daysOfCover);
    const revisit = addDays(now, Math.max(1, days - HORIZON_NEAR_DAYS));
    watching.push({
      id: `stockwatch-${it.productId}`,
      title: `${it.title} — about ${days} days of stock left`,
      reason: `Selling ~${formatRate(it.dailyVelocity)}/day. Jefe will flag it for action once it's inside two weeks — revisit ~${dayLabel(revisit)}.`,
    });
  }

  // ── Refund pattern (from the trailing-30d refund count) ──────────────────
  if (recentRefundCount >= MIN_REFUNDS_TO_PROJECT) {
    const projected = Math.max(
      1,
      Math.round((recentRefundCount * HORIZON_NEAR_DAYS) / REFUND_WINDOW_DAYS),
    );
    const by = addDays(now, HORIZON_NEAR_DAYS);
    nearRaw.push({
      at: by,
      item: {
        id: "refund-projection",
        date: dayLabel(by),
        title: projected === 1 ? "Another refund likely" : `About ${projected} more refunds likely`,
        body: `${recentRefundCount} refunds in the last 30 days. If the pattern holds, expect around ${projected} more by ${dayLabel(by)}.`,
        action: null,
      },
    });
  } else if (recentRefundCount === 1) {
    watching.push({
      id: "refund-watch",
      title: "Refund pattern",
      reason: `One refund in the last 30 days — too few to call a trend yet. Revisit ~${dayLabel(addDays(now, REVISIT_DAYS))}.`,
    });
  }

  // ── Seasonal timeline (kept) — merged in and sorted with the rest ────────
  for (const entry of buildSeasonalHorizon(now)) {
    nearRaw.push({
      at: entry.date,
      item: { id: entry.key, date: entry.dateLabel, title: entry.title, body: entry.note, action: null },
    });
  }

  nearRaw.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { near: nearRaw.map((r) => r.item), watching };
}

/** @typedef {{ id: string; kind: "stockout" | "refund"; text: string }} HorizonHeadsUp */

/**
 * Read-only: the near-term Horizon signals worded as short, proactive chat
 * heads-ups — for surfacing IN the conversation (Shape B), not a home section
 * (founder call, 2026-08-12). Resilient: returns [] on any read error, never
 * throws into the caller's loader. The chat surface owns HOW/WHEN a heads-up is
 * injected; this owns only WHAT it says.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 * @returns {Promise<HorizonHeadsUp[]>}
 */
export async function getHorizonHeadsUps(
  prisma,
  { merchantId, shopId, now = new Date() },
) {
  const refundSince = addDays(now, -REFUND_WINDOW_DAYS);
  try {
    const [lowCoverBelief, recentRefundCount] = await Promise.all([
      getBelief(prisma, { merchantId, key: LOW_COVER_KEY }),
      prisma.refund.count({
        where: { merchantId, shopId, processedAt: { gte: refundSince } },
      }),
    ]);
    return buildHorizonHeadsUps({
      now,
      lowCoverItems: extractLowCoverItems(lowCoverBelief ? lowCoverBelief.value : null),
      recentRefundCount: Number.isFinite(recentRefundCount) ? recentRefundCount : 0,
    });
  } catch (error) {
    log.warn("horizon_headsups_read_failed", {
      merchantId,
      beliefKey: LOW_COVER_KEY,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Pure: turn the real near-term signals into short, honest chat heads-ups.
 * Voice is "noticing, not alerting" (chat 11) — plain, dated, no urgency
 * theatre, and honest about what Jefe can't do yet (it never offers a button it
 * can't back — reordering isn't a live action). Ordered most-actionable first
 * (a run-out before a refund trend). Never fabricates: a heads-up only appears
 * when the underlying number supports it.
 *
 * @param {{ now: Date; lowCoverItems: LowCoverItem[]; recentRefundCount: number }} input
 * @returns {HorizonHeadsUp[]}
 */
export function buildHorizonHeadsUps({ now, lowCoverItems, recentRefundCount }) {
  /** @type {HorizonHeadsUp[]} */
  const headsUps = [];

  // Soonest genuine run-out inside the two-week window — straight from the
  // velocity-backed low-cover items, so never a seasonal date.
  const soonestRunOut = [...lowCoverItems]
    .sort((a, b) => a.daysOfCover - b.daysOfCover)
    .find((it) => it.daysOfCover <= HORIZON_NEAR_DAYS);
  if (soonestRunOut) {
    const runOut = addDays(now, clampDays(soonestRunOut.daysOfCover));
    const left =
      soonestRunOut.available > 0
        ? `about ${Math.round(soonestRunOut.available)} left`
        : "almost none left";
    headsUps.push({
      id: `headsup-stockout-${soonestRunOut.productId}`,
      kind: "stockout",
      text: `Heads up — at how fast ${soonestRunOut.title} is selling, it looks like you'll run out around ${dayLabel(runOut)} (${left}). I can't reorder for you yet, but tell me your supplier's lead time and I'll work out when you'd need to order.`,
    });
  }

  // Refund trend — only when there's a real recent pattern to project from.
  if (recentRefundCount >= MIN_REFUNDS_TO_PROJECT) {
    const projected = Math.max(
      1,
      Math.round((recentRefundCount * HORIZON_NEAR_DAYS) / REFUND_WINDOW_DAYS),
    );
    const by = addDays(now, HORIZON_NEAR_DAYS);
    headsUps.push({
      id: "headsup-refund-projection",
      kind: "refund",
      text: `Heads up — you've had ${recentRefundCount} refunds in the last 30 days. If that keeps up, that's about ${projected} more by ${dayLabel(by)}. Want me to look into what's driving them?`,
    });
  }

  return headsUps;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Defensive extraction of low-cover items from a persisted belief value (it's
 * JSON, so untrusted at runtime). Anything malformed is skipped, never coerced
 * to a fabricated number — a missing velocity means "unknown", not zero.
 *
 * @param {unknown} value
 * @returns {LowCoverItem[]}
 */
function extractLowCoverItems(value) {
  if (!value || typeof value !== "object") return [];
  const items = /** @type {{ items?: unknown }} */ (value).items;
  if (!Array.isArray(items)) return [];
  /** @type {LowCoverItem[]} */
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (raw);
    const productId = typeof r.productId === "string" ? r.productId : null;
    const title = typeof r.title === "string" ? r.title.trim() : null;
    const available = toFiniteNumber(r.available);
    const dailyVelocity = toFiniteNumber(r.dailyVelocity);
    const daysOfCover = toFiniteNumber(r.daysOfCover);
    if (!productId || !title) continue;
    if (available == null || dailyVelocity == null || daysOfCover == null) continue;
    if (dailyVelocity <= 0 || daysOfCover < 0) continue;
    out.push({ productId, title, available, dailyVelocity, daysOfCover });
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number} daysOfCover
 * @returns {number}
 */
function clampDays(daysOfCover) {
  return Math.max(0, Math.round(daysOfCover));
}

/**
 * @param {number} rate
 * @returns {string}
 */
function formatRate(rate) {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}

/**
 * @param {Date} d
 * @param {number} days
 * @returns {Date}
 */
function addDays(d, days) {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + days);
  return r;
}

/**
 * @param {Date} d
 * @returns {string}
 */
function dayLabel(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} weekday
 * @param {number} n
 * @returns {Date}
 */
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + shift + (n - 1) * 7);
}

/**
 * @param {number} year
 * @returns {Date}
 */
function blackFridayFor(year) {
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
  return new Date(year, 10, thanksgiving.getDate() + 1);
}

/**
 * @param {Date} now
 * @param {(year: number) => Date} build
 * @returns {Date}
 */
function rollForward(now, build) {
  const y = now.getFullYear();
  const candidate = build(y);
  return candidate.getTime() < now.getTime() ? build(y + 1) : candidate;
}

/**
 * Deterministic seasonal calendar. Dates are computed from `now`, never
 * hardcoded — a wrong seasonal date destroys the credibility this surface
 * exists to build. (Moved verbatim from daily-home.tsx so all Horizon logic
 * lives — and is tested — in one place.)
 *
 * @param {Date} now
 * @returns {SeasonalEntry[]}
 */
export function buildSeasonalHorizon(now) {
  /** @type {Array<{ key: string; title: string; date: Date; note: string }>} */
  const raw = [
    { key: "back-to-school", title: "Back-to-school demand", date: rollForward(now, (y) => new Date(y, 8, 1)), note: "Routine-building season for skincare. Stock and bundle decisions want to be set about a month out." },
    { key: "bfcm", title: "Black Friday / Cyber weekend", date: rollForward(now, blackFridayFor), note: "Your biggest weekend. Supplier lead times run roughly nine weeks, so the real decisions land in early autumn — not the week before." },
    { key: "christmas", title: "Christmas last-order cut-off", date: rollForward(now, (y) => new Date(y, 11, 20)), note: "The last date customers can order and still get it in time. Carrier cut-offs and stock buffers need setting well ahead." },
    { key: "returns", title: "January returns wave", date: rollForward(now, (y) => new Date(y, 0, 6)), note: "The post-holiday returns spike. Worth deciding your returns and win-back approach before it arrives." },
  ];
  return raw
    .map((e) => ({ key: e.key, title: e.title, date: e.date, note: e.note, dateLabel: dayLabel(e.date) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
