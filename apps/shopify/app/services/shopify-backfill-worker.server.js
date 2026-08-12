// @ts-check

import { PrismaClient } from "@prisma/client";
import { runShopifyBackfill } from "../lib/ingestion/shopify/backfill.server.js";
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server.js";
import { loadFreshOfflineToken } from "../lib/shopify/offline-token.server.js";
import {
  buildOrdersBackfillQueryFilter,
  CUSTOMERS_COUNT_QUERY,
  ORDERS_COUNT_QUERY,
  PRODUCT_VARIANTS_COUNT_QUERY,
} from "../lib/shopify/queries.server.js";
import {
  DEFAULT_BACKFILL_DAYS,
  BOOTSTRAP_BACKFILL_DOMAIN,
  BOOTSTRAP_ALTERNATIVE_JOB_TYPE,
  enqueueBackfillJob,
  ensureRecommendationReviewQueued,
  FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS,
  hasReadAllOrders,
  INITIAL_COMMERCE_BACKFILL_DOMAINS,
  splitScopes,
  upsertBackfillStatus,
  MERCHANT_BOOTSTRAP_JOB_TYPE,
  RECOMMENDATION_REVIEW_JOB_TYPE,
} from "./shopify-backfill-status.server.js";
import {
  MEMORY_BACKFILL_DOMAIN,
  MEMORY_REFRESH_JOB_TYPE,
} from "../lib/merchant-memory/constants.server.js";
import { rebuildMerchantMemory } from "../lib/merchant-memory/service.server.js";
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server.js";
import {
  ensureMerchantInsightsQueued,
  generateMerchantInsights,
  markMerchantInsightsJobFailed,
} from "../lib/merchant-insights/service.server.js";
import { MERCHANT_INSIGHTS_JOB_TYPE } from "../lib/merchant-insights/constants.server.js";
import {
  generateMerchantGoals,
  markMerchantGoalsJobFailed,
} from "../lib/merchant-goals/service.server.js";
import { MERCHANT_GOALS_JOB_TYPE } from "../lib/merchant-goals/constants.server.js";
import {
  generateMerchantPlan,
  markMerchantPlanJobFailed,
} from "../lib/merchant-plan/service.server.js";
import { MERCHANT_PLAN_JOB_TYPE } from "../lib/merchant-plan/constants.server.js";
import { logger as baseLogger } from "../lib/observability/logger.server.js";
import {
  newCorrelationId,
  runWithContext,
} from "../lib/observability/context.server.js";
import { track, trackOnce } from "./analytics/event-log.server.js";
import { generateBootstrapAlternative, runMerchantMemoryBootstrap } from "../lib/onboarding/bootstrap.server.js";
import { reviewDueRecommendations } from "../lib/onboarding/recommendation-review.server.js";
import { reconcileBootstrapRecommendationsAfterFullRefresh } from "../lib/onboarding/reconciliation.server.js";
import { runActivityDigest } from "./analytics/digest.server.js";
import { measureAndRecordClearanceOutcomes } from "../lib/actions/clearance-outcome.server.js";
import { maybePruneOldEvents } from "./analytics/retention.server.js";
import { maybePostChangelog } from "./changelog/changelog-watcher.server.js";
import { maybeSendWinBackCampaign } from "../lib/email/winback-campaign.server.js";
import { maybeSendMorningBriefs } from "../lib/notifications/morning-brief-sender.server.js";
import { maybeAlertWebhookHealth } from "../lib/observability/webhook-health.server.js";
import { maybeAlertInboundEmailHealth } from "../lib/email/inbound/health.server.js";
import { shouldPageOnWorkerError } from "./deployment-health.server.js";
import { recordWorkerTick } from "../lib/observability/heartbeat.server.js";
import {
  EPISODE_BACKFILL_JOB_TYPE,
  EPISODE_PROCESS_JOB_TYPE,
  enqueueCoalescingMemoryJob,
} from "../lib/merchant-memory/episodic-memory.server.js";
import {
  backfillMerchantEpisodes,
  processMerchantEpisodeBatch,
} from "../lib/merchant-memory/episode-processor.server.js";

const LOOP_INTERVAL_MS = 15_000;
const INITIAL_LOOP_DELAY_MS = 5_000;
const MAX_READY_JOBS_PER_TICK = 10;
const STALE_RUNNING_JOB_TIMEOUT_MS = 15 * 60_000;
const DELTA_SYNC_OVERLAP_HOURS = 24;

/**
 * Completed job types that are worth surfacing as an activity event (the panel /
 * digest feed). High-volume/internal steps (e.g. shop_backfill_start) are
 * intentionally omitted to keep the feed signal-heavy.
 * @type {Record<string, { type: string; topic: string; label: string }>}
 */
const JOB_SUCCESS_EVENT = {
  [MEMORY_REFRESH_JOB_TYPE]: {
    type: "memory_rebuilt",
    topic: "memory",
    label: "Memory rebuilt",
  },
  [MERCHANT_INSIGHTS_JOB_TYPE]: {
    type: "insights_generated",
    topic: "generation",
    label: "Insights generated",
  },
  [MERCHANT_GOALS_JOB_TYPE]: {
    type: "goals_generated",
    topic: "generation",
    label: "Goals generated",
  },
  [MERCHANT_PLAN_JOB_TYPE]: {
    type: "plan_generated",
    topic: "generation",
    label: "Plan generated",
  },
  backfill_finalize: {
    type: "backfill_completed",
    topic: "onboarding",
    label: "Evidence backfill completed",
  },
};

/**
 * Record a successful job as an activity event. Fire-and-forget; never blocks or
 * breaks the worker (track() is self-catching).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").BackfillJob & { shop: import("@prisma/client").Shop }} job
 */
function trackJobSuccess(prisma, job) {
  const event = JOB_SUCCESS_EVENT[job.jobType];
  if (!event) return;
  void track(prisma, {
    type: event.type,
    topic: event.topic,
    merchantId: job.merchantId,
    shopId: job.shopId,
    shopDomain: job.shop.shopDomain,
    summary: `${event.label} for ${job.shop.shopDomain}`,
    properties: { jobType: job.jobType },
  });
}

/**
 * Record a permanently-failed job as an activity event (surfaces under "needs
 * attention"). Fire-and-forget.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").BackfillJob & { shop: import("@prisma/client").Shop }} job
 * @param {string} message
 */
