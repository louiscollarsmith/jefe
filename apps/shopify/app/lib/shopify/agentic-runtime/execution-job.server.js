// @ts-check
// NOTE: Direct DB access is not available to inspect current shopifyOperationCall
// rows for the Shop In-Stock action from this file. The real-store validation
// (spec §29) requires a manual DB check before executing against the live store.

import {
  AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX,
  AGENTIC_SHOPIFY_VERIFICATION_JOB_TYPE_PREFIX,
} from "./constants.server.js";
import { recordActionEvent } from "../../actions/action-display-state.server.js";

export {
  AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX,
  AGENTIC_SHOPIFY_VERIFICATION_JOB_TYPE_PREFIX,
};

export const MAX_VERIFICATION_RETRIES = 3;

/**
 * Returns the BackfillJob jobType for a given actionId.
 * The @@unique([shopId, jobType]) constraint on BackfillJob gives one-job-per-action.
 * @param {string} actionId
 */
export function agenticExecutionJobType(actionId) {
  return `${AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX}:${actionId}`;
}

/**
 * Returns the verification-retry BackfillJob jobType for a given actionId.
 * Separate from the execution job so the execution job can complete while
 * verification retries are pending. Satisfies @@unique([shopId, jobType]).
 * @param {string} actionId
 */
export function agenticVerificationJobType(actionId) {
  return `${AGENTIC_SHOPIFY_VERIFICATION_JOB_TYPE_PREFIX}:${actionId}`;
}

/**
 * Idempotent enqueue of an agentic Shopify execution job.
 * Also updates MerchantAction.progress.agentic.executionJob with job state.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   acceptedRevision: string;
 *   shopDomain?: string | null;
 *   scopes?: string[];
 * }} input
 * @returns {Promise<{ status: "enqueued" | "already_active" | "already_completed" | "already_failed"; job: any }>}
 */
export async function enqueueAgenticExecutionJob(prisma, input) {
  const jobType = agenticExecutionJobType(input.actionId);
  const existing = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType } },
  });

  if (existing) {
    const existingPayload = jsonObject(existing.payloadJson);
    const existingRevision = existingPayload?.acceptedRevision ?? null;

    if (existingRevision === input.acceptedRevision) {
      if (existing.status === "queued" || existing.status === "running") {
        return { status: "already_active", job: existing };
      }
      if (existing.status === "succeeded") {
        return { status: "already_completed", job: existing };
      }
      if (existing.status === "failed") {
        return { status: "already_failed", job: existing };
      }
    }

    // Never reset a RUNNING job. Store the new revision as pending so the
    // running worker re-queues for it on completion. This prevents two workers
    // from simultaneously owning the same logical job row in multi-process
    // deployments. The running job's Shopify writes are already blocked by the
    // gateway revision guard, so Shopify safety holds regardless.
    if (existing.status === "running") {
      const updated = await prisma.backfillJob.update({
        where: { id: existing.id },
        data: {
          payloadJson: {
            ...existingPayload,
            pendingAcceptedRevision: input.acceptedRevision,
          },
        },
      });
      await updateActionExecutionJobProgress(prisma, input, {
        acceptedRevision: input.acceptedRevision,
        jobStatus: "queued",
        enqueuedAt: new Date().toISOString(),
        note: "pending_when_running_completes",
      });
      return { status: "pending_when_running_completes", job: updated };
    }
    // Different revision, not running — fall through to upsert
  }

  const enqueuedAt = new Date().toISOString();
  const payload = {
    actionId: input.actionId,
    merchantId: input.merchantId,
    shopId: input.shopId,
    acceptedRevision: input.acceptedRevision,
    shopDomain: input.shopDomain ?? null,
    scopes: input.scopes ?? [],
    enqueuedAt,
  };

  const job = await prisma.backfillJob.upsert({
    where: { shopId_jobType: { shopId: input.shopId, jobType } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      jobType,
      status: "queued",
      priority: 15,
      runAfter: new Date(),
      payloadJson: payload,
      attemptCount: 0,
    },
    update: {
      status: "queued",
      priority: 15,
      runAfter: new Date(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      attemptCount: 0,
      payloadJson: payload,
    },
  });

  // Update MerchantAction.progress.agentic.executionJob for client-side visibility
  await updateActionExecutionJobProgress(prisma, input, {
    acceptedRevision: input.acceptedRevision,
    jobStatus: "queued",
    enqueuedAt,
  });

  return { status: "enqueued", job };
}

/**
 * Read-only: returns the current execution job state for an action.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   acceptedRevision?: string | null;
 * }} input
 * @returns {Promise<{ job: any | null; status: string | null; acceptedRevision: string | null; completedAt: string | null }>}
 */
