import assert from "node:assert/strict";
import test from "node:test";

import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { runCandidateDrivenRecommendation } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// Regression coverage for the "path-specific validateInvestigation false negative" found while
// diagnosing a live run (9022ca1a-ab09-445f-ade3-62c12dd783dc). Control candidates from that run:
//
//   PASS: repair-product-cost-coverage reached a substantive BLOCKED via the direct
//         `turn.status === "BLOCKED"` branch (validateInvestigation at line ~703), which was
//         already correctly scoped to ownResultsStartIndex.
//   FAIL: restart-intermittent-trading, investigate-return-heavy-products,
//         refresh-inventory-freshness, stabilise-declining-product-range — each has its own
//         FULL_SUCCESS Shopify read on record, yet the run's final result still reported
//         "Recommendation decisions require at least one successful Shopify read (shopify_query)."
//
// Root cause: none of these candidates ever landed back on a *validated* terminal status
// (RECOMMEND_ACTION/BLOCKED/NO_ACTIONABLE_OPPORTUNITY) before exhausting their iteration budget —
// each kept issuing more tool calls (a genuine own read, then repeat/discovery calls) without
// re-attempting a terminal status. That drops them into the iteration-budget fallback at the end of
// generateAgenticShopifyRecommendation, which — unlike the three validateInvestigation call sites
// above it in this same file — was NOT scoped to ownResultsStartIndex and did not re-check whether a
// read requirement was still actually unmet. terminalFailureStatus/terminalFailureBlocker simply
// scanned the *entire* shared, cross-candidate toolResults history for "the last
// recommendation_validation failure anywhere" and reported it verbatim — stale (cured by a later own
// read) or misattributed (a different, earlier candidate's rejection) either way. This is the
// "inconsistent call site" fixed below: both functions now accept the same ownResultsStartIndex /
// readToolName / acceptAlreadyAvailableRead scope every other validateInvestigation call already
// used, and no longer report a read-requirement failure once a satisfying read genuinely exists in
// scope. The successful-read invariant itself (what counts as a satisfying read) is unchanged.

const SNAPSHOT = {
  beliefs: [{ id: "b-1", key: "catalog.something", category: "catalog", value: { count: 1 }, authority: "deterministic" }],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 1,
};

function scriptedProvider(router) {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      return { json: router(payload), usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function readCall() {
  return {
    tool: SHOPIFY_GATEWAY_TOOL.query,
    arguments: { document: "query FreshnessCheck { products(first: 5) { edges { node { id } } } }", variables: {} },
  };
}

function schemaCall() {
  return { tool: SHOPIFY_GATEWAY_TOOL.schema, arguments: { action: "search", query: "Product tags" } };
}

function fakeClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      return { products: { edges: [{ node: { id: "gid://shopify/Product/1" } }], pageInfo: { hasNextPage: false } } };
    },
  };
}

function rec(overrides = {}) {
  return {
    title: "Do the thing",
    summary: "s",
    outcome: "o",
    scope: "sc",
    constraints: [],
    eligibilityCriteria: [{ resourceType: "Product", field: "id", operator: "eq", value: "1" }],
    materialExpectedEffects: ["e"],
    diagnosedProblem: "A problem confirmed by a live read.",
    mechanism: "productUpdate.",
    whyThisAction: "Live read confirmed it.",
    whyNow: "n",
    supportingBeliefIds: ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "v",
    confidence: "strong",
    ...overrides,
  };
}