function trackJobFailure(prisma, job, message) {
  void track(prisma, {
    type: "job_failed",
    topic: "reliability",
    merchantId: job.merchantId,
    shopId: job.shopId,
    shopDomain: job.shop.shopDomain,
    summary: `${job.jobType} failed for ${job.shop.shopDomain}`,
    properties: { jobType: job.jobType, error: message.slice(0, 200) },
  });
}

let loopStarted = false;
let generalLoopRunning = false;
let bootstrapLoopRunning = false;
/** Consecutive failed ticks — a single failure WARNs, a sustained streak pages. */
let loopFailureStreak = 0;
/** @type {PrismaClient[]} */
let loopPrisma = [];
/** UTC day (YYYY-MM-DD) the daily activity digest was last posted. */
let lastDigestDay = /** @type {string | null} */ (null);
const DIGEST_HOUR_UTC = 8;

let lastOutcomeMeasureDay = /** @type {string | null} */ (null);
const OUTCOME_MEASURE_HOUR_UTC = 6;

/**
 * Post the daily activity digest to Slack once per UTC day, on the first tick at
 * or after DIGEST_HOUR_UTC. In-memory guard (a worker restart may re-post once;
 * a duplicate digest is harmless). No-op without a webhook. Never throws
 * (runActivityDigest is self-catching).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {Pick<Console, "info" | "warn" | "error">} logger
 */
async function maybePostDailyDigest(prisma, logger) {
  // OFF by default: the panel (admin.mynamejefe.com) is the activity feed;
  // Slack stays for alerts only. Opt in with ENABLE_DAILY_DIGEST=true — but note
  // the once-per-day guard below is in-memory, so re-enabling needs a durable
  // (DB-backed) guard first or it re-posts on every deploy/restart.
  if (process.env.ENABLE_DAILY_DIGEST !== "true") return;
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  if (lastDigestDay === dayKey || now.getUTCHours() < DIGEST_HOUR_UTC) return;
  lastDigestDay = dayKey;
  const webhookUrl =
    process.env.ACTIVITY_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;
  const result = await runActivityDigest(prisma, {
    windowHours: 24,
    webhookUrl,
  });
  logger.info("Daily activity digest posted", {
    posted: result.posted,
    events: result.feed?.totalEvents ?? 0,
  });
}

/**
 * Score applied clearance runs whose measurement window has elapsed (Observe→Learn),
 * once per UTC day on the first tick at/after OUTCOME_MEASURE_HOUR_UTC, then enqueue a
 * memory refresh for each affected merchant so the clearance-effectiveness belief picks
 * up the new outcomes. On by default; opt out with ENABLE_CLEARANCE_OUTCOME_JOB=false.
 *
 * Self-catching: a measurement failure must not trip the loop's failure streak. Safe to
 * run before execution is live — there are no applied runs while the write flag is off,
 * so it measures nothing and enqueues nothing (a no-op until the first real clearance).
 * The once-per-day guard is in-memory (a worker restart may re-run once, which is
 * idempotent — only pending rows are scored).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {Pick<Console, "info" | "warn" | "error">} logger
 */
