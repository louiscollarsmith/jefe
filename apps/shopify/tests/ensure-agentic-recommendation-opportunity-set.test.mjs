import assert from "node:assert/strict";
import test from "node:test";

import { ensureAgenticRecommendationQueued } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";
import { CANDIDATE_CONSUMPTION_STATUS } from "../app/lib/shopify/agentic-runtime/opportunity-set.server.js";

// Focused coverage of ensureAgenticRecommendationQueued's opportunity-set short-circuit (Part 10:
// "Generate another proposal" against an exhausted-but-unexpired set must never create a new run
// or job — not even a wasted one). Everything below the short-circuit (prepareAgenticRecommendationRun,
// job enqueue) is covered indirectly by candidate-pipeline.test.mjs's reuse-mode tests and the
// existing recommendation-run-identity/home-proposal-generation suites; this test only needs enough
// fake prisma surface to reach the opportunity-set check.

function makeFakePrisma({ opportunitySet = null } = {}) {
  return {
    merchantPlanRun: {
      async findFirst() {
        return null; // no previous run — irrelevant to the exhaustion short-circuit
      },
    },
    merchantOpportunitySet: {
      async findFirst() {
        return opportunitySet;
      },
    },
  };
}

test("ensureAgenticRecommendationQueued: an exhausted, unexpired opportunity set short-circuits — no run, no job", async () => {
  const now = new Date();
  const exhaustedSet = {
    id: "set-1",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    candidates: [
      { status: CANDIDATE_CONSUMPTION_STATUS.rejected },
      { status: CANDIDATE_CONSUMPTION_STATUS.recommended },
    ],
  };
  const prisma = makeFakePrisma({ opportunitySet: exhaustedSet });

  const result = await ensureAgenticRecommendationQueued(prisma, {
    merchantId: "m-1",
    shopId: "s-1",
    resetAttempts: true,
  });

  assert.equal(result.status, "opportunity_set_exhausted");
  assert.equal(result.opportunitySetId, "set-1");
});

test("ensureAgenticRecommendationQueued: a not-yet-exhausted opportunity set does not short-circuit", async () => {
  const now = new Date();
  const openSet = {
    id: "set-2",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    candidates: [
      { status: CANDIDATE_CONSUMPTION_STATUS.rejected },
      { status: CANDIDATE_CONSUMPTION_STATUS.queued },
    ],
  };
  const prisma = makeFakePrisma({ opportunitySet: openSet });

  // prepareAgenticRecommendationRun needs real snapshot machinery this fake doesn't provide, so
  // we only assert it got *past* the exhaustion short-circuit (it will throw further down, inside
  // buildAgenticRecommendationSnapshot, which is the expected boundary of this focused test).
  await assert.rejects(
    () =>
      ensureAgenticRecommendationQueued(prisma, {
        merchantId: "m-1",
        shopId: "s-1",
        resetAttempts: true,
      }),
    /findFirst|findMany|undefined/,
  );
});
