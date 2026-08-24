import assert from "node:assert/strict";
import test from "node:test";

import {
  runCandidateDrivenRecommendation,
  CANDIDATE_STATUS,
  isNovelCandidate,
} from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_AGENT_TOOL } from "../app/lib/shopify/agentic-runtime/tools.server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  beliefs: [
    { id: "b-1", key: "catalog.draft_product_count", category: "catalog", value: { count: 1 }, authority: "deterministic" },
    { id: "b-2", key: "business.revenue_trend", category: "business", value: { trend: "declining" }, authority: "deterministic" },
  ],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 2,
};

function scriptedProvider(router) {
  const calls = [];
  return {
    enabled: true,
    provider: "test",
    model: "scripted-luna",
    calls,
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      calls.push(payload);
      return { json: router(payload, calls), usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function fakeShopifyClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return {
          currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] },
        };
      }
      if (document.includes("products(")) {
        return {
          products: {
            edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      return {};
    },
  };
}

function baseInput(provider, overrides = {}) {
  return {
    provider,
    prisma: {
      shopifyOperationCall: { create: async () => ({}) },
      session: { findFirst: async () => ({ scope: "read_products,write_products" }) },
    },
    client: fakeShopifyClient(),
    merchantId: "00000000-0000-0000-0000-000000000031",
    shopId: "00000000-0000-0000-0000-000000000032",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_products", "write_products"],
    logger: { info() {}, warn() {}, error() {} },
    perCandidateIterations: 4,
    ...overrides,
  };
}

function candidateFixture(candidateId, diagnosedProblem, priority, extra = {}) {
  return {
    candidateId,
    diagnosedProblem,
    priority,
    possibleIntervention: "make product purchasable",
    businessEvidenceRefs: ["b-1"],
    ...extra,
  };
}

function readCall(operation = "products", variables = { first: 5 }) {
  return { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation, variables, purpose: "Verify candidate against Shopify state." } };
}

function retrieveCall(query = "product update") {
  return { tool: SHOPIFY_AGENT_TOOL.retrieveOperations, arguments: { query, limit: 5 } };
}

function validRec(overrides = {}) {
  return {
    title: "Activate the stocked draft product",
    summary: "Publish a DRAFT product.",
    outcome: "The product becomes purchasable.",
    scope: "One draft product.",
    constraints: [],
    eligibilityCriteria: [{ resourceType: "Product", field: "status", operator: "eq", value: "DRAFT" }],
    materialExpectedEffects: ["Product moves from DRAFT to ACTIVE"],
    diagnosedProblem: "A stocked product is DRAFT and invisible to customers.",
    mechanism: "productUpdate sets status to ACTIVE, making it purchasable immediately.",
    whyThisAction: "Shopify read confirmed DRAFT status.",
    whyNow: "Every day it stays DRAFT is lost sellable assortment.",
    supportingBeliefIds: ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Read the product back and confirm status ACTIVE.",
    confidence: "strong",
    ...overrides,
  };
}

/** Candidate script helper: iteration 0 reads, iteration 1 concludes with `conclusion`. */
function investigate(conclusion) {
  return (payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall()] };
    return conclusion;
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Multiple candidates: A blocked, B investigated automatically
// ---------------------------------------------------------------------------

