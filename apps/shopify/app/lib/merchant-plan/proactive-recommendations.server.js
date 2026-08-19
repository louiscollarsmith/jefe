// @ts-check
// Proactive recommendations — Jefe asking the LLM for the moves worth surfacing from a
// merchant's memory WITHOUT being asked. Generation itself is the existing
// `generateMerchantPlan` (same LLM-from-memory path the reactive plan uses) run through the
// existing worker; this module owns only the DECISION of whether to generate now, enforcing
// an initial ceiling of N per merchant per day.
//
// Two enqueue paths (both respect the daily cap):
//   1. Terminal state — when the merchant completes or rejects the current recommendation,
//      enqueue the next one immediately (`maybeEnqueueProactivePlanAfterTerminalState`).
//   2. Hourly sweep — worker fallback that spreads the day's ≤5 fresh runs (`PROACTIVE_SWEEP_INTERVAL_MS`).
//
// A ceiling, not a target: silence is fine when nothing is real (docs/proactive-messages.md,
// "the floor"). Proactive runs are marked `sourceMode = "proactive"` on MerchantPlanRun, so
// the count is honest and reactive (onboarding / backfill) plan runs never eat the budget.
// The day boundary (`since`) is computed by the caller in the shop's timezone and passed in,
// keeping the budget math pure and the module testable on plain Node.

export const PROACTIVE_SOURCE_MODE = "proactive";
export const DEFAULT_PROACTIVE_DAILY_CAP = 5;
/** Hourly worker sweep — spreads the day's ≤5 fresh proactive runs. */
export const PROACTIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Pure budget check. `generatedToday` = proactive runs the merchant has already had since
 * the start of their day; `cap` = the daily ceiling.
 * @param {{ generatedToday: number; cap?: number }} input
 * @returns {{ allowed: boolean; remaining: number; used: number; cap: number; reason: string | null }}
 */
export function proactiveBudget({ generatedToday, cap = DEFAULT_PROACTIVE_DAILY_CAP }) {
  const safeCap =
    Number.isFinite(cap) && Number(cap) > 0
      ? Math.floor(Number(cap))
      : DEFAULT_PROACTIVE_DAILY_CAP;
  const used =
    Number.isFinite(generatedToday) && Number(generatedToday) > 0
      ? Math.floor(Number(generatedToday))
      : 0;
  const remaining = Math.max(0, safeCap - used);
  return {
    allowed: remaining > 0,
    remaining,
    used,
    cap: safeCap,
    reason: remaining > 0 ? null : "daily_cap_reached",
  };
}

/**
 * Count a merchant's proactive plan runs since a boundary (start of their day).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; since: Date }} input
 * @returns {Promise<number>}
 */
export async function countProactivePlanRunsSince(prisma, { merchantId, since }) {
  return prisma.merchantPlanRun.count({
    where: {
      merchantId,
      sourceMode: PROACTIVE_SOURCE_MODE,
      createdAt: { gte: since },
    },
  });
}

/**
 * Decide whether to generate a proactive recommendation for this merchant now.
 * Fail-closed: if the count read throws, do NOT generate — never over-message a merchant on
 * a broken read. `deps.count` is injectable for tests.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; since: Date; cap?: number; deps?: { count?: typeof countProactivePlanRunsSince } }} input
 * @returns {Promise<{ enqueue: boolean; generatedToday: number; remaining: number; reason: string | null }>}
 */
export async function decideProactiveGeneration(
  prisma,
  { merchantId, since, cap = DEFAULT_PROACTIVE_DAILY_CAP, deps = {} },
) {
  const count = deps.count ?? countProactivePlanRunsSince;
  let generatedToday;
  try {
    generatedToday = await count(prisma, { merchantId, since });
  } catch {
    return { enqueue: false, generatedToday: -1, remaining: 0, reason: "cap_read_failed" };
  }
  const budget = proactiveBudget({ generatedToday, cap });
  return {
    enqueue: budget.allowed,
    generatedToday: budget.used,
    remaining: budget.remaining,
    reason: budget.reason,
  };
}