function baseInput(provider, overrides = {}) {
  return {
    provider,
    prisma: { shopifyOperationCall: { create: async () => ({}) }, session: { findFirst: async () => ({ scope: "read_products,write_products" }) } },
    client: fakeClient(),
    merchantId: "00000000-0000-0000-0000-000000000031",
    shopId: "00000000-0000-0000-0000-000000000032",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_products", "write_products"],
    logger: { info() {}, warn() {}, error() {} },
    maxIterations: 4,
    focusCandidate: { candidateId: "reduce-return-exposure", diagnosedProblem: "A problem confirmed by a live read.", businessEvidenceRefs: ["b-1"] },
    initialToolResults: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1: single-candidate reproduction — an own earlier rejection, cured by an own later read,
// must not be reported as the final blocker once the budget runs out for an unrelated reason.
// ---------------------------------------------------------------------------

test("iteration-budget fallback: a candidate's own earlier INSUFFICIENT_INVESTIGATION rejection is no longer reported once its own later read cures it", async () => {
  const provider = scriptedProvider((payload) => {
    // iteration 0: attempts RECOMMEND_ACTION before any read of its own -> own INSUFFICIENT_INVESTIGATION.
    if (payload.iteration === 0) return { status: "RECOMMEND_ACTION", recommendation: rec() };
    // iteration 1: complies — its own first, fresh, successful read.
    if (payload.iteration === 1) return { status: "CONTINUE", toolCalls: [readCall()] };
    // iterations 2-3: keeps investigating (schema lookups) without ever re-attempting a terminal
    // status again — the budget runs out for a reason that has nothing to do with the read
    // requirement, which was already satisfied at iteration 1.
    return { status: "CONTINUE", toolCalls: [schemaCall()] };
  });

  const result = await generateAgenticShopifyRecommendation(baseInput(provider));

  assert.equal(result.ok, false);
  assert.notEqual(
    result.status,
    "INVESTIGATION_FAILED",
    `own later read at iteration 1 should have cured the iteration-0 rejection; got blocker: ${result.blocker}`,
  );
  assert.doesNotMatch(String(result.blocker ?? ""), /successful Shopify read/, "the cured rejection must not be reported as the final blocker");
});

// ---------------------------------------------------------------------------
// Part 2: cross-candidate reproduction (the real 9022ca1a shape) — a second candidate that reads
// successfully on its own must not inherit an earlier, unrelated candidate's stale rejection when
// it too falls into the iteration-budget fallback.
// ---------------------------------------------------------------------------

test("iteration-budget fallback: a candidate's own successful read is not shadowed by an earlier, unrelated candidate's rejection still sitting in shared history", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          { candidateId: "never-reads", diagnosedProblem: "Never actually reads Shopify.", priority: 1, possibleIntervention: "x", businessEvidenceRefs: ["b-1"] },
          { candidateId: "reads-then-stalls", diagnosedProblem: "Reads successfully, then stalls without concluding.", priority: 2, possibleIntervention: "y", businessEvidenceRefs: ["b-1"] },
        ],
      };
    }
    if (payload.mode === "rescue_discovery") return { candidates: [] };
    if (payload.focusCandidate.candidateId === "never-reads") {
      // Genuinely never reads — exhausts its own budget on repeated bare RECOMMEND_ACTION attempts.
      // This candidate's INVESTIGATION_FAILED / "successful Shopify read" rejection is legitimate
      // for *this* candidate, and lands in the shared history the next candidate inherits.
      return { status: "RECOMMEND_ACTION", recommendation: rec({ diagnosedProblem: "Never actually reads Shopify." }) };
    }
    if (payload.focusCandidate.candidateId === "reads-then-stalls") {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall()] }; // own fresh FULL_SUCCESS
      return { status: "CONTINUE", toolCalls: [schemaCall()] }; // stalls without re-attempting a terminal status
    }
    throw new Error(`unexpected candidate ${payload.focusCandidate.candidateId}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider, { focusCandidate: undefined, perCandidateIterations: 4 }));

  const neverReads = result.diagnostics.candidateQueue.find((c) => c.candidateId === "never-reads");
  const readsThenStalls = result.diagnostics.candidateQueue.find((c) => c.candidateId === "reads-then-stalls");

  // The first candidate's own failure is legitimate — it really never read.
  assert.equal(neverReads.resultStatus, "INVESTIGATION_FAILED");

  // The second candidate genuinely read; it must not be reported as having failed the read
  // requirement just because it inherited the first candidate's unrelated rejection in shared
  // history and then also ran out of budget (for a different reason: it never got back to a
  // terminal status attempt).
  assert.notEqual(
    readsThenStalls.resultStatus,
    "INVESTIGATION_FAILED",
    `own successful read must not be shadowed by an earlier candidate's unrelated rejection; reason: ${readsThenStalls.reason}`,
  );
  assert.doesNotMatch(String(readsThenStalls.reason ?? ""), /successful Shopify read/);
});

// ---------------------------------------------------------------------------
// Part 3: own FULL_SUCCESS at iteration 0, several later own ALREADY_AVAILABLE re-asks, then a
// terminal judgement — every terminal status path must recognise the earlier own successful read.
// ---------------------------------------------------------------------------

function ownReadThenSeveralAlreadyAvailable(terminalTurn) {
  // Branches on a call counter, not payload.iteration: the wasted-turn refund mechanism
  // (docs/ops/recommendation-candidate-turn-waste-fix/) pins the loop's iteration counter across a
  // duplicate-read turn that produces zero new evidence, so payload.iteration can repeat the same
  // value across several real LLM calls. Keying this fixture off a plain call count keeps it correct
  // regardless of how many of those calls get refunded.
  let call = 0;
  return () => {
    call += 1;
    if (call === 1) return { status: "CONTINUE", toolCalls: [readCall()] }; // own FULL_SUCCESS
    if (call === 2) return { status: "CONTINUE", toolCalls: [readCall()] }; // own ALREADY_AVAILABLE #1
    if (call === 3) return { status: "CONTINUE", toolCalls: [readCall()] }; // own ALREADY_AVAILABLE #2
    return terminalTurn; // 4th call: concludes
  };
}

test("RECOMMEND_ACTION path recognises an own earlier successful read across several later ALREADY_AVAILABLE re-asks", async () => {
  const provider = scriptedProvider(ownReadThenSeveralAlreadyAvailable({ status: "RECOMMEND_ACTION", recommendation: rec() }));
  const result = await generateAgenticShopifyRecommendation(baseInput(provider));
  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  const reads = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
  assert.equal(reads.length, 3, "one fresh read plus two ALREADY_AVAILABLE re-asks");
});

test("BLOCKED path recognises an own earlier successful read across several later ALREADY_AVAILABLE re-asks", async () => {
  const provider = scriptedProvider(
    ownReadThenSeveralAlreadyAvailable({ status: "BLOCKED", blocker: "No safe write path yet.", candidateDisposition: "BLOCKED" }),
  );
  const result = await generateAgenticShopifyRecommendation(baseInput(provider));
  assert.equal(result.status, "BLOCKED", `expected BLOCKED but got ${result.status}: ${result.blocker}`);
  assert.notEqual(result.blocker, "Recommendation decisions require at least one successful Shopify read (shopify_query).");
});

test("NO_ACTIONABLE_OPPORTUNITY path recognises an own earlier successful read across several later ALREADY_AVAILABLE re-asks", async () => {
  const provider = scriptedProvider(
    ownReadThenSeveralAlreadyAvailable({ status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Read confirmed no gap.", candidateDisposition: "REJECTED" }),
  );
  const result = await generateAgenticShopifyRecommendation(baseInput(provider));
  assert.equal(result.status, "NO_ACTIONABLE_OPPORTUNITY", `expected NO_ACTIONABLE_OPPORTUNITY but got ${result.status}: ${result.blocker}`);
  assert.notEqual(result.blocker, "Recommendation decisions require at least one successful Shopify read (shopify_query).");
});