test("Test 1: candidate A blocked causes automatic pivot to candidate B; C is never reached", async () => {
  const investigatedIds = [];
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture("cand-a", "Problem A", 1),
          candidateFixture("cand-b", "Problem B", 2),
          candidateFixture("cand-c", "Problem C", 3),
        ],
      };
    }
    if (payload.mode === "candidate_investigation") {
      investigatedIds.push(payload.focusCandidate.candidateId);
      if (payload.focusCandidate.candidateId === "cand-a") {
        return investigate({ status: "BLOCKED", blocker: "A does not hold up.", candidateDisposition: "BLOCKED_BY_EVIDENCE" })(payload);
      }
      if (payload.focusCandidate.candidateId === "cand-b") {
        return investigate({ status: "RECOMMEND_ACTION", recommendation: validRec() })(payload);
      }
      throw new Error(`unexpected candidate ${payload.focusCandidate.candidateId}`);
    }
    throw new Error(`unexpected mode ${payload.mode}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.ok, true);
  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.deepEqual([...new Set(investigatedIds)], ["cand-a", "cand-b"]);
  const queueA = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-a");
  assert.equal(queueA.status, CANDIDATE_STATUS.blockedByEvidence);
  const queueB = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-b");
  assert.equal(queueB.status, CANDIDATE_STATUS.recommended);
});

// ---------------------------------------------------------------------------
// Test 2 — Candidate disproved by Shopify read
// ---------------------------------------------------------------------------

test("Test 2: candidate disproved by a Shopify read is REJECTED and B becomes INVESTIGATING", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [candidateFixture("cand-a", "Looked promising from Memory alone", 1), candidateFixture("cand-b", "Genuinely different problem", 2)],
      };
    }
    if (payload.mode === "candidate_investigation") {
      if (payload.focusCandidate.candidateId === "cand-a") {
        // No candidateDisposition set: exercises the default NO_ACTIONABLE_OPPORTUNITY -> REJECTED mapping.
        return investigate({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Shopify read disproved the premise." })(payload);
      }
      return investigate({ status: "RECOMMEND_ACTION", recommendation: validRec() })(payload);
    }
    throw new Error(`unexpected mode ${payload.mode}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION");
  const queueA = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-a");
  assert.equal(queueA.status, CANDIDATE_STATUS.rejected);
  const queueB = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-b");
  assert.equal(queueB.status, CANDIDATE_STATUS.recommended);
});

// ---------------------------------------------------------------------------
// Test 3 — Capability binding failure -> NON_EXECUTABLE, B attempted
// ---------------------------------------------------------------------------

test("Test 3: candidate with no executable Shopify mutation becomes NON_EXECUTABLE and B is attempted", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture("cand-a", "Repeat customers should be re-engaged", 1, { possibleIntervention: "send a retention message" }),
          candidateFixture("cand-b", "Draft product is invisible", 2),
        ],
      };
    }
    if (payload.mode === "candidate_investigation") {
      if (payload.focusCandidate.candidateId === "cand-a") {
        return investigate({
          status: "BLOCKED",
          blocker: "No safe Shopify write operation implements customer re-engagement.",
          candidateDisposition: "NON_EXECUTABLE",
        })(payload);
      }
      return investigate({ status: "RECOMMEND_ACTION", recommendation: validRec() })(payload);
    }
    throw new Error(`unexpected mode ${payload.mode}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION");
  const queueA = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-a");
  assert.equal(queueA.status, CANDIDATE_STATUS.nonExecutable);
});

// ---------------------------------------------------------------------------
// Test 4 — Candidate-specific missing evidence does not block unrelated candidates
// ---------------------------------------------------------------------------

test("Test 4: missing COGS blocks only the COGS-dependent candidate; B remains eligible", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture("cand-a", "Margin-aware price change", 1, { possibleIntervention: "adjust price using cost data" }),
          candidateFixture("cand-b", "Draft product is invisible", 2),
        ],
      };
    }
    if (payload.mode === "candidate_investigation") {
      if (payload.focusCandidate.candidateId === "cand-a") {
        return investigate({
          status: "BLOCKED",
          blocker: "Authoritative cost data is not available for this catalogue.",
          candidateDisposition: "BLOCKED_BY_EVIDENCE",
        })(payload);
      }
      return investigate({ status: "RECOMMEND_ACTION", recommendation: validRec() })(payload);
    }
    throw new Error(`unexpected mode ${payload.mode}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION");
  const queueA = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-a");
  assert.equal(queueA.status, CANDIDATE_STATUS.blockedByEvidence);
  const queueB = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-b");
  assert.equal(queueB.status, CANDIDATE_STATUS.recommended);
});

// ---------------------------------------------------------------------------
// Test 5 — Retrieval-loop prevention (primitive-level: generateAgenticShopifyRecommendation)
// ---------------------------------------------------------------------------

