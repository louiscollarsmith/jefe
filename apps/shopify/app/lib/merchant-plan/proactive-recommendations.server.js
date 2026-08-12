// @ts-check
// Proactive recommendations — Jefe asking the LLM, on a daily cadence, for the moves worth
// surfacing from a merchant's memory WITHOUT being asked. Generation itself is the existing
// `generateMerchantPlan` (same LLM-from-memory path the reactive plan uses) run through the
// existing worker; this module owns only the DECISION of whether to generate now, enforcing
// an initial ceiling of N per merchant per day.
//
// A ceiling, not a target: silence is fine when nothing is real (docs/proactive-messages.md,
// "the floor"). Proactive runs are marked `sourceMode = "proactive"` on MerchantPlanRun, so
// the count is honest and reactive (onboarding / backfill) plan runs never eat the budget.
// The day boundary (`since`) is computed by the caller in the shop's timezone and passed in,
// keeping the budget math pure and the module testable on plain Node.

export const PROACTIVE_SOURCE_MODE = "proactive";
export const DEFAULT_PROACTIVE_DAILY_CAP = 5;

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
 * Start of the merchant's current day as a UTC Date — the daily-cap window boundary. Uses the
 * shop's timezone to pick the calendar date, then midnight-UTC of that date (the codebase's
 * dayKey convention). Not the exact local midnight (no offset math), but a stable, monotonic
 * per-day boundary, which is all the cap needs. Falls back to UTC on a bad timezone.
 * @param {Date} now
 * @param {string} [timeZone]
 * @returns {Date}
 */
export function startOfMerchantDay(now, timeZone) {
  const tz = typeof timeZone === "string" && timeZone ? timeZone : "UTC";
  const format = (zone) =>
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