async function maybeMeasureClearanceOutcomes(prisma, logger) {
  if (process.env.ENABLE_CLEARANCE_OUTCOME_JOB === "false") return;
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  if (
    lastOutcomeMeasureDay === dayKey ||
    now.getUTCHours() < OUTCOME_MEASURE_HOUR_UTC
  )
    return;
  lastOutcomeMeasureDay = dayKey;
  try {
    const result = await measureAndRecordClearanceOutcomes(prisma, { logger });
    if (result.measured === 0) return;
    const refreshed = new Set();
    for (const run of result.results) {
      const key = `${run.merchantId}:${run.shopId}`;
      if (refreshed.has(key)) continue;
      refreshed.add(key);
      await enqueueMerchantMemoryRefresh(prisma, {
        merchantId: run.merchantId,
        shopId: run.shopId,
        categories: ["business"],
        reason: "clearance_outcome_measured",
      });
    }
    logger.info("Clearance outcomes measured; memory refresh enqueued", {
      measured: result.measured,
      merchants: refreshed.size,
    });
  } catch (error) {
    logger.warn("Clearance outcome measurement failed; loop continues", {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ intervalMs?: number; initialDelayMs?: number; logger?: Pick<Console, "info" | "warn" | "error"> }} [options]
 */
export function startShopifyBackfillLoop(prisma, options = {}) {
  if (loopStarted || process.env.ENABLE_SHOPIFY_BACKFILL_LOOP === "false") {
    return;
  }

  loopStarted = true;
  const logger =
    options.logger ?? baseLogger.child({ component: "backfill-worker" });
  const intervalMs = options.intervalMs ?? LOOP_INTERVAL_MS;
  const workerPrisma = createWorkerPrismaClient() ?? prisma;
  const bootstrapPrisma = createWorkerPrismaClient() ?? prisma;
  loopPrisma = [...new Set([workerPrisma, bootstrapPrisma])];
  // Warm the Prisma engine during the initial delay so the first tick doesn't
  // race a still-connecting engine after a deploy ("Engine is not yet connected").
  if (typeof workerPrisma.$connect === "function") {
    void workerPrisma.$connect().catch(() => {});
  }
  if (
    bootstrapPrisma !== workerPrisma &&
    typeof bootstrapPrisma.$connect === "function"
  ) {
    void bootstrapPrisma.$connect().catch(() => {});
  }
  const initialDelayMs =
    options.initialDelayMs ??
    positiveInteger(
      process.env.SHOPIFY_BACKFILL_INITIAL_DELAY_MS,
      INITIAL_LOOP_DELAY_MS,
    );
  const generalTick = async () => {
    if (generalLoopRunning) return;
    generalLoopRunning = true;
    recordWorkerTick();
    try {
      await processReadyBackfillJobs(workerPrisma, {
        logger,
        excludeJobTypes: [
          MERCHANT_BOOTSTRAP_JOB_TYPE,
          BOOTSTRAP_ALTERNATIVE_JOB_TYPE,
        ],
      });
      await maybePostDailyDigest(workerPrisma, logger);
      await maybePruneOldEvents(workerPrisma, { logger });
      await maybePostChangelog(workerPrisma, { logger });
      await maybeMeasureClearanceOutcomes(workerPrisma, logger);
      await maybeSendWinBackCampaign(workerPrisma, { logger });
      await maybeSendMorningBriefs(workerPrisma, { logger }); // DARK unless ENABLE_MORNING_BRIEF && ENABLE_EMAIL
      maybeAlertWebhookHealth({ logger }); // sync, in-memory — alerts on sustained webhook degradation
      maybeAlertInboundEmailHealth({ logger }); // same, for the inbound-email path
      loopFailureStreak = 0; // a fully-successful tick clears the streak
    } catch (error) {
      loopFailureStreak += 1;
      if (!shouldPageOnWorkerError(loopFailureStreak)) {
        // A single failed tick self-heals on the next one — a transient DB/engine
        // blip (a Neon connection drop, deploy warmup) or a one-off fluke. WARN,
        // don't page. Only a SUSTAINED failure (streak past the threshold) is a
        // real outage worth waking someone. Error-agnostic, so a new Prisma error
        // variant ("Response from the Engine was empty" etc.) can't slip through.
        logger.warn("Backfill loop tick failed; will retry next tick", {
          err: error,
          streak: loopFailureStreak,
        });
      } else {
        // Pass the Error under `err` so it serialises (name/message/stack) and the
        // Slack alert shows the actual message, not just the headline.
        logger.error("Shopify evidence backfill loop failing repeatedly", {
          err: error,
          streak: loopFailureStreak,
        });
        // Also record it as an activity event (topic "reliability") so alerts are
        // readable from the panel + DB by any session, not just the Slack push.
        void track(workerPrisma, {
          type: "worker_error",
          topic: "reliability",
          summary: `Backfill worker loop error (x${loopFailureStreak}): ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 300),
          properties: {
            errorName: error instanceof Error ? error.name : "unknown",
            streak: loopFailureStreak,
          },
        });
      }
    } finally {
      generalLoopRunning = false;
    }
  };

  const bootstrapTick = async () => {
    if (bootstrapLoopRunning) return;
    bootstrapLoopRunning = true;
    try {
      await processReadyBackfillJobs(bootstrapPrisma, {
        logger,
        jobTypes: [
          MERCHANT_BOOTSTRAP_JOB_TYPE,
          BOOTSTRAP_ALTERNATIVE_JOB_TYPE,
        ],
      });
    } catch (error) {
      logger.warn("Bootstrap worker lane tick failed; will retry next tick", {
        err: error,
      });
    } finally {
      bootstrapLoopRunning = false;
    }
  };

  setTimeout(() => {
    void generalTick();
    void bootstrapTick();
  }, initialDelayMs).unref?.();
  setInterval(() => {
    void generalTick();
    void bootstrapTick();
  }, intervalMs).unref?.();
  registerWorkerPrismaShutdown();
}

/**
 * Drain immediately-ready jobs in one worker tick. Backfill jobs enqueue their
 * next phase as soon as a phase succeeds; processing only one job per 15s loop
 * made onboarding feel artificially stalled between products, inventory, orders,
 * delta sync, finalize, memory and generated onboarding work.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch; shopId?: string; jobType?: string; jobTypes?: string[]; excludeJobTypes?: string[]; ignoreRunAfter?: boolean; holdQueuedJobsUntil?: Date; loadOfflineToken?: (shop: string) => Promise<string>; maxJobs?: number }} [options]
 */
export async function processReadyBackfillJobs(prisma, options = {}) {
  await ensurePendingMerchantMemoryJobs(prisma);
  const maxJobs = Math.max(1, options.maxJobs ?? MAX_READY_JOBS_PER_TICK);
  const results = [];
  for (let processed = 0; processed < maxJobs; processed += 1) {
    const result = await processNextBackfillJob(prisma, options);
    if (!result) break;
    results.push(result);
  }
  return results;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch; shopId?: string; jobType?: string; jobTypes?: string[]; excludeJobTypes?: string[]; ignoreRunAfter?: boolean; holdQueuedJobsUntil?: Date; loadOfflineToken?: (shop: string) => Promise<string> }} [options]
 */
export async function processNextBackfillJob(prisma, options = {}) {
  const now = new Date();
  await recoverStaleRunningBackfillJobs(prisma, {
    now,
    logger: options.logger,
    shopId: options.shopId,
  });
  const where = {
    status: "queued",
    shopId: options.shopId,
    ...(options.jobType
      ? { jobType: options.jobType }
      : options.jobTypes?.length
        ? { jobType: { in: options.jobTypes } }
        : options.excludeJobTypes?.length
          ? { jobType: { notIn: options.excludeJobTypes } }
          : {}),
    ...(options.ignoreRunAfter ? {} : { runAfter: { lte: now } }),
  };
  const job = await prisma.backfillJob.findFirst({
    where,
    orderBy: [{ priority: "asc" }, { runAfter: "asc" }, { createdAt: "asc" }],
    include: { shop: true, merchant: true },
  });

  if (!job) return null;

  const claimed = await prisma.backfillJob.updateMany({
    where: { id: job.id, status: "queued" },
    data: {
      status: "running",
      startedAt: now,
      failedAt: null,
      lastError: null,
      attemptCount: { increment: 1 },
    },
  });

  if (claimed.count !== 1) return null;

  if (job.shop.status === "uninstalled") {
    await prisma.backfillJob.updateMany({
      where: { id: job.id },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        resultJson: { reason: "shop_uninstalled" },
      },
    });
    return { status: "cancelled", jobType: job.jobType };
  }

  return runWithContext(
    {
      correlationId: newCorrelationId(),
      jobId: job.id,
      jobType: job.jobType,
      shopId: job.shopId,
      shopDomain: job.shop.shopDomain,
    },
    () => runClaimedBackfillJob(prisma, job, options),
  );
}

/**
 * Execute a claimed backfill job and record its terminal state. Runs inside a
 * correlation context (established by the caller) so every log emitted during
 * this job run — including downstream memory-rebuild and LLM logs — shares one
 * correlationId.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").BackfillJob & { shop: import("@prisma/client").Shop; merchant: import("@prisma/client").Merchant }} job
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch; shopId?: string; holdQueuedJobsUntil?: Date; loadOfflineToken?: (shop: string) => Promise<string> }} options
 */
async function runClaimedBackfillJob(prisma, job, options) {
  try {
    const result = /** @type {any} */ (
      await runBackfillJob(prisma, job, options)
    );
    const shouldRequeue = Boolean(result?.requeue);
    const completed = await prisma.backfillJob.updateMany({
      where: { id: job.id, status: "running" },
      data: {
        status: shouldRequeue ? "queued" : "succeeded",
        runAfter: shouldRequeue ? new Date() : job.runAfter,
        ...(shouldRequeue ? { startedAt: null } : {}),
        completedAt: shouldRequeue ? null : new Date(),
        failedAt: null,
        lastError: null,
        resultJson: result ?? {},
      },
    });
    if (completed.count !== 1) {
      return { status: "cancelled", jobType: job.jobType, result };
    }
    if (job.jobType === RECOMMENDATION_REVIEW_JOB_TYPE && !shouldRequeue) {
      const current = await prisma.backfillJob.findUnique({
        where: { id: job.id },
        select: { payloadJson: true },
      });
      const currentPayload = jsonObject(current?.payloadJson);
      const resultRunAfter = stringValue(
        /** @type {any} */ (result)?.nextRunAfter,
      );
      const requestedRunAfter =
        currentPayload.rescanRequested === true
          ? stringValue(currentPayload.requestedRunAfter) ??
            new Date().toISOString()
          : null;
      const nextRunAfter = earliestIsoDate(
        resultRunAfter,
        requestedRunAfter,
      );
      if (nextRunAfter) {
        await ensureRecommendationReviewQueued(prisma, {
          merchantId: job.merchantId,
          shopId: job.shopId,
          runAfter: nextRunAfter,
          payload: { reason: "next_tracked_recommendation_review" },
        });
      }
    }
    if (!shouldRequeue) trackJobSuccess(prisma, job);
    await holdQueuedBackfillJobs(prisma, job.shopId, options.holdQueuedJobsUntil);
    return {
      status: shouldRequeue ? "queued" : "succeeded",
      jobType: job.jobType,
      result,
    };
  } catch (error) {
    const failure = backfillFailureDetails(error);
    const message = failure.message;
    const failedPermanently = job.attemptCount + 1 >= job.maxAttempts;
    const updated = await prisma.backfillJob.updateMany({
      where: { id: job.id },
      data: {
        status: failedPermanently ? "failed" : "queued",
        failedAt: failedPermanently ? new Date() : null,
        runAfter: failedPermanently
          ? job.runAfter
          : retryAfter(job.attemptCount),
        lastError: message.slice(0, 1000),
      },
    });
    if (updated.count !== 1) {
      return { status: "cancelled", jobType: job.jobType, error: message };
    }
    if (failedPermanently) {
      trackJobFailure(prisma, job, message);
    }
    if (job.jobType === MERCHANT_BOOTSTRAP_JOB_TYPE) {
      await markBootstrapFailed(prisma, job, failure, failedPermanently);
    } else if (job.jobType === RECOMMENDATION_REVIEW_JOB_TYPE || job.jobType === BOOTSTRAP_ALTERNATIVE_JOB_TYPE) {
      // A tracked review is independent of store ingestion readiness. The job's
      // own durable error state is the health signal; never downgrade setup.
    } else if (job.jobType === MEMORY_REFRESH_JOB_TYPE) {
      await markMemoryFailed(prisma, job, failure);
    } else if (job.jobType === MERCHANT_INSIGHTS_JOB_TYPE) {
      await markMerchantInsightsJobFailed(prisma, {
        merchantId: job.merchantId,
        shopId: job.shopId,
        runId: stringValue(jsonObject(job.payloadJson).runId),
        message,
      });
    } else if (job.jobType === MERCHANT_GOALS_JOB_TYPE) {
      await markMerchantGoalsJobFailed(prisma, {
        merchantId: job.merchantId,
        shopId: job.shopId,
        runId: stringValue(jsonObject(job.payloadJson).runId),
        message,
      });
    } else if (job.jobType === MERCHANT_PLAN_JOB_TYPE) {
      await markMerchantPlanJobFailed(prisma, {
        merchantId: job.merchantId,
        shopId: job.shopId,
        runId: stringValue(jsonObject(job.payloadJson).runId),
        message,
      });
    } else if (isMerchantMemoryMaintenanceJob(job.jobType)) {
      // Episodic indexes are rebuildable. The failed job and structured log are
      // the health signal; never mark Shopify evidence or setup as partial.
    } else if (failedPermanently) {
      await markEvidenceFailed(prisma, job, failure);
      await prisma.shop.update({
        where: { id: job.shopId },
        data: { setupStatus: "backfill_partial" },
      });
    } else {
      await prisma.shop.update({
        where: { id: job.shopId },
        data: { setupStatus: "backfill_partial" },
      });
    }
    await holdQueuedBackfillJobs(
      prisma,
      job.shopId,
      options.holdQueuedJobsUntil,
    );
    return { status: "failed", jobType: job.jobType, error: message };
  }
}

/**
 * Test callers can hold sibling jobs in the future while they drive one phase at
 * a time. Live worker calls do not pass this option, so normal scheduling is
 * unchanged.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 * @param {Date | undefined} runAfter
 */
async function holdQueuedBackfillJobs(prisma, shopId, runAfter) {
  if (!(runAfter instanceof Date)) return;
  await prisma.backfillJob.updateMany({
    where: { shopId, status: "queued" },
    data: { runAfter },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ now?: Date; timeoutMs?: number; logger?: Pick<Console, "info" | "warn" | "error">; shopId?: string }} [options]
 */
export async function recoverStaleRunningBackfillJobs(prisma, options = {}) {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? STALE_RUNNING_JOB_TIMEOUT_MS;
  const staleStartedBefore = new Date(now.getTime() - timeoutMs);
  const result = await prisma.backfillJob.updateMany({
    where: {
      status: "running",
      startedAt: { lt: staleStartedBefore },
      shopId: options.shopId,
    },
    data: {
      status: "queued",
      runAfter: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: "Recovered stale running job after worker restart.",
    },
  });

  if (result.count > 0) {
    options.logger?.warn("Recovered stale Shopify evidence backfill jobs", {
      count: result.count,
      staleStartedBefore: staleStartedBefore.toISOString(),
    });
  }

  return { recovered: result.count };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").BackfillJob & { shop: import("@prisma/client").Shop; merchant: import("@prisma/client").Merchant }} job
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch; loadOfflineToken?: (shop: string) => Promise<string> }} options
 */
async function runBackfillJob(prisma, job, options) {
  const payload = jsonObject(job.payloadJson);
  const scopes = splitScopes(payload.scopes);
  const orderHistoryDays = hasReadAllOrders(scopes)
    ? DEFAULT_BACKFILL_DAYS
    : FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS;
  const requiresShopifyToken =
    job.jobType !== "backfill_finalize" &&
    job.jobType !== MEMORY_REFRESH_JOB_TYPE &&
    job.jobType !== MERCHANT_INSIGHTS_JOB_TYPE &&
    job.jobType !== MERCHANT_GOALS_JOB_TYPE &&
    job.jobType !== MERCHANT_PLAN_JOB_TYPE &&
    job.jobType !== EPISODE_PROCESS_JOB_TYPE &&
    job.jobType !== EPISODE_BACKFILL_JOB_TYPE &&
    job.jobType !== BOOTSTRAP_ALTERNATIVE_JOB_TYPE &&
    job.jobType !== RECOMMENDATION_REVIEW_JOB_TYPE;
  const context = {
    merchantId: job.merchantId,
    shopId: job.shopId,
    shopDomain: job.shop.shopDomain,
    sessionId: stringValue(payload.sessionId),
    // Refresh-capable load: the worker rides no embedded request, so it must
    // re-exchange an expiring offline token itself (Shopify 403s stale ones).
    // Always the shop's offline session — background Admin API work needs offline.
    // Injected (options.loadOfflineToken) so DB-gated tests stub the token instead
    // of reaching the real unauthenticated.admin OAuth refresh (which throws with
    // no refresh-token grant, as it did in CI — see the ingestion job-chain test).
    accessToken: requiresShopifyToken
      ? await (options.loadOfflineToken ?? loadFreshOfflineToken)(
          job.shop.shopDomain,
        )
      : null,
    fetchImpl: options.fetchImpl,
    logger: options.logger ?? console,
    scopes,
    orderHistoryDays,
    startedAt:
      parseDate(payload.backfillStartedAt) ?? job.shop.backfillStartedAt,
    fullBackfillEpoch: stringValue(payload.fullBackfillEpoch),
  };

  switch (job.jobType) {
    case MERCHANT_BOOTSTRAP_JOB_TYPE:
      return runMerchantMemoryBootstrap(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        shopDomain: context.shopDomain,
        sessionId: context.sessionId,
        onboardingEpoch: stringValue(payload.onboardingEpoch),
        accessToken: requireAccessToken(context),
        fetchImpl: context.fetchImpl,
        logger: context.logger,
      });
    case BOOTSTRAP_ALTERNATIVE_JOB_TYPE:
      return generateBootstrapAlternative(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        shopDomain: context.shopDomain,
        contractKey: stringValue(payload.contractKey),
        logger: context.logger,
      });
    case "shop_backfill_start":
      return handleBackfillStart(prisma, context);
    case "products_backfill":
      return handleEvidenceBackfill(prisma, context, {
        domain: "products",
        backfillDomains: ["products"],
      });
    case "orders_backfill_365d":
      return handleEvidenceBackfill(prisma, context, {
        domain: "orders",
        backfillDomains: ["orders"],
      });
    case "inventory_backfill":
      return handleEvidenceBackfill(prisma, context, {
        domain: "inventory",
        backfillDomains: ["inventory"],
      });
    case "backfill_delta_sync":
      return handleDeltaSync(prisma, context);
    case "backfill_finalize":
      return handleFinalize(prisma, context);
    case MEMORY_REFRESH_JOB_TYPE:
      return handleMerchantMemoryRebuild(prisma, context, payload);
    case MERCHANT_INSIGHTS_JOB_TYPE:
      return generateMerchantInsights(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        runId: stringValue(payload.runId),
        logger: context.logger,
      });
    case MERCHANT_GOALS_JOB_TYPE:
      return generateMerchantGoals(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        runId: stringValue(payload.runId),
        logger: context.logger,
      });
    case MERCHANT_PLAN_JOB_TYPE:
      return generateMerchantPlan(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        runId: stringValue(payload.runId),
        logger: context.logger,
      });
    case EPISODE_PROCESS_JOB_TYPE:
      return processMerchantEpisodeBatch(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        logger: context.logger,
      });
    case EPISODE_BACKFILL_JOB_TYPE:
      return backfillMerchantEpisodes(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
      });
    case RECOMMENDATION_REVIEW_JOB_TYPE:
      return reviewDueRecommendations(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        logger: context.logger,
      });
    default:
      return {};
  }
}

/**
 * Durable lost-wakeup sweeper. Source-row states, rather than queue payloads,
 * decide whether a coalesced job must exist.
 * @param {import("@prisma/client").PrismaClient} prisma
 */
export async function ensurePendingMerchantMemoryJobs(prisma) {
  if (
    !prisma.merchantMemoryEpisode ||
    !prisma.merchantMemoryConversationMessage
  ) {
    return { episodeJobs: 0, backfillJobs: 0 };
  }
  const inactiveBefore = new Date(Date.now() - 30 * 60 * 1000);
  const [episodeSources, backfillSources, inactiveConversations] =
    await Promise.all([
      prisma.merchantMemoryEpisode.findMany({
        where: {
          shopId: { not: null },
          OR: [
            { processingStatus: { in: ["pending", "stale"] } },
            { embeddingStatus: "pending" },
          ],
        },
        select: { merchantId: true, shopId: true },
        distinct: ["shopId"],
        take: 100,
      }),
      prisma.merchantMemoryConversationMessage.findMany({
        where: { shopId: { not: null }, processingStatus: "backfill_pending" },
        select: { merchantId: true, shopId: true },
        distinct: ["shopId"],
        take: 100,
      }),
      prisma.merchantMemoryConversation?.findMany
        ? prisma.merchantMemoryConversation.findMany({
            where: {
              shopId: { not: null },
              OR: [
                { closedAt: { not: null } },
                { lastMessageAt: { lte: inactiveBefore } },
              ],
            },
            select: {
              id: true,
              merchantId: true,
              shopId: true,
              lastMessageAt: true,
            },
            take: 100,
          })
        : [],
    ]);
  const summaryRows =
    inactiveConversations.length > 0
      ? await prisma.merchantMemoryEpisode.findMany({
          where: {
            conversationId: {
              in: inactiveConversations.map((conversation) => conversation.id),
            },
            documentType: "summary",
            visibility: "current",
          },
          select: { conversationId: true, occurredAt: true },
          orderBy: { occurredAt: "desc" },
        })
      : [];
  const latestSummaryAt = new Map();
  for (const summary of summaryRows) {
    if (!latestSummaryAt.has(summary.conversationId)) {
      latestSummaryAt.set(summary.conversationId, summary.occurredAt);
    }
  }
  const summarySources = inactiveConversations.filter((conversation) => {
    const summaryAt = latestSummaryAt.get(conversation.id);
    return (
      !summaryAt ||
      !conversation.lastMessageAt ||
      summaryAt < conversation.lastMessageAt
    );
  });
  await Promise.all([
    ...episodeSources
      .filter((row) => row.shopId)
      .map((row) =>
        enqueueCoalescingMemoryJob(prisma, {
          merchantId: row.merchantId,
          shopId: /** @type {string} */ (row.shopId),
          jobType: EPISODE_PROCESS_JOB_TYPE,
          priority: 35,
        }),
      ),
    ...backfillSources
      .filter((row) => row.shopId)
      .map((row) =>
        enqueueCoalescingMemoryJob(prisma, {
          merchantId: row.merchantId,
          shopId: /** @type {string} */ (row.shopId),
          jobType: EPISODE_BACKFILL_JOB_TYPE,
          priority: 36,
        }),
      ),
    ...summarySources
      .filter((row) => row.shopId)
      .map((row) =>
        enqueueCoalescingMemoryJob(prisma, {
          merchantId: row.merchantId,
          shopId: /** @type {string} */ (row.shopId),
          jobType: EPISODE_PROCESS_JOB_TYPE,
          priority: 35,
        }),
      ),
  ]);
  return {
    episodeJobs: episodeSources.length + summarySources.length,
    backfillJobs: backfillSources.length,
  };
}

/** @param {string} jobType */
function isMerchantMemoryMaintenanceJob(jobType) {
  return (
    jobType === EPISODE_PROCESS_JOB_TYPE ||
    jobType === EPISODE_BACKFILL_JOB_TYPE
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").BackfillJob} job
 * @param {{ message: string; metadata?: unknown }} failure
 * @param {boolean} failedPermanently
 */
async function markBootstrapFailed(prisma, job, failure, failedPermanently) {
  const previous = await prisma.shopBackfillStatus.findUnique({
    where: { shopId_domain: { shopId: job.shopId, domain: BOOTSTRAP_BACKFILL_DOMAIN } },
    select: { metadata: true },
  });
  await upsertBackfillStatus(prisma, {
    merchantId: job.merchantId,
    shopId: job.shopId,
    domain: BOOTSTRAP_BACKFILL_DOMAIN,
    status: failedPermanently ? "failed" : "queued",
    completedAt: failedPermanently ? new Date() : undefined,
    lastError: failure.message.slice(0, 1000),
    metadata: {
      ...jsonObject(previous?.metadata),
      phase: failedPermanently ? "failed" : "retrying",
      safeErrorCode: safeBootstrapFailureCode(failure.message),
    },
  });
}

/** @param {string} message */
function safeBootstrapFailureCode(message) {
  if (/access|permission|scope|unauth|403/i.test(message)) return "shopify_access";
  if (/timeout|timed out/i.test(message)) return "temporary_timeout";
  return "bootstrap_failed";
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleBackfillStart(prisma, context) {
  await prisma.shop.update({
    where: { id: context.shopId },
    data: {
      setupStatus: "backfill_running",
      historicalOrderAccess: hasReadAllOrders(context.scopes)
        ? "full"
        : "limited",
      availableOrderHistoryDays: context.orderHistoryDays,
      backfillStartedAt: context.startedAt ?? new Date(),
    },
  });

  const payload = {
    shopDomain: context.shopDomain,
    sessionId: context.sessionId,
    scopes: context.scopes,
    availableOrderHistoryDays: context.orderHistoryDays,
    backfillStartedAt: (context.startedAt ?? new Date()).toISOString(),
    fullBackfillEpoch: context.fullBackfillEpoch,
  };

  await applyBackfillCountEstimates(prisma, context);

  const incompleteDomains = await incompleteInitialCommerceDomains(
    prisma,
    context.shopId,
  );
  const runAfter = new Date();
  const jobs = [];
  if (incompleteDomains.includes("products")) {
    jobs.push(
      enqueueBackfillJob(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        jobType: "products_backfill",
        runAfter,
        payload,
      }),
    );
  }
  if (incompleteDomains.includes("inventory")) {
    jobs.push(
      enqueueBackfillJob(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        jobType: "inventory_backfill",
        runAfter,
        payload,
      }),
    );
  }
  if (
    incompleteDomains.includes("orders") ||
    incompleteDomains.includes("customers") ||
    incompleteDomains.includes("refunds")
  ) {
    jobs.push(
      enqueueBackfillJob(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        jobType: "orders_backfill_365d",
        runAfter,
        payload,
      }),
    );
  }

  await Promise.all(jobs);

  return {
    queued: jobs.length,
    incompleteDomains,
    orderHistoryDays: context.orderHistoryDays,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
async function incompleteInitialCommerceDomains(prisma, shopId) {
  const statuses = await prisma.shopBackfillStatus.findMany({
    where: { shopId, domain: { in: INITIAL_COMMERCE_BACKFILL_DOMAINS } },
    select: { domain: true, status: true },
  });
  return INITIAL_COMMERCE_BACKFILL_DOMAINS.filter(
    (domain) =>
      !isCompleteStatus(
        statuses.find((status) => status.domain === domain)?.status,
      ),
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {{ domain: string; backfillDomains: Array<"products" | "orders" | "inventory"> }} input
 */
async function handleEvidenceBackfill(prisma, context, input) {
  await markRunning(prisma, context, input.domain);
  if (input.domain === "orders") {
    await markRunning(prisma, context, "refunds");
    await markRunning(prisma, context, "customers");
  }

  const totals = await runShopifyBackfill(prisma, {
    shopDomain: context.shopDomain,
    accessToken: requireAccessToken(context),
    sessionId: context.sessionId,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
    domains: input.backfillDomains,
    orderBackfillDays: context.orderHistoryDays,
  });

  await markComplete(
    prisma,
    context,
    input.domain,
    domainTotal(totals, input.domain),
  );

  if (input.domain === "orders") {
    await markComplete(prisma, context, "refunds", totals.refunds);
    const customerCount = await prisma.customerIdentity.count({
      where: { shopId: context.shopId },
    });
    await markComplete(prisma, context, "customers", customerCount);
  }

  await enqueueFinalizeIfEvidenceReady(prisma, context);

  return totals;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleDeltaSync(prisma, context) {
  const updatedAfter = new Date(
    (context.startedAt ?? new Date()).getTime() -
      DELTA_SYNC_OVERLAP_HOURS * 60 * 60 * 1000,
  );
  const totals = await runShopifyBackfill(prisma, {
    shopDomain: context.shopDomain,
    accessToken: requireAccessToken(context),
    sessionId: context.sessionId,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
    domains: ["orders"],
    orderUpdatedAfter: updatedAfter,
    orderBackfillDays: context.orderHistoryDays,
  });

  return { ...totals, updatedAfter: updatedAfter.toISOString() };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function enqueueFinalizeIfEvidenceReady(prisma, context) {
  const statuses = await prisma.shopBackfillStatus.findMany({
    where: { shopId: context.shopId },
  });
  const ready = ["products", "orders", "customers", "inventory"].every(
    (domain) =>
      isCompleteStatus(
        statuses.find((status) => status.domain === domain)?.status,
      ),
  );
  if (!ready) return;

  const payload = {
    shopDomain: context.shopDomain,
    sessionId: context.sessionId,
    scopes: context.scopes,
    backfillStartedAt: (context.startedAt ?? new Date()).toISOString(),
    fullBackfillEpoch: context.fullBackfillEpoch,
  };

  await Promise.all([
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "backfill_delta_sync",
      payload,
    }),
    enqueueBackfillJob(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      jobType: "backfill_finalize",
      payload,
    }),
  ]);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function handleFinalize(prisma, context) {
  const statuses = await prisma.shopBackfillStatus.findMany({
    where: { shopId: context.shopId },
  });
  const failed = statuses.filter(
    (status) =>
      INITIAL_COMMERCE_BACKFILL_DOMAINS.includes(status.domain) &&
      status.status === "failed",
  );
  const requiredComplete = [
    "products",
    "orders",
    "customers",
    "inventory",
  ].every((domain) =>
    isCompleteStatus(
      statuses.find((status) => status.domain === domain)?.status,
    ),
  );
  const nextSetupStatus =
    failed.length > 0
      ? "backfill_partial"
      : requiredComplete
        ? "ready"
        : "backfill_partial";

  await prisma.shop.update({
    where: { id: context.shopId },
    data: {
      setupStatus: nextSetupStatus,
      backfillCompletedAt: new Date(),
    },
  });

  if (requiredComplete) {
    await Promise.all([
      enqueueMerchantMemoryRefresh(prisma, {
        merchantId: context.merchantId,
        shopId: context.shopId,
        shopDomain: context.shopDomain,
        categories: [],
        reason: "shopify_backfill_completed",
      }),
      trackOnce(prisma, {
        type: "full_backfill_completed",
        topic: "onboarding",
        merchantId: context.merchantId,
        shopId: context.shopId,
        shopDomain: context.shopDomain,
        dedupeKey: `full_backfill_completed:${context.shopId}:${context.fullBackfillEpoch ?? "legacy"}`,
        summary: `Background store learning completed for ${context.shopDomain}`,
        properties: {
          fullBackfillEpoch: context.fullBackfillEpoch,
        },
      }),
    ]);
  }

  return {
    setupStatus: nextSetupStatus,
    failedDomains: failed.map((status) => status.domain),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {Record<string, any>} payload
 */
async function handleMerchantMemoryRebuild(prisma, context, payload) {
  const categories = Array.isArray(payload.categories)
    ? payload.categories.filter((category) => typeof category === "string")
    : [];

  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    lastError: null,
    metadata: {
      reason: stringValue(payload.reason) ?? "merchant_memory_rebuild",
      categories,
    },
  });

  const result = await rebuildMerchantMemory(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    categories,
    refreshType: categories.length > 0 ? "selective_refresh" : "full_rebuild",
    logger: context.logger,
  });

  if (categories.length === 0) {
    await reconcileBootstrapRecommendationsAfterFullRefresh(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
      logger: context.logger,
    });
  }

  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "complete",
    completedAt: new Date(),
    lastError: null,
    recordsProcessed: result.createdOrUpdated,
    metadata: result,
  });

  if (categories.length === 0) {
    await ensureMerchantInsightsQueued(prisma, {
      merchantId: context.merchantId,
      shopId: context.shopId,
    });
  }

  return result;
}

/**
 * After a completed FULL Merchant Memory rebuild, start the generated onboarding
 * chain by queueing Insights. Completed Insights queue Goals, and completed
 * Goals queue Plan, so each artifact is generated from the upstream artifact the
 * merchant will actually see.
 *
 * Gated strictly on shop.onboardingCompletedAt: during onboarding the funnel
 * (app._index) already drives Goals and Plan step by step, so this must never
 * fire mid-onboarding. It only takes over once the merchant has finished.
 *
 * The ensure*Queued helpers key each run on the relevant snapshot hash and reuse
 * existing runs when the snapshot is unchanged (status "reused" -> no job
 * enqueued, no LLM call).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function ensurePostOnboardingRecommendationsQueued(prisma, input) {
  const shop = await prisma.shop.findUnique({
    where: { id: input.shopId },
    select: { onboardingCompletedAt: true },
  });
  if (!shop?.onboardingCompletedAt) {
    return { status: "skipped_not_onboarded" };
  }

  const insights = await ensureMerchantInsightsQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
  });

  return { status: "ensured", insights: insights.status };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} job
 * @param {{ message: string; metadata: Record<string, any> }} failure
 */
async function markMemoryFailed(prisma, job, failure) {
  await upsertBackfillStatus(prisma, {
    merchantId: job.merchantId,
    shopId: job.shopId,
    domain: MEMORY_BACKFILL_DOMAIN,
    status: "failed",
    completedAt: null,
    lastError: failure.message.slice(0, 1000),
    metadata: { failedAt: new Date().toISOString(), ...failure.metadata },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; jobType: string }} job
 * @param {{ message: string; metadata: Record<string, any> }} failure
 */
async function markEvidenceFailed(prisma, job, failure) {
  await Promise.all(
    failedDomainsForJob(job.jobType).map((domain) =>
      upsertBackfillStatus(prisma, {
        merchantId: job.merchantId,
        shopId: job.shopId,
        domain,
        status: "failed",
        completedAt: null,
        lastError: failure.message.slice(0, 1000),
        metadata: { failedAt: new Date().toISOString(), ...failure.metadata },
      }),
    ),
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {string} domain
 * @param {string} [status]
 * @param {number | null | undefined} [totalRecordsEstimate]
 */
async function markRunning(
  prisma,
  context,
  domain,
  status = "running",
  totalRecordsEstimate = undefined,
) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain,
    status,
    startedAt: new Date(),
    completedAt: null,
    lastError: null,
    totalRecordsEstimate,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 * @param {string} domain
 * @param {number} recordsProcessed
 */
async function markComplete(prisma, context, domain, recordsProcessed) {
  await upsertBackfillStatus(prisma, {
    merchantId: context.merchantId,
    shopId: context.shopId,
    domain,
    status: "complete",
    completedAt: new Date(),
    lastError: null,
    recordsProcessed,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {BackfillContext} context
 */
async function applyBackfillCountEstimates(prisma, context) {
  const [productVariants, orders, customers] = await Promise.all([
    loadBackfillCountEstimate(context, "productVariants"),
    loadBackfillCountEstimate(context, "orders"),
    loadBackfillCountEstimate(context, "customers"),
  ]);

  await Promise.all(
    [
      ["products", productVariants],
      ["orders", orders],
      ["customers", customers],
    ]
      .filter((entry) => typeof entry[1] === "number")
      .map(([domain, totalRecordsEstimate]) =>
        prisma.shopBackfillStatus.update({
          where: {
            shopId_domain: {
              shopId: context.shopId,
              domain: /** @type {string} */ (domain),
            },
          },
          data: {
            totalRecordsEstimate: /** @type {number} */ (totalRecordsEstimate),
          },
        }),
      ),
  );
}

/**
 * @param {BackfillContext} context
 * @param {"productVariants" | "orders" | "customers"} domain
 */
async function loadBackfillCountEstimate(context, domain) {
  try {
    const client = new ShopifyAdminGraphqlClient({
      shopDomain: context.shopDomain,
      accessToken: requireAccessToken(context),
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: context.logger,
      fetchImpl: context.fetchImpl,
    });

    if (domain === "productVariants") {
      const data =
        /** @type {{ productVariantsCount?: { count?: number } }} */ (
          await client.request(PRODUCT_VARIANTS_COUNT_QUERY)
        );
      const count = data.productVariantsCount?.count;
      return typeof count === "number" && Number.isFinite(count) ? count : null;
    }

    if (domain === "customers") {
      const data = /** @type {{ customersCount?: { count?: number } }} */ (
        await client.request(CUSTOMERS_COUNT_QUERY)
      );
      const count = data.customersCount?.count;
      return typeof count === "number" && Number.isFinite(count) ? count : null;
    }

    const data = /** @type {{ ordersCount?: { count?: number } }} */ (
      await client.request(ORDERS_COUNT_QUERY, {
        query: buildOrdersBackfillQueryFilter(context.orderHistoryDays),
      })
    );
    const count = data.ordersCount?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  } catch (error) {
    context.logger.warn("Shopify evidence count estimate unavailable", {
      shopDomain: context.shopDomain,
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** @param {BackfillContext} context */
function requireAccessToken(context) {
  if (!context.accessToken) {
    throw new Error("No offline Shopify session token is available.");
  }
  return context.accessToken;
}

/** @param {number} attemptCount */
function retryAfter(attemptCount) {
  return new Date(Date.now() + Math.min(5, attemptCount + 1) * 60_000);
}

/**
 * @param {{ products: number; orders: number; inventoryLevels: number }} totals
 * @param {string} domain
 */
function domainTotal(totals, domain) {
  if (domain === "products") return totals.products;
  if (domain === "orders") return totals.orders;
  if (domain === "inventory") return totals.inventoryLevels;
  return 0;
}

/** @param {string} jobType */
function failedDomainsForJob(jobType) {
  if (jobType === "products_backfill") return ["products"];
  if (jobType === "orders_backfill_365d") {
    return ["orders", "refunds", "customers"];
  }
  if (jobType === "inventory_backfill") return ["inventory"];
  if (jobType === "backfill_delta_sync")
    return ["orders", "refunds", "customers"];
  return [];
}

/** @param {unknown} error */
function backfillFailureDetails(error) {
  const baseMessage =
    error instanceof Error ? error.message : "Backfill job failed.";
  const shopifyErrors =
    error && typeof error === "object" && "errors" in error
      ? error.errors
      : null;
  const firstShopifyMessage = firstGraphqlErrorMessage(shopifyErrors);
  const requestId =
    error && typeof error === "object" && "requestId" in error
      ? error.requestId
      : null;
  const message = firstShopifyMessage
    ? `${baseMessage}: ${firstShopifyMessage}`
    : baseMessage;

  return {
    message,
    metadata: {
      requestId: typeof requestId === "string" ? requestId : null,
      shopifyErrors: safeJsonValue(shopifyErrors),
    },
  };
}

/** @param {unknown} errors */
function firstGraphqlErrorMessage(errors) {
  if (!Array.isArray(errors)) return null;
  const first = errors.find(
    (error) => typeof error?.message === "string" && error.message !== "",
  );
  return first?.message ?? null;
}

/** @param {unknown} value */
function safeJsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** @param {string | null | undefined} status */
function isCompleteStatus(status) {
  return status === "complete";
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/** @param {unknown} value */
function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {string | null} left @param {string | null} right */
function earliestIsoDate(left, right) {
  if (!left) return right;
  if (!right) return left;
  return new Date(left) <= new Date(right) ? left : right;
}

/** @param {unknown} value @param {number} fallback */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function createWorkerPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  try {
    const url = new URL(databaseUrl);
    url.searchParams.set("connection_limit", "1");
    return new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });
  } catch {
    return null;
  }
}

function registerWorkerPrismaShutdown() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      for (const prisma of loopPrisma) {
        if (typeof prisma.$disconnect === "function") {
          void prisma.$disconnect();
        }
      }
    });
  }
}

/**
 * @typedef {{
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   sessionId: string | null;
 *   accessToken: string | null;
 *   fetchImpl?: typeof fetch;
 *   logger: Pick<Console, "info" | "warn" | "error">;
 *   scopes: string[];
 *   orderHistoryDays: number;
 *   startedAt: Date | null;
 *   fullBackfillEpoch: string | null;
 * }} BackfillContext
 */