test("Test 5: repeated retrieve_shopify_operations without a read is structurally rejected and pushed toward a read", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.iteration < 4) return { status: "CONTINUE", toolCalls: [retrieveCall(`query ${payload.iteration}`)] };
    // By now retrieval has been capped; the model finally reads and recommends.
    if (payload.iteration === 4) return { status: "CONTINUE", toolCalls: [readCall()] };
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await generateAgenticShopifyRecommendation({
    ...baseInput(provider),
    maxIterations: 8,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "RECOMMEND_ACTION");
  const executedRetrievals = result.trace.toolResults.filter(
    (row) => row.tool === SHOPIFY_AGENT_TOOL.retrieveOperations && row.ok,
  );
  const rejectedRetrievals = result.trace.toolResults.filter(
    (row) => row.tool === SHOPIFY_AGENT_TOOL.retrieveOperations && !row.ok && row.error?.code === "RETRIEVAL_ALREADY_SUFFICIENT",
  );
  assert.ok(executedRetrievals.length <= 2, `expected at most 2 executed retrievals, got ${executedRetrievals.length}`);
  assert.ok(rejectedRetrievals.length > 0, "expected at least one retrieval to be structurally rejected");
});

// ---------------------------------------------------------------------------
// Test 6 — Zero-read regression: retrieve x 8 cannot exhaust the budget with reads = 0
// ---------------------------------------------------------------------------

test("Test 6: a model that only ever retrieves cannot reach turn-budget exhaustion with zero reads while a candidate exists", async () => {
  const provider = scriptedProvider((payload) => ({
    status: "CONTINUE",
    toolCalls: [retrieveCall(`query ${payload.iteration}`)],
  }));

  const result = await generateAgenticShopifyRecommendation({
    ...baseInput(provider),
    maxIterations: 8,
  });

  assert.equal(provider.calls.length, 8);
  const executedRetrievals = result.trace.toolResults.filter(
    (row) => row.tool === SHOPIFY_AGENT_TOOL.retrieveOperations && row.ok,
  );
  // The old regression let 7-8 retrievals execute with 0 reads. The cap makes that impossible:
  // only the first 2 ever execute: everything after is rejected and steered toward a read.
  assert.ok(executedRetrievals.length <= 2, `expected at most 2 executed retrievals, got ${executedRetrievals.length}`);
  const reads = result.trace.toolResults.filter((row) => row.tool === SHOPIFY_AGENT_TOOL.callOperation && row.ok);
  assert.equal(reads.length, 0);
  // Genuine budget exhaustion with an unread candidate present is reported honestly, not silently.
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Test 7 — Successful first candidate: no unnecessary investigation of B/C
// ---------------------------------------------------------------------------

test("Test 7: candidate A succeeds immediately; B and C are never investigated", async () => {
  const investigatedIds = [];
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture("cand-a", "Draft product is invisible", 1),
          candidateFixture("cand-b", "Some other problem", 2),
          candidateFixture("cand-c", "Yet another problem", 3),
        ],
      };
    }
    investigatedIds.push(payload.focusCandidate.candidateId);
    return investigate({ status: "RECOMMEND_ACTION", recommendation: validRec() })(payload);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.deepEqual([...new Set(investigatedIds)], ["cand-a"]);
});

// ---------------------------------------------------------------------------
// Test 8 — Rescue pass runs before no_actionable_opportunity
// ---------------------------------------------------------------------------

test("Test 8: rescue discovery runs, with rejection context, after the first pass exhausts", async () => {
  let rescueCallPayload = null;
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [candidateFixture("cand-a", "First pass problem", 1)] };
    }
    if (payload.mode === "rescue_discovery") {
      rescueCallPayload = payload;
      return { candidates: [] };
    }
    return investigate({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Disproven.", candidateDisposition: "REJECTED" })(payload);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "NO_ACTIONABLE_OPPORTUNITY");
  assert.ok(rescueCallPayload, "expected a rescue_discovery call before returning no_actionable_opportunity");
  assert.equal(rescueCallPayload.alreadyAttemptedCandidates.length, 1);
  assert.equal(rescueCallPayload.alreadyAttemptedCandidates[0].diagnosedProblem, "First pass problem");
  assert.equal(rescueCallPayload.alreadyAttemptedCandidates[0].status, CANDIDATE_STATUS.rejected);
  assert.equal(result.diagnostics.discoveryLog.length, 2);
  assert.equal(result.diagnostics.discoveryLog[0].rescue, false);
  assert.equal(result.diagnostics.discoveryLog[1].rescue, true);
});