/**
 * Start of the merchant's next calendar day (same dayKey convention as startOfMerchantDay).
 * @param {Date} now
 * @param {string | null} [timeZone]
 * @returns {Date}
 */
export function startOfNextMerchantDay(now, timeZone) {
  const dayStart = startOfMerchantDay(now, timeZone);
  const next = new Date(dayStart);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * When Jefe will next check for a fresh proactive recommendation. Under the daily cap the
 * worker sweeps hourly as a fallback; once capped, the next window is the merchant's next
 * day. Terminal states (completed / rejected) enqueue immediately — the hourly sweep is
 * only for merchants with nothing new to react to.
 * @param {{ now: Date; timeZone?: string | null; generatedToday: number; cap?: number }} input
 * @returns {{ kind: "hourly_check" | "daily_cap_reached"; at: Date; generatedToday: number; remaining: number; cap: number }}
 */
export function computeNextRecommendationCheck({
  now,
  timeZone,
  generatedToday,
  cap = DEFAULT_PROACTIVE_DAILY_CAP,
}) {
  const budget = proactiveBudget({ generatedToday, cap });
  if (!budget.allowed) {
    return {
      kind: "daily_cap_reached",
      at: startOfNextMerchantDay(now, timeZone),
      generatedToday: budget.used,
      remaining: budget.remaining,
      cap: budget.cap,
    };
  }
  const at = new Date(now);
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(0);
  at.setUTCHours(at.getUTCHours() + 1);
  if (at.getTime() <= now.getTime()) {
    at.setUTCHours(at.getUTCHours() + 1);
  }
  return {
    kind: "hourly_check",
    at,
    generatedToday: budget.used,
    remaining: budget.remaining,
    cap: budget.cap,
  };
}

/**
 * Loader-facing schedule for the home empty state. Returns null when the cap read fails
 * (fail-closed — no fabricated countdown).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; now: Date; timeZone?: string | null; cap?: number; deps?: { count?: typeof countProactivePlanRunsSince } }} input
 * @returns {Promise<{ kind: "hourly_check" | "daily_cap_reached"; at: string; generatedToday: number; remaining: number; cap: number; enabled: boolean } | null>}
 */
export async function getProactiveRecommendationSchedule(
  prisma,
  { merchantId, now, timeZone, cap = DEFAULT_PROACTIVE_DAILY_CAP, deps = {} },
) {
  const count = deps.count ?? countProactivePlanRunsSince;
  const since = startOfMerchantDay(now, timeZone);
  let generatedToday;
  try {
    generatedToday = await count(prisma, { merchantId, since });
  } catch {
    return null;
  }
  const check = computeNextRecommendationCheck({ now, timeZone, generatedToday, cap });
  return {
    kind: check.kind,
    at: check.at.toISOString(),
    generatedToday: check.generatedToday,
    remaining: check.remaining,
    cap: check.cap,
    enabled: process.env.ENABLE_PROACTIVE_RECOMMENDATIONS === "true",
  };
}

/**
 * Start of the merchant's current day as a UTC Date — the daily-cap window boundary. Uses the
 * shop's timezone to pick the calendar date, then midnight-UTC of that date (the codebase's
 * dayKey convention). Not the exact local midnight (no offset math), but a stable, monotonic
 * per-day boundary, which is all the cap needs. Falls back to UTC on a bad timezone.
 * @param {Date} now
 * @param {string | null} [timeZone]
 * @returns {Date}
 */
export function startOfMerchantDay(now, timeZone) {
  const tz = typeof timeZone === "string" && timeZone ? timeZone : "UTC";
  const format = (/** @type {string} */ zone) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  let ymd;
  try {
    ymd = format(tz);
  } catch {
    ymd = format("UTC");
  }
  return new Date(`${ymd}T00:00:00Z`);
}

/**
 * Proactive generation for ONE merchant: if under the daily cap, enqueue a plan run marked
 * `sourceMode: "proactive"`. Generation reuses the existing plan pipeline (deduped by belief
 * snapshot), so it only truly regenerates when the merchant's situation changed — an
 * unchanged snapshot comes back "reused" and does NOT consume the cap (correct silence).
 * `ensureQueued` is injected (the worker passes `ensureMerchantPlanQueued`) so this module
 * stays dependency-light and testable on plain Node.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now: Date; timeZone?: string; cap?: number; ensureQueued: (prisma: any, input: any) => Promise<{ status: string }>; deps?: { count?: typeof countProactivePlanRunsSince } }} input
 * @returns {Promise<{ enqueued: boolean; status: string; remaining: number; reason: string | null }>}
 */
export async function maybeEnqueueProactivePlan(
  prisma,
  { merchantId, shopId, now, timeZone, cap = DEFAULT_PROACTIVE_DAILY_CAP, ensureQueued, deps = {} },
) {
  const since = startOfMerchantDay(now, timeZone);
  const decision = await decideProactiveGeneration(prisma, { merchantId, since, cap, deps });
  if (!decision.enqueue) {
    return { enqueued: false, status: "skipped", remaining: decision.remaining, reason: decision.reason };
  }
  const result = await ensureQueued(prisma, { merchantId, shopId, sourceMode: PROACTIVE_SOURCE_MODE });
  const status = result?.status ?? "unknown";
  // "queued" = a fresh generation was enqueued (new belief snapshot). "reused"/other = nothing
  // new to say; the snapshot was already generated, so no proactive run row was created and the
  // cap was not consumed.
  return { enqueued: status === "queued", status, remaining: decision.remaining, reason: decision.reason };
}

/**
 * Whether the merchant still has a proposed move waiting for review.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<boolean>}
 */
export async function merchantHasProposedAction(prisma, { merchantId, shopId }) {
  if (!prisma?.merchantAction?.count) return false;
  const count = await prisma.merchantAction.count({
    where: { merchantId, shopId, status: "proposed" },
  });
  return count > 0;
}

/**
 * Enqueue the next proactive recommendation once the previous one reached a terminal state
 * (completed / rejected / declined). Skips when proactive is disabled, the daily cap is
 * reached, or another proposed move is already waiting. The hourly worker sweep remains
 * as a fallback when nothing terminal happens.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date; timeZone?: string | null; cap?: number; ensureQueued: (prisma: any, input: any) => Promise<{ status: string }>; deps?: { count?: typeof countProactivePlanRunsSince; hasProposed?: typeof merchantHasProposedAction } }} input
 * @returns {Promise<{ enqueued: boolean; status: string; remaining: number; reason: string | null }>}
 */
export async function maybeEnqueueProactivePlanAfterTerminalState(
  prisma,
  { merchantId, shopId, now = new Date(), timeZone, cap = DEFAULT_PROACTIVE_DAILY_CAP, ensureQueued, deps = {} },
) {
  if (process.env.ENABLE_PROACTIVE_RECOMMENDATIONS !== "true") {
    return { enqueued: false, status: "skipped", remaining: 0, reason: "disabled" };
  }
  const hasProposed = deps.hasProposed ?? merchantHasProposedAction;
  try {
    if (await hasProposed(prisma, { merchantId, shopId })) {
      return { enqueued: false, status: "skipped", remaining: 0, reason: "proposed_exists" };
    }
  } catch {
    return { enqueued: false, status: "skipped", remaining: 0, reason: "proposed_read_failed" };
  }
  return maybeEnqueueProactivePlan(prisma, {
    merchantId,
    shopId,
    now,
    timeZone: timeZone ?? undefined,
    cap,
    ensureQueued,
    deps,
  });
}