export async function getAgenticExecutionJobState(prisma, input) {
  const jobType = agenticExecutionJobType(input.actionId);
  const job = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType } },
  });
  if (!job) return { job: null, status: null, acceptedRevision: null, completedAt: null };
  const payload = jsonObject(job.payloadJson);
  return {
    job,
    status: job.status ?? null,
    acceptedRevision: payload?.acceptedRevision ?? null,
    completedAt: job.completedAt?.toISOString?.() ?? job.completedAt ?? null,
  };
}

/**
 * Cancel any queued execution job for the given actionId whose acceptedRevision
 * differs from the current revision. Called when a draft update creates a new
 * revision that invalidates the previously-accepted one.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   currentRevision: string;
 * }} input
 */
export async function cancelAgenticExecutionJobForStaleRevision(prisma, input) {
  const jobType = agenticExecutionJobType(input.actionId);
  const job = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType } },
  });
  if (!job) return { cancelled: false, reason: "not_found" };
  if (job.status !== "queued") return { cancelled: false, reason: "not_queued" };

  const payload = jsonObject(job.payloadJson);
  if (payload?.acceptedRevision === input.currentRevision) {
    return { cancelled: false, reason: "revision_still_current" };
  }

  await prisma.backfillJob.update({
    where: { id: job.id },
    data: { status: "cancelled", completedAt: new Date() },
  });

  // Update MerchantAction progress so the UI can reflect cancellation
  await updateActionExecutionJobProgress(prisma, input, {
    acceptedRevision: payload?.acceptedRevision ?? null,
    jobStatus: "cancelled",
    cancelledAt: new Date().toISOString(),
    cancelReason: "stale_revision",
  });

  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// Verification retry job
// ---------------------------------------------------------------------------

/**
 * Enqueue a standalone verification-only retry job for an action whose mutation
 * phase is complete but whose verification hit the iteration budget.
 *
 * - Uses a separate job type so the execution job row can be marked succeeded.
 * - `verificationRetryCount` in the payload tracks retry number (1-based).
 * - `runAfter` implements backoff: 60 s × 2^(retryCount-1), capped at 600 s.
 * - Idempotent: if a queued job already exists for the same action, updates payload
 *   and runAfter rather than creating a duplicate.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   acceptedRevision: string;
 *   shopDomain?: string | null;
 *   scopes?: string[];
 *   verificationRetryCount?: number;
 * }} input
 */
export async function enqueueAgenticVerificationRetryJob(prisma, input) {
  const jobType = agenticVerificationJobType(input.actionId);
  const retryCount = input.verificationRetryCount ?? 1;
  const backoffMs = Math.min(60_000 * Math.pow(2, retryCount - 1), 600_000);
  const runAfter = new Date(Date.now() + backoffMs);
  const payload = {
    actionId: input.actionId,
    merchantId: input.merchantId,
    shopId: input.shopId,
    acceptedRevision: input.acceptedRevision,
    shopDomain: input.shopDomain ?? null,
    scopes: input.scopes ?? [],
    verificationRetryCount: retryCount,
    enqueuedAt: new Date().toISOString(),
  };
  await prisma.backfillJob.upsert({
    where: { shopId_jobType: { shopId: input.shopId, jobType } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      jobType,
      status: "queued",
      priority: 14,
      runAfter,
      payloadJson: payload,
      attemptCount: 0,
    },
    update: {
      status: "queued",
      runAfter,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      attemptCount: 0,
      payloadJson: payload,
    },
  });
}

// ---------------------------------------------------------------------------
// Execution phase helpers
// ---------------------------------------------------------------------------

/**
 * Marks the agentic execution job as actively executing.
 * Called by the worker before handing off to runAgenticShopifyExecution so the
 * workspace shows "Jefe working" during the LLM loop.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function markAgenticExecutionStarted(prisma, input) {
  await updateActionExecutionJobProgress(prisma, input, {
    phase: "executing",
    jobStatus: "running",
    startedAt: new Date().toISOString(),
  });
  await recordActionEvent(prisma, input, "action_execution_started");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Patches MerchantAction.progress.agentic.executionJob.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 * @param {Record<string, any>} jobState
 */
async function updateActionExecutionJobProgress(prisma, input, jobState) {
  try {
    const action = await prisma.merchantAction.findFirst({
      where: {
        id: input.actionId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
    });
    if (!action) return;
    const progress = jsonObject(action.progress) ?? {};
    const agentic = jsonObject(progress.agentic) ?? {};
    await prisma.merchantAction.update({
      where: { id: action.id },
      data: {
        progress: {
          ...progress,
          agentic: {
            ...agentic,
            executionJob: {
              ...(jsonObject(agentic.executionJob) ?? {}),
              ...jobState,
              updatedAt: new Date().toISOString(),
            },
          },
        },
      },
    });
  } catch {
    // Best-effort — progress update failure must not fail the job enqueue
  }
}

/** @param {unknown} value @returns {Record<string, any> | null} */
function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return /** @type {Record<string, any>} */ (value);
  }
  return null;
}