// ---------------------------------------------------------------------------
// Test 9 — Rescue succeeds after first pass fails
// ---------------------------------------------------------------------------

test("Test 9: rescue pass finds a new grounded executable candidate and the recommendation persists", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [candidateFixture("cand-a", "First pass problem, rejected on read", 1)] };
    }
    if (payload.mode === "rescue_discovery") {
      return { candidates: [candidateFixture("cand-rescue", "Materially different rescue problem", 1)] };
    }
    if (payload.focusCandidate.candidateId === "cand-a") {
      return investigate({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Disproven.", candidateDisposition: "REJECTED" })(payload);
    }
    return investigate({ status: "RECOMMEND_ACTION", recommendation: validRec() })(payload);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.ok(result.recommendation);
  const rescueEntry = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-rescue");
  assert.equal(rescueEntry.status, CANDIDATE_STATUS.recommended);
});

// ---------------------------------------------------------------------------
// Test 10 — Truly exhausted store: only then no_actionable_opportunity
// ---------------------------------------------------------------------------

test("Test 10: no_actionable_opportunity is legal only after first-pass and rescue candidates are all terminal", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture("cand-a", "Already satisfied problem", 1),
          candidateFixture("cand-b", "Non executable problem", 2),
        ],
      };
    }
    if (payload.mode === "rescue_discovery") {
      return { candidates: [candidateFixture("cand-c", "Rescue problem also disproven", 1)] };
    }
    if (payload.focusCandidate.candidateId === "cand-a") {
      return investigate({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Already satisfied.", candidateDisposition: "ALREADY_SATISFIED" })(payload);
    }
    if (payload.focusCandidate.candidateId === "cand-b") {
      return investigate({ status: "BLOCKED", blocker: "No safe write.", candidateDisposition: "NON_EXECUTABLE" })(payload);
    }
    return investigate({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Rescue candidate disproven too.", candidateDisposition: "REJECTED" })(payload);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "NO_ACTIONABLE_OPPORTUNITY");
  assert.equal(result.ok, true);
  const statuses = Object.fromEntries(result.diagnostics.candidateQueue.map((c) => [c.candidateId, c.status]));
  assert.equal(statuses["cand-a"], CANDIDATE_STATUS.alreadySatisfied);
  assert.equal(statuses["cand-b"], CANDIDATE_STATUS.nonExecutable);
  assert.equal(statuses["cand-c"], CANDIDATE_STATUS.rejected);
});

// ---------------------------------------------------------------------------
// Test 11 — No fabricated recommendation under recommendation-first pressure
// ---------------------------------------------------------------------------

test("Test 11: no recommendation is fabricated when rescue discovery finds nothing genuinely new", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [candidateFixture("cand-a", "Draft product invisible to customers", 1)] };
    }
    if (payload.mode === "rescue_discovery") {
      // A near-duplicate of cand-a's diagnosedProblem: server-side novelty gate must drop it,
      // so no second investigation round should even be attempted.
      return { candidates: [candidateFixture("cand-a-restated", "Draft product invisible to customers again", 1)] };
    }
    return investigate({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Disproven.", candidateDisposition: "REJECTED" })(payload);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "NO_ACTIONABLE_OPPORTUNITY");
  assert.equal(result.recommendation, undefined);
  const investigatedCandidateIds = new Set(
    provider.calls
      .filter((payload) => payload.mode === "candidate_investigation")
      .map((payload) => payload.focusCandidate.candidateId),
  );
  assert.deepEqual([...investigatedCandidateIds], ["cand-a"], "the near-duplicate rescue candidate must not be investigated");
});

// ---------------------------------------------------------------------------
// Unit coverage for the novelty gate itself
// ---------------------------------------------------------------------------

test("isNovelCandidate: near-duplicate diagnosedProblem is not novel; a distinct one is", () => {
  const existing = [{ diagnosedProblem: "Draft product invisible to customers" }];
  assert.equal(isNovelCandidate({ diagnosedProblem: "Draft product invisible to customers again" }, existing), false);
  assert.equal(isNovelCandidate({ diagnosedProblem: "Repeat customers are not being re-engaged" }, existing), true);
});
