// @ts-check
// NOTE: Direct DB access is not available to inspect current shopifyOperationCall
// rows for the Shop In-Stock action from this file. The real-store validation
// (spec §29) requires a manual DB check before executing against the live store.

import { AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX } from "./constants.server.js";

export { AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX };

/**
 * Returns the BackfillJob jobType for a given actionId.
 * The @@unique([shopId, jobType]) constraint on BackfillJob gives one-job-per-action.
 * @param {string} actionId
 */
export function agenticExecutionJobType(actionId) {
  return `${AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX}:${actionId}`;
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
    // Different revision or unknown status — fall through to upsert
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
