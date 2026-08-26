import assert from "node:assert/strict";
import test from "node:test";

import {
  OPPORTUNITY_SET_TTL_MS,
  CANDIDATE_CONSUMPTION_STATUS,
  loadActiveOpportunitySet,
  isDefinitelyExhausted,
  persistFreshOpportunitySet,
  claimNextCandidate,
  resolveCandidate,
  attachRecommendationToCandidate,
  loadOpportunitySetSummary,
} from "../app/lib/shopify/agentic-runtime/opportunity-set.server.js";

// ---------------------------------------------------------------------------
// Minimal in-memory fake for the two new Prisma models, following the same
// fake-prisma-object convention used by candidate-pipeline.test.mjs and
// home-proposal-generation.test.mjs (plain objects backed by an array/Map,
// no real database).
// ---------------------------------------------------------------------------

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("gt" in cond) return row[key] > cond.gt;
      if ("in" in cond) return cond.in.includes(row[key]);
    }
    return row[key] === cond;
  });
}

function makeFakePrisma() {
  const sets = new Map();
  const candidates = new Map();
  const runs = new Map();
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${++counter}`;

  function withCandidates(set) {
    if (!set) return null;
    return {
      ...set,
      candidates: [...candidates.values()]
        .filter((c) => c.opportunitySetId === set.id)
        .sort((a, b) => a.rank - b.rank),
    };
  }

  const merchantOpportunitySet = {
    async create({ data }) {
      const id = nextId("set");
      const row = { id, updatedAt: data.createdAt ?? new Date(), ...data };
      sets.set(id, row);
      return row;
    },
    async findFirst({ where, orderBy }) {
      let rows = [...sets.values()].filter((r) => matches(r, where));
      if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt - a.createdAt);
      return withCandidates(rows[0]);
    },
    async findUnique({ where }) {
      return withCandidates(sets.get(where.id));
    },
  };

  const merchantOpportunityCandidate = {
    async create({ data }) {
      const id = nextId("cand");
      const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
      candidates.set(id, row);
      return row;
    },
    async createMany({ data }) {
      for (const item of data) {
        const id = nextId("cand");
        candidates.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...item });
      }
      return { count: data.length };
    },
    async findFirst({ where }) {
      return [...candidates.values()].find((r) => matches(r, where)) ?? null;
    },
    async findMany({ where, orderBy }) {
      let rows = [...candidates.values()].filter((r) => matches(r, where));
      if (orderBy?.rank === "asc") rows.sort((a, b) => a.rank - b.rank);
      return rows;
    },
    async findUnique({ where }) {
      if (where.id) return candidates.get(where.id) ?? null;
      if (where.opportunitySetId_candidateId) {
        const { opportunitySetId, candidateId } = where.opportunitySetId_candidateId;
        return (
          [...candidates.values()].find(
            (r) => r.opportunitySetId === opportunitySetId && r.candidateId === candidateId,
          ) ?? null
        );
      }
      return null;
    },
    async update({ where, data }) {
      const row =
        (where.id && candidates.get(where.id)) ||
        (where.opportunitySetId_candidateId &&
          [...candidates.values()].find(
            (r) =>
              r.opportunitySetId === where.opportunitySetId_candidateId.opportunitySetId &&
              r.candidateId === where.opportunitySetId_candidateId.candidateId,
          ));
      if (!row) throw new Error("MerchantOpportunityCandidate not found");
      Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }) {
      const rows = [...candidates.values()].filter((r) => matches(r, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  };

  const merchantPlanRun = {
    async findUnique({ where }) {
      return runs.get(where.id) ?? null;
    },
  };

  return {
    merchantOpportunitySet,
    merchantOpportunityCandidate,
    merchantPlanRun,
    async $transaction(fn) {
      return fn({ merchantOpportunitySet, merchantOpportunityCandidate, merchantPlanRun });
    },
    // test-only helpers
    _setRunStatus(id, status) {
      runs.set(id, { id, status });
    },
    _candidateCount() {
      return candidates.size;
    },
  };
}

// The exact 7-candidate onboarding fixture from the task brief (Part 11 / "Real validation").
const ONBOARDING_FIXTURE = [
  "activate remaining draft products",
  "restore repeat purchase path",
  "increase multi-product baskets",
  "capture margin inputs",
  "address high-return products",
  "reconcile stale inventory",
  "revive declining range",
].map((diagnosedProblem, index) => ({
  candidateId: `cand-${index + 1}`,
  diagnosedProblem,
  status: CANDIDATE_CONSUMPTION_STATUS.queued,
  investigated: false,
}));

const MERCHANT = { merchantId: "m-1", shopId: "s-1" };

// ---------------------------------------------------------------------------
// Fresh request / reuse / expiry / not-calendar-based boundary
// ---------------------------------------------------------------------------

test("fresh request: no opportunity set exists → null (discovery required)", async () => {
  const prisma = makeFakePrisma();
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now: new Date() });
  assert.equal(set, null);
});

test("reuse: an opportunity set created 1h ago is still active", async () => {
  const prisma = makeFakePrisma();
  const now = new Date("2026-08-25T12:00:00Z");
  const createdAt = new Date(now.getTime() - 60 * 60 * 1000);
  await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE,
    discoveryLog: [],
    llmCallCount: 3,
    now: createdAt,
  });
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now });
  assert.ok(set);
  assert.equal(set.candidates.length, 7);
});

test("expiry: a set older than 24h is not reused — fresh discovery required", async () => {
  const prisma = makeFakePrisma();
  const createdAt = new Date("2026-08-24T00:00:00Z");
  await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE,
    discoveryLog: [],
    llmCallCount: 3,
    now: createdAt,
  });
  const justAfterExpiry = new Date(createdAt.getTime() + OPPORTUNITY_SET_TTL_MS + 1);
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now: justAfterExpiry });
  assert.equal(set, null);
});

test("not calendar-based: 23:59 reuses, 24:00+ regenerates — exact duration, not calendar day", async () => {
  const prisma = makeFakePrisma();
  const createdAt = new Date("2026-08-25T14:30:00Z");
  await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE,
    discoveryLog: [],
    llmCallCount: 3,
    now: createdAt,
  });
  const justUnder24h = new Date(createdAt.getTime() + OPPORTUNITY_SET_TTL_MS - 60_000);
  assert.ok(await loadActiveOpportunitySet(prisma, { ...MERCHANT, now: justUnder24h }));

  const exactly24h = new Date(createdAt.getTime() + OPPORTUNITY_SET_TTL_MS);
  assert.equal(await loadActiveOpportunitySet(prisma, { ...MERCHANT, now: exactly24h }), null);
});

// ---------------------------------------------------------------------------
// Resume (Part 11 acceptance scenario) / exhaustion
// ---------------------------------------------------------------------------

test("resume: 1/2 rejected, 3 recommended → next claim starts at rank 4 (Part 11 acceptance scenario)", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE,
    discoveryLog: [{ rescue: false, candidateCount: 7 }],
    llmCallCount: 5,
    now,
  });

  // Simulate run-1 having already investigated #1 (rejected), #2 (rejected), #3 (recommended).
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now });
  const [c1, c2, c3] = set.candidates;
  await resolveCandidate(prisma, { id: c1.id, status: CANDIDATE_CONSUMPTION_STATUS.rejected, reason: "weak" });
  await resolveCandidate(prisma, { id: c2.id, status: CANDIDATE_CONSUMPTION_STATUS.rejected, reason: "weak" });
  await resolveCandidate(prisma, { id: c3.id, status: CANDIDATE_CONSUMPTION_STATUS.recommended });

  // A second "Generate another proposal" (run-2) must claim rank 4, not rerun discovery and not
  // retry #1-#3.
  const claimed = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-2" });
  assert.equal(claimed.rank, 4);
  assert.equal(claimed.candidateId, "cand-4");
  assert.equal(prisma._candidateCount(), 7, "no rediscovery happened — still exactly 7 candidates");
});

test("exhaustion: all candidates consumed, set still <24h old → no claimable candidate, no rediscovery", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: [
      { candidateId: "a", diagnosedProblem: "a", status: CANDIDATE_CONSUMPTION_STATUS.rejected, investigated: true },
      { candidateId: "b", diagnosedProblem: "b", status: CANDIDATE_CONSUMPTION_STATUS.recommended, investigated: true },
    ],
    discoveryLog: [],
    llmCallCount: 2,
    now,
  });
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now });
  assert.equal(isDefinitelyExhausted(set), true);
  const claimed = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-2" });
  assert.equal(claimed, null);
});

test("not exhausted while a candidate is still QUEUED", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE.slice(0, 2).map((c, i) =>
      i === 0 ? { ...c, status: CANDIDATE_CONSUMPTION_STATUS.rejected, investigated: true } : c,
    ),
    discoveryLog: [],
    llmCallCount: 1,
    now,
  });
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now });
  assert.equal(isDefinitelyExhausted(set), false);
});

// ---------------------------------------------------------------------------
// Retry semantics (Part 7) / concurrency (Part 8)
// ---------------------------------------------------------------------------

test("worker retry: the same run resumes its own IN_PROGRESS candidate rather than claiming a new one", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE.slice(0, 3),
    discoveryLog: [],
    llmCallCount: 1,
    now,
  });
  const first = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-2" });
  assert.equal(first.rank, 1);
  // Simulate the worker crashing and retrying the same run before resolving the candidate.
  const resumed = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-2" });
  assert.equal(resumed.id, first.id, "must resume the same candidate, not advance the queue");
});

test("abandoned claim: a candidate IN_PROGRESS under a now-failed run is reclaimable by a later run", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE.slice(0, 2),
    discoveryLog: [],
    llmCallCount: 1,
    now,
  });
  const claimedByCrashedRun = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-crashed" });
  assert.equal(claimedByCrashedRun.rank, 1);
  prisma._setRunStatus("run-crashed", "failed"); // worker crash never resolved the candidate

  const reclaimed = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-fresh" });
  assert.equal(reclaimed.id, claimedByCrashedRun.id, "the abandoned rank-1 claim must be reclaimed, not skipped");
});

test("still-active owner: a candidate IN_PROGRESS under a still-running run is not reclaimed — the next request safely claims the next candidate instead", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE.slice(0, 2),
    discoveryLog: [],
    llmCallCount: 1,
    now,
  });
  const claimedByA = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-a" });
  assert.equal(claimedByA.rank, 1);
  prisma._setRunStatus("run-a", "running");

  // Concurrency (Part 8): two simultaneous "Generate another proposal" requests must not both
  // independently investigate candidate #1 — request B safely claims the next candidate instead.
  const claimedByB = await claimNextCandidate(prisma, { opportunitySetId, runId: "run-b" });
  assert.equal(claimedByB.rank, 2, "must not re-claim rank 1 while run-a is still active");
});

// ---------------------------------------------------------------------------
// Observability (Part 12)
// ---------------------------------------------------------------------------

test("loadOpportunitySetSummary answers 'why did this proposal start at candidate #4?' without reading code", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: ONBOARDING_FIXTURE,
    discoveryLog: [],
    llmCallCount: 5,
    now,
  });
  const set = await loadActiveOpportunitySet(prisma, { ...MERCHANT, now });
  await resolveCandidate(prisma, { id: set.candidates[0].id, status: CANDIDATE_CONSUMPTION_STATUS.rejected, reason: "weak" });
  await resolveCandidate(prisma, { id: set.candidates[1].id, status: CANDIDATE_CONSUMPTION_STATUS.rejected, reason: "weak" });
  await resolveCandidate(prisma, { id: set.candidates[2].id, status: CANDIDATE_CONSUMPTION_STATUS.recommended });

  const summary = await loadOpportunitySetSummary(prisma, opportunitySetId);
  assert.equal(summary.candidates.length, 7);
  assert.equal(summary.candidates[0].status, CANDIDATE_CONSUMPTION_STATUS.rejected);
  assert.equal(summary.candidates[2].status, CANDIDATE_CONSUMPTION_STATUS.recommended);
  assert.equal(summary.candidates[3].status, CANDIDATE_CONSUMPTION_STATUS.queued);
});

test("attachRecommendationToCandidate links the winning candidate back to its recommendation (Part 4 / Part 6)", async () => {
  const prisma = makeFakePrisma();
  const now = new Date();
  const opportunitySetId = await persistFreshOpportunitySet(prisma, {
    ...MERCHANT,
    sourceRunId: "run-1",
    candidates: [{ candidateId: "cand-1", diagnosedProblem: "x", status: CANDIDATE_CONSUMPTION_STATUS.recommended, investigated: true }],
    discoveryLog: [],
    llmCallCount: 1,
    now,
  });
  await attachRecommendationToCandidate(prisma, { opportunitySetId, candidateId: "cand-1", recommendationId: "rec-1" });
  const summary = await loadOpportunitySetSummary(prisma, opportunitySetId);
  assert.equal(summary.candidates[0].recommendationId, "rec-1");
});
