// @ts-check
// Merchant-triggered proposal generation from the home screen. The merchant clicks
// "Generate a proposal" / "Generate another proposal"; generation runs through the
// canonical agentic recommendation pipeline. This
// module owns eligibility, the per-merchant-local-day ceiling, and concurrency safety —
// there is no background scheduler.

import { PLAN_RUN_STATUS } from "./constants.server.js";
import { merchantHasProposedAction } from "./proposal-creation-invariant.server.js";

export { merchantHasProposedAction };

export const HOME_PROPOSAL_SOURCE_MODE = "home";
export const DEFAULT_HOME_PROPOSAL_DAILY_CAP = 5;

/** A run that has not made progress for this long is considered stuck. Based on the worker's
 *  own job timeout (5 minutes) plus a generous LLM-latency headroom. */
export const HOME_STUCK_RUN_THRESHOLD_MS = 15 * 60 * 1000;

const ACTIVE_HOME_RUN_STATUSES = [PLAN_RUN_STATUS.queued, PLAN_RUN_STATUS.running];

/**
 * Pure budget check. `generatedToday` = successful home-triggered generations since
 * the start of the merchant's day; `cap` = the daily ceiling.
 * @param {{ generatedToday: number; cap?: number }} input
 * @returns {{ allowed: boolean; remaining: number; used: number; cap: number; reason: string | null }}
 */
export function proposalGenerationBudget({
  generatedToday,
  cap = DEFAULT_HOME_PROPOSAL_DAILY_CAP,
}) {
  const safeCap =
    Number.isFinite(cap) && Number(cap) > 0
      ? Math.floor(Number(cap))
      : DEFAULT_HOME_PROPOSAL_DAILY_CAP;
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
 * Start of the merchant's current day as a UTC Date — the daily-cap window boundary.
 * Uses the shop's timezone to pick the calendar date, then midnight-UTC of that date.
 * @param {Date} now
 * @param {string | null | undefined} [timeZone]
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
 * Count successful home-triggered plan runs since a boundary.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; since: Date }} input
 * @returns {Promise<number>}
 */
export async function countHomeProposalGenerationsSince(prisma, { merchantId, since }) {
  return prisma.merchantPlanRun.count({
    where: {
      merchantId,
      sourceMode: HOME_PROPOSAL_SOURCE_MODE,
      status: PLAN_RUN_STATUS.completed,
      completedAt: { gte: since },
    },
  });
}

/**
 * Whether a home-triggered generation is currently queued or running.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<boolean>}
 */
export async function isHomeProposalGenerationInFlight(prisma, { merchantId, shopId }) {
  const count = await prisma.merchantPlanRun.count({
    where: {
      merchantId,
      shopId,
      sourceMode: HOME_PROPOSAL_SOURCE_MODE,
      status: { in: ACTIVE_HOME_RUN_STATUSES },
    },
  });
  return count > 0;
}

/** Terminal run statuses that end generation without a proposed action. */
const TERMINAL_NON_PROPOSAL_STATUSES = [
  "no_actionable_opportunity",
  PLAN_RUN_STATUS.failed,
  PLAN_RUN_STATUS.insufficientData,
  PLAN_RUN_STATUS.modelDisabled,
];

/**
 * Loader-facing state for the Reading your store card.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now: Date; timeZone?: string | null; cap?: number; stuckRunThresholdMs?: number; deps?: { count?: typeof countHomeProposalGenerationsSince; hasProposed?: typeof merchantHasProposedAction; inFlight?: typeof isHomeProposalGenerationInFlight } }} input
 * @returns {Promise<{ canGenerate: boolean; reason: string | null; generatedToday: number; remaining: number; cap: number; isGenerating: boolean; hasPriorProposal: boolean; terminalStatus: string | null } | null>}
 */
