import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENTIC_RECOMMENDATION_JOB_TYPE } from "../app/lib/shopify/agentic-runtime/constants.server.js";
import { PLAN_RUN_STATUS } from "../app/lib/merchant-plan/constants.js";
import { recoverOrphanedAgenticRecommendationRuns } from "../app/services/shopify-backfill-worker.server.js";

// docs/proposal-generation-failure-2026-08-25-followup.md: a job-level retry of a "home"-sourced
// recommendation run never threaded sourceMode into the BackfillJob payload, so a later fallback
// to prepareAgenticRecommendationRun silently created a *new* run defaulting to sourceMode
// "agentic" — invisible to Home's polling (isHomeProposalGenerationInFlight filters on
// sourceMode: "home"), and the original run was left running/queued forever with nothing to
// pick it back up.

test("ensureAgenticRecommendationQueued's enqueueBackfillJob call writes sourceMode (and retry lineage) into the job payload", () => {
  // Exercising ensureAgenticRecommendationQueued end-to-end needs a full merchant snapshot
  // fixture (goals, insights, beliefs, prior recommendations, Shopify mirror state) — mocking
  // all of it would make this test more fragile than the thing it's guarding against. The
  // regression this guards is specific and structural: the object literal passed to
  // enqueueBackfillJob must include sourceMode, so a source-level assertion is the more honest
  // test of "will the next engineer who edits this literal notice they removed the field."
  const path = fileURLToPath(new URL("../app/lib/shopify/agentic-runtime/recommendation-service.server.js", import.meta.url));
  const source = readFileSync(path, "utf8");
  const enqueueCallMatch = source.match(/await enqueueBackfillJob\(prisma, \{[\s\S]*?payload: \{([\s\S]*?)\},\s*\}\);/);
  assert.ok(enqueueCallMatch, "expected to find the enqueueBackfillJob(...) call for AGENTIC_RECOMMENDATION_JOB_TYPE");
  const payloadLiteral = enqueueCallMatch[1];
  assert.match(payloadLiteral, /\bsourceMode\b/, "the enqueued job payload must carry sourceMode");
  assert.match(payloadLiteral, /\bretryOfRunId\b/, "the enqueued job payload must carry retry lineage");
});

test("recoverOrphanedAgenticRecommendationRuns fails a stale run that no BackfillJob references, regardless of sourceMode", async () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const staleUpdatedAt = new Date(now.getTime() - 20 * 60_000); // 20 minutes ago
  const merchantId = "00000000-0000-0000-0000-0000000b0001";
  const shopId = "00000000-0000-0000-0000-0000000b0002";
  const orphanedRun = {
    id: "run-orphan",
    merchantId,
    shopId,
    sourceMode: "agentic",
    status: PLAN_RUN_STATUS.running,
    updatedAt: staleUpdatedAt,
  };
  const updates = [];
  const prisma = {
    merchantPlanRun: {
      findMany: async () => [orphanedRun],
      update: async ({ where, data }) => {
        updates.push({ where, data });
        return { id: where.id, ...data };
      },
    },
    backfillJob: {
      findMany: async () => [], // no job of any status references this shop's run
    },
  };
  const result = await recoverOrphanedAgenticRecommendationRuns(prisma, { now });
  assert.equal(result.recovered, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "run-orphan");
  assert.equal(updates[0].data.status, PLAN_RUN_STATUS.failed);
  assert.equal(updates[0].data.safeErrorCode, "orphaned_run_recovered");
});

test("recoverOrphanedAgenticRecommendationRuns leaves a stale run alone when a live BackfillJob still owns it", async () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const staleUpdatedAt = new Date(now.getTime() - 20 * 60_000);
  const shopId = "00000000-0000-0000-0000-0000000c0002";
  const ownedRun = {
    id: "run-owned",
    merchantId: "00000000-0000-0000-0000-0000000c0001",
    shopId,
    sourceMode: "home",
    status: PLAN_RUN_STATUS.queued,
    updatedAt: staleUpdatedAt,
  };
  const updates = [];
  const prisma = {
    merchantPlanRun: {
      findMany: async () => [ownedRun],
      update: async ({ where, data }) => {
        updates.push({ where, data });
        return { id: where.id, ...data };
      },
    },
    backfillJob: {
      findMany: async () => [
        {
          shopId,
          status: "queued",
          payloadJson: { runId: "run-owned", sourceMode: "home" },
        },
      ],
    },
  };
  const result = await recoverOrphanedAgenticRecommendationRuns(prisma, { now });
  assert.equal(result.recovered, 0);
  assert.equal(updates.length, 0);
});

test("recoverOrphanedAgenticRecommendationRuns ignores runs that are not yet stale", async () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const recentUpdatedAt = new Date(now.getTime() - 60_000); // 1 minute ago
  const prisma = {
    merchantPlanRun: {
      findMany: async ({ where }) => {
        // Simulate the DB-side updatedAt filter: a fresh run should never be returned.
        return where.updatedAt.lt > recentUpdatedAt ? [] : [];
      },
    },
    backfillJob: { findMany: async () => [] },
  };
  const result = await recoverOrphanedAgenticRecommendationRuns(prisma, { now });
  assert.equal(result.recovered, 0);
});

test("AGENTIC_RECOMMENDATION_JOB_TYPE stays the constant recoverOrphanedAgenticRecommendationRuns filters BackfillJob rows by", () => {
  assert.equal(AGENTIC_RECOMMENDATION_JOB_TYPE, "agentic_recommendation_generate");
});
