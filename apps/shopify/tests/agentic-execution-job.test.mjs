// @ts-check
// NOTE: These tests use an in-memory fake prisma. Direct DB access is not
// available to inspect live shopifyOperationCall rows (spec §29); the real-store
// validation requires a manual DB check before executing against a live store.

import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX,
  agenticExecutionJobType,
  enqueueAgenticExecutionJob,
  getAgenticExecutionJobState,
  cancelAgenticExecutionJobForStaleRevision,
} from "../app/lib/shopify/agentic-runtime/execution-job.server.js";

const merchantId = "00000000-0000-0000-0000-000000000011";
const shopId = "00000000-0000-0000-0000-000000000012";
const actionId = "action-aaa";
const acceptedRevision = "rev-001";

test("agenticExecutionJobType returns prefix:actionId", () => {
  assert.equal(
    agenticExecutionJobType("action-xyz"),
    `${AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX}:action-xyz`,
  );
});

test("enqueueAgenticExecutionJob — first enqueue creates a queued job", async () => {
  const prisma = fakePrisma();
  const result = await enqueueAgenticExecutionJob(prisma, {
    merchantId,
    shopId,
    actionId,
    acceptedRevision,
  });

  assert.equal(result.status, "enqueued");
  assert.ok(result.job);
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.jobType, agenticExecutionJobType(actionId));
  assert.equal(result.job.payloadJson.acceptedRevision, acceptedRevision);
  assert.equal(result.job.payloadJson.actionId, actionId);

  // MerchantAction.progress.agentic.executionJob should be updated
  const action = prisma.actions.find((a) => a.id === actionId);
  assert.ok(action);
  assert.equal(action.progress.agentic.executionJob.jobStatus, "queued");
  assert.equal(action.progress.agentic.executionJob.acceptedRevision, acceptedRevision);
});

test("enqueueAgenticExecutionJob — same revision, queued job → already_active", async () => {
  const prisma = fakePrisma();
  // First enqueue
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  // Second enqueue (same revision, job still queued)
  const result = await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });

  assert.equal(result.status, "already_active");
  assert.equal(result.job.status, "queued");
  assert.equal(prisma.jobs.filter((j) => j.jobType === agenticExecutionJobType(actionId)).length, 1);
});

test("enqueueAgenticExecutionJob — same revision, running job → already_active", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  // Simulate the worker picking it up
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  job.status = "running";

  const result = await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  assert.equal(result.status, "already_active");
});

test("enqueueAgenticExecutionJob — same revision, succeeded → already_completed", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  job.status = "succeeded";

  const result = await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  assert.equal(result.status, "already_completed");
});

test("enqueueAgenticExecutionJob — same revision, failed → already_failed", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  job.status = "failed";

  const result = await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  assert.equal(result.status, "already_failed");
});

test("enqueueAgenticExecutionJob — different revision, non-running → re-enqueues (resets to queued)", async () => {
  const prisma = fakePrisma();
  // Enqueue first revision
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision: "rev-001" });
  const firstJob = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  firstJob.status = "failed";

  // Enqueue second revision — should reset to queued
  const result = await enqueueAgenticExecutionJob(prisma, {
    merchantId,
    shopId,
    actionId,
    acceptedRevision: "rev-002",
  });
  assert.equal(result.status, "enqueued");
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.payloadJson.acceptedRevision, "rev-002");
  // Still only one job row (upsert)
  assert.equal(prisma.jobs.filter((j) => j.jobType === agenticExecutionJobType(actionId)).length, 1);
});

test("enqueueAgenticExecutionJob — different revision, RUNNING job → pending (no reset, no dual ownership)", async () => {
  const prisma = fakePrisma();
  // Enqueue rev-001 and simulate it being claimed (running)
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision: "rev-001" });
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  job.status = "running";

  // Accept rev-002 while rev-001 is running
  const result = await enqueueAgenticExecutionJob(prisma, {
    merchantId,
    shopId,
    actionId,
    acceptedRevision: "rev-002",
  });

  // Must NOT reset to queued — that would allow a second worker to claim it
  assert.equal(result.status, "pending_when_running_completes");
  assert.equal(job.status, "running", "running job must not be reset to queued");
  // Pending revision recorded in payload for the running worker to detect on completion
  assert.equal(job.payloadJson.pendingAcceptedRevision, "rev-002");
  assert.equal(job.payloadJson.acceptedRevision, "rev-001", "acceptedRevision unchanged while running");
  // Still only one job row
  assert.equal(prisma.jobs.filter((j) => j.jobType === agenticExecutionJobType(actionId)).length, 1);
});