export async function getHomeProposalGenerationState(
  prisma,
  {
    merchantId,
    shopId,
    now,
    timeZone,
    cap = DEFAULT_HOME_PROPOSAL_DAILY_CAP,
    stuckRunThresholdMs = HOME_STUCK_RUN_THRESHOLD_MS,
    deps = {},
  },
) {
  const count = deps.count ?? countHomeProposalGenerationsSince;
  const hasProposed = deps.hasProposed ?? merchantHasProposedAction;
  const inFlight = deps.inFlight ?? isHomeProposalGenerationInFlight;
  const since = startOfMerchantDay(now, timeZone);

  let generatedToday;
  let proposedExists;
  let generating;
  let priorCount;
  try {
    [generatedToday, proposedExists, generating, priorCount] = await Promise.all([
      count(prisma, { merchantId, since }),
      hasProposed(prisma, { merchantId, shopId }),
      inFlight(prisma, { merchantId, shopId }),
      prisma.merchantPlanRun.count({
        where: {
          merchantId,
          sourceMode: HOME_PROPOSAL_SOURCE_MODE,
          status: PLAN_RUN_STATUS.completed,
        },
      }),
    ]);
  } catch {
    return null;
  }

  const budget = proposalGenerationBudget({ generatedToday, cap });
  let reason = budget.reason;
  let canGenerate = budget.allowed;

  if (proposedExists) {
    canGenerate = false;
    reason = "proposed_exists";
  } else if (generating) {
    canGenerate = false;
    reason = "generating";
  }

  // Stuck-run detection: a run that has been queued or running beyond the threshold
  // without completing is assumed dead (worker crash, deploy, etc.). Treat it as failed
  // so the merchant can retry rather than waiting indefinitely. The actual DB cleanup is
  // handled by recoverStaleRunningBackfillJobs in the worker on the next tick.
  let terminalStatus = null;
  if (generating) {
    try {
      const activeRun = await prisma.merchantPlanRun.findFirst({
        where: {
          merchantId,
          shopId,
          sourceMode: HOME_PROPOSAL_SOURCE_MODE,
          status: { in: ACTIVE_HOME_RUN_STATUSES },
        },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, createdAt: true },
      });
      if (activeRun) {
        const lastActivity = activeRun.updatedAt ?? activeRun.createdAt;
        const elapsedMs = now.getTime() - new Date(lastActivity).getTime();
        if (elapsedMs > stuckRunThresholdMs) {
          generating = false;
          terminalStatus = PLAN_RUN_STATUS.failed;
          canGenerate = true;
          reason = null;
        }
      }
    } catch {
      // Stuck detection is best-effort; do not block eligibility on a read error.
    }
  }

  // When idle (no proposed action, not generating, under the cap), surface the
  // most recent run's terminal status so the UI can explain why the last attempt
  // produced no proposal instead of silently resetting to the default copy.
  if (canGenerate && !generating && !proposedExists && !terminalStatus) {
    try {
      const lastRun = await prisma.merchantPlanRun.findFirst({
        where: { merchantId, shopId, sourceMode: HOME_PROPOSAL_SOURCE_MODE },
        orderBy: { updatedAt: "desc" },
        select: { status: true },
      });
      if (lastRun && TERMINAL_NON_PROPOSAL_STATUSES.includes(lastRun.status)) {
        terminalStatus = lastRun.status;
      }
    } catch {
      // Terminal status is best-effort; do not block generation eligibility on a read error.
    }
  }

  return {
    canGenerate,
    reason,
    generatedToday: budget.used,
    remaining: budget.remaining,
    cap: budget.cap,
    isGenerating: generating,
    hasPriorProposal: priorCount > 0 || budget.used > 0,
    terminalStatus,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 * @param {(tx: any) => Promise<T>} callback
 * @returns {Promise<T>}
 * @template T
 */
async function withHomeProposalGenerationLock(prisma, input, callback) {
  if (typeof prisma.$transaction !== "function") return callback(prisma);
  return prisma.$transaction(
    async (/** @type {any} */ tx) => {
      if (typeof tx.$queryRawUnsafe === "function") {
        const lockKey = [input.merchantId, input.shopId, "home_proposal_generation"].join(":");
        await tx.$queryRawUnsafe(
          "SELECT 1::integer AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))",
          lockKey,
        );
      }
      return callback(tx);
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/**
 * Merchant clicked Generate — enqueue a recommendation run through the canonical pipeline.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date; timeZone?: string | null; cap?: number; ensureQueued?: (prisma: any, input: any) => Promise<{ status: string }>; deps?: { count?: typeof countHomeProposalGenerationsSince; hasProposed?: typeof merchantHasProposedAction; inFlight?: typeof isHomeProposalGenerationInFlight } }} input
 * @returns {Promise<{ ok: boolean; status?: string; reason?: string | null; remaining?: number }>}
 */
export async function requestHomeProposalGeneration(
  prisma,
  {
    merchantId,
    shopId,
    now = new Date(),
    timeZone,
    cap = DEFAULT_HOME_PROPOSAL_DAILY_CAP,
    ensureQueued,
    deps = {},
  },
) {
  const count = deps.count ?? countHomeProposalGenerationsSince;
  const hasProposed = deps.hasProposed ?? merchantHasProposedAction;
  const inFlight = deps.inFlight ?? isHomeProposalGenerationInFlight;
  const queuePlan =
    ensureQueued ??
    (async (client, queueInput) => {
      const { ensureAgenticRecommendationQueued } = await import("../shopify/agentic-runtime/recommendation-service.server.js");
      return ensureAgenticRecommendationQueued(client, queueInput);
    });

  return withHomeProposalGenerationLock(prisma, { merchantId, shopId }, async (tx) => {
    const since = startOfMerchantDay(now, timeZone);

    let generatedToday;
    try {
      generatedToday = await count(tx, { merchantId, since });
    } catch {
      return { ok: false, reason: "cap_read_failed" };
    }

    const budget = proposalGenerationBudget({ generatedToday, cap });
    if (!budget.allowed) {
      return { ok: false, reason: "daily_cap_reached", remaining: budget.remaining };
    }

    try {
      if (await hasProposed(tx, { merchantId, shopId })) {
        return { ok: false, reason: "proposed_exists" };
      }
      if (await inFlight(tx, { merchantId, shopId })) {
        return { ok: false, reason: "generating" };
      }
    } catch {
      return { ok: false, reason: "eligibility_read_failed" };
    }

    const result = await queuePlan(tx, {
      merchantId,
      shopId,
      sourceMode: HOME_PROPOSAL_SOURCE_MODE,
      resetAttempts: true,
    });
    const status = result?.status ?? "unknown";
    return {
      ok: status === "queued",
      status,
      reason: status === "queued" ? null : status === "reused" ? "nothing_new" : status,
      remaining: budget.remaining,
    };
  });
}