test("getAgenticExecutionJobState — returns null state when no job exists", async () => {
  const prisma = fakePrisma();
  const state = await getAgenticExecutionJobState(prisma, { merchantId, shopId, actionId });
  assert.equal(state.job, null);
  assert.equal(state.status, null);
});

test("getAgenticExecutionJobState — returns current job status", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision });
  const state = await getAgenticExecutionJobState(prisma, { merchantId, shopId, actionId });
  assert.equal(state.status, "queued");
  assert.equal(state.acceptedRevision, acceptedRevision);
  assert.ok(state.job);
});

test("cancelAgenticExecutionJobForStaleRevision — cancels queued job for stale revision", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision: "rev-001" });

  const result = await cancelAgenticExecutionJobForStaleRevision(prisma, {
    merchantId,
    shopId,
    actionId,
    currentRevision: "rev-002",
  });

  assert.equal(result.cancelled, true);
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  assert.equal(job.status, "cancelled");
});

test("cancelAgenticExecutionJobForStaleRevision — leaves running job alone", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision: "rev-001" });
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  job.status = "running";

  const result = await cancelAgenticExecutionJobForStaleRevision(prisma, {
    merchantId,
    shopId,
    actionId,
    currentRevision: "rev-002",
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.reason, "not_queued");
  assert.equal(job.status, "running"); // unchanged
});

test("cancelAgenticExecutionJobForStaleRevision — leaves succeeded job alone", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision: "rev-001" });
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  job.status = "succeeded";

  const result = await cancelAgenticExecutionJobForStaleRevision(prisma, {
    merchantId,
    shopId,
    actionId,
    currentRevision: "rev-002",
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.reason, "not_queued");
});

test("cancelAgenticExecutionJobForStaleRevision — no-ops when no job exists", async () => {
  const prisma = fakePrisma();
  const result = await cancelAgenticExecutionJobForStaleRevision(prisma, {
    merchantId,
    shopId,
    actionId,
    currentRevision: "rev-002",
  });
  assert.equal(result.cancelled, false);
  assert.equal(result.reason, "not_found");
});

test("cancelAgenticExecutionJobForStaleRevision — no-ops when revision is still current", async () => {
  const prisma = fakePrisma();
  await enqueueAgenticExecutionJob(prisma, { merchantId, shopId, actionId, acceptedRevision: "rev-001" });

  const result = await cancelAgenticExecutionJobForStaleRevision(prisma, {
    merchantId,
    shopId,
    actionId,
    currentRevision: "rev-001", // same revision — not stale
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.reason, "revision_still_current");
  const job = prisma.jobs.find((j) => j.jobType === agenticExecutionJobType(actionId));
  assert.equal(job.status, "queued");
});

// ---------------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------------

function fakePrisma() {
  const prisma = {
    jobs: /** @type {any[]} */ ([]),
    actions: /** @type {any[]} */ ([
      {
        id: actionId,
        merchantId,
        shopId,
        status: "accepted",
        progress: { agentic: {} },
        plan: {},
      },
    ]),
    backfillJob: {
      findUnique: async ({ where }) => {
        const key = where.shopId_jobType;
        return (
          prisma.jobs.find(
            (j) => j.shopId === key.shopId && j.jobType === key.jobType,
          ) ?? null
        );
      },
      upsert: async ({ where, create, update }) => {
        const key = where.shopId_jobType;
        const existing = prisma.jobs.find(
          (j) => j.shopId === key.shopId && j.jobType === key.jobType,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = {
          id: `job-${prisma.jobs.length + 1}`,
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        prisma.jobs.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = prisma.jobs.find((j) => j.id === where.id);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row ?? null;
      },
    },
    merchantAction: {
      findFirst: async ({ where }) =>
        prisma.actions.find(
          (a) =>
            a.id === where.id &&
            a.merchantId === where.merchantId &&
            a.shopId === where.shopId,
        ) ?? null,
      update: async ({ where, data }) => {
        const row = prisma.actions.find((a) => a.id === where.id);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row ?? null;
      },
    },
  };
  return prisma;
}
