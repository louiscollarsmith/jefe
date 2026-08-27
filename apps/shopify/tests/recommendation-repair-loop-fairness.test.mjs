import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInvestigationState,
  generateAgenticShopifyRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { runCandidateDrivenRecommendation } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// Regression coverage for docs/ops/recommendation-repair-loop-fairness/. Root cause:
// buildInvestigationState (the model-facing investigation ledger injected into every prompt) was
// computed over the *entire* shared toolResults history, unlike validateInvestigation (which was
// already correctly scoped to ownResultsStartIndex). A candidate that merely inherited an earlier,
// unrelated candidate's successful read via initialToolResults was told `investigationComplete:
// true` with a `doNotRepeat` instruction telling it NOT to call shopify_query again — directly
// contradicting the `repairInstruction` validateInvestigation issues once its own, correctly
// candidate-scoped check fails on the very next turn. A model handed both "you're done, don't
// repeat calls" and "you must call shopify_query" in the same run had no fair way to comply.

const priorCandidateOwnRead = {
  candidateId: "recover-repeat-customer-demand",
  iteration: 0,
  tool: SHOPIFY_GATEWAY_TOOL.query,
  ok: true,
  message: "orders query executed.",
  facts: { operation: "orders", classification: "FULL_SUCCESS", document: "query RepeatCustomerOrders { orders(first: 5) { edges { node { id } } } }" },
  error: null,
};

test("buildInvestigationState: unscoped (pre-fix shape), a candidate inheriting an unrelated prior read is wrongly told investigation is complete", () => {
  const state = buildInvestigationState([priorCandidateOwnRead], {
    discoveryToolName: SHOPIFY_GATEWAY_TOOL.schema,
    readToolName: SHOPIFY_GATEWAY_TOOL.query,
    requireDiscovery: false,
    // no ownResultsStartIndex — this is the historical, unscoped call shape
  });
  assert.equal(state.investigationComplete, true);
  assert.match(state.doNotRepeat, /Do not repeat/);
});

test("buildInvestigationState: scoped to ownResultsStartIndex, the same inherited history does not falsely claim completeness", () => {
  const state = buildInvestigationState([priorCandidateOwnRead], {
    discoveryToolName: SHOPIFY_GATEWAY_TOOL.schema,
    readToolName: SHOPIFY_GATEWAY_TOOL.query,
    requireDiscovery: false,
    ownResultsStartIndex: 1, // this candidate's own turns start after the one inherited row
    acceptAlreadyAvailableRead: true,
  });
  assert.equal(state.investigationComplete, false);
  assert.equal(state.doNotRepeat, null);
  assert.deepEqual(state.successfulReads, []);
});

test("buildInvestigationState: an own-turn ALREADY_AVAILABLE read counts toward completeness when acceptAlreadyAvailableRead is set, matching validateInvestigation's own bar", () => {
  const ownAlreadyAvailable = {
    candidateId: "reduce-return-exposure",
    iteration: 0,
    tool: SHOPIFY_GATEWAY_TOOL.query,
    ok: true,
    message: "ALREADY_AVAILABLE",
    facts: { operation: "orders", status: "ALREADY_AVAILABLE" },
    error: null,
  };
  const toolResults = [priorCandidateOwnRead, ownAlreadyAvailable];
  const state = buildInvestigationState(toolResults, {
    discoveryToolName: SHOPIFY_GATEWAY_TOOL.schema,
    readToolName: SHOPIFY_GATEWAY_TOOL.query,
    requireDiscovery: false,
    ownResultsStartIndex: 1,
    acceptAlreadyAvailableRead: true,
  });
  assert.equal(state.investigationComplete, true, "own-turn ALREADY_AVAILABLE should satisfy completeness, same as validateInvestigation's read check");
});

// ---------------------------------------------------------------------------
// Integration: the fairness fix through the real candidate-pipeline path
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  beliefs: [
    { id: "b-1", key: "orders.repeat_customers", category: "orders", value: { count: 51 }, authority: "deterministic" },
    { id: "b-2", key: "returns.exposure", category: "returns", value: { count: 1 }, authority: "deterministic" },
  ],
  goals: [], insights: [], goalCoaching: [], merchantContext: [], previousRecommendations: [], privacy: {}, beliefCount: 2,
};

function scriptedProvider(router) {
  return {
    enabled: true, provider: "test", model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      return { json: router(payload), usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function readCall(name) {
  return { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document: `query ${name} { orders(first: 5) { edges { node { id } } } }`, variables: {} } };
}

function rec(title, diagnosedProblem) {
  return {
    title, summary: "s", outcome: "o", scope: "sc", constraints: [],
    eligibilityCriteria: [{ resourceType: "Order", field: "id", operator: "eq", value: "1" }],
    materialExpectedEffects: ["e"], diagnosedProblem, mechanism: "m", whyThisAction: "w", whyNow: "n",
    supportingBeliefIds: ["b-1"], supportingInsightIds: [], feasibleWriteOperations: ["orderUpdate"],
    verificationPlan: "v", reversalStrategy: "Fixture reversal strategy.", confidence: "strong",
  };
}

function fakeClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) return { currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } };
      return { orders: { edges: [{ node: { id: "gid://shopify/Order/1" } }], pageInfo: { hasNextPage: false } } };
    },
  };
}

function baseRunInput(provider, overrides = {}) {
  return {
    provider,
    prisma: { shopifyOperationCall: { create: async () => ({}) }, session: { findFirst: async () => ({ scope: "read_orders" }) } },
    client: fakeClient(),
    merchantId: "00000000-0000-0000-0000-000000000031",
    shopId: "00000000-0000-0000-0000-000000000032",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_orders"],
    logger: { info() {}, warn() {}, error() {} },
    perCandidateIterations: 4,
    maxCandidatesFirstPass: 8,
    ...overrides,
  };
}

// A realistic model: reads doNotRepeat literally on its first turn (declines its own read if told
// not to repeat), and complies with an INSUFFICIENT_INVESTIGATION repair instruction thereafter.
function realisticModel(ownReadCall, ownRec, terminalStatus = "RECOMMEND_ACTION") {
  return (payload) => {
    const state = payload.investigationState;
    if (payload.iteration === 0) {
      if (state.doNotRepeat) return { status: terminalStatus, recommendation: ownRec, blocker: "no new evidence needed", candidateDisposition: "REJECTED" };
      return { status: "CONTINUE", toolCalls: [ownReadCall] };
    }
    if (state.lastValidationError?.errorCode === "INSUFFICIENT_INVESTIGATION") {
      return { status: "CONTINUE", toolCalls: [ownReadCall] };
    }
    return { status: terminalStatus, recommendation: ownRec, blocker: "concluded", candidateDisposition: "REJECTED" };
  };
}

test("second candidate inheriting the first candidate's history sees no doNotRepeat contradiction and calls its own read on turn 0", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          { candidateId: "recover-repeat-customer-demand", diagnosedProblem: "Repeat customers are churning.", priority: 1, possibleIntervention: "x", businessEvidenceRefs: ["b-1"] },
          { candidateId: "reduce-return-exposure", diagnosedProblem: "Fragile products have elevated return exposure.", priority: 2, possibleIntervention: "y", businessEvidenceRefs: ["b-2"] },
        ],
      };
    }
    if (payload.mode === "rescue_discovery") return { candidates: [] };
    if (payload.focusCandidate.candidateId === "recover-repeat-customer-demand") {
      return realisticModel(readCall("RepeatCustomerOrders"), rec("Win back repeat customers", "Repeat customers are churning."), "NO_ACTIONABLE_OPPORTUNITY")(payload);
    }
    if (payload.focusCandidate.candidateId === "reduce-return-exposure") {
      return realisticModel(readCall("LiveReturnExposureProducts"), rec("Reduce return exposure", "Fragile products have elevated return exposure."))(payload);
    }
    throw new Error(`unexpected candidate ${payload.focusCandidate.candidateId}`);
  });

  const result = await runCandidateDrivenRecommendation(baseRunInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  const candidateB = result.diagnostics.candidateQueue.find((c) => c.candidateId === "reduce-return-exposure");
  assert.equal(candidateB.status, "RECOMMENDED");

  // Every toolResult in the persisted trace is attributable to a candidateId and iteration.
  const ownReads = result.trace.toolResults.filter((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query);
  assert.equal(ownReads.length, 2, "both candidates issued their own read — neither relied on the other's");
  for (const row of ownReads) {
    assert.equal(typeof row.candidateId, "string");
    assert.equal(typeof row.iteration, "number");
  }
  assert.deepEqual(ownReads.map((r) => r.candidateId).sort(), ["recover-repeat-customer-demand", "reduce-return-exposure"]);
});

test("a candidate that never complies with the repair instruction fails honestly after exhausting its own budget, with a consistent (non-contradictory) prompt on every turn", async () => {
  const iterationsSeen = [];
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [{ candidateId: "reduce-return-exposure", diagnosedProblem: "Fragile products have elevated return exposure.", priority: 1, possibleIntervention: "y", businessEvidenceRefs: ["b-2"] }] };
    }
    if (payload.mode === "rescue_discovery") return { candidates: [] };
    iterationsSeen.push({ iteration: payload.iteration, doNotRepeat: payload.investigationState.doNotRepeat, lastValidationError: payload.investigationState.lastValidationError?.errorCode ?? null });
    return { status: "RECOMMEND_ACTION", recommendation: rec("Reduce return exposure", "Fragile products have elevated return exposure.") };
  });

  const result = await runCandidateDrivenRecommendation(baseRunInput(provider, { perCandidateIterations: 4 }));

  assert.equal(result.status, "NO_ACTIONABLE_OPPORTUNITY");
  // perCandidateIterations=4 real turns, plus the 3 refunded do-overs a premature (zero-read)
  // terminal attempt earns before it starts consuming real budget
  // (docs/ops/recommendation-candidate-turn-waste-fix/) — the model is asked 7 times total, not
  // given up on after 4, and still gets its full 4-iteration real budget on top of the refunds.
  assert.equal(iterationsSeen.length, 7, "the model gets its full iteration budget plus its refunded do-overs — the loop does not give up early");
  // No contradiction on any turn: doNotRepeat is never set for a candidate that hasn't itself read.
  for (const turn of iterationsSeen) assert.equal(turn.doNotRepeat, null);
  // From turn 1 onward, every turn carries the same, single, unambiguous repair instruction.
  assert.equal(iterationsSeen[0].lastValidationError, null);
  for (const turn of iterationsSeen.slice(1)) assert.equal(turn.lastValidationError, "INSUFFICIENT_INVESTIGATION");
});

test("generateAgenticShopifyRecommendation tags every toolResult row with the focus candidate's id and the iteration it was produced on", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("LiveReturnExposureProducts")] };
    return { status: "RECOMMEND_ACTION", recommendation: rec("Reduce return exposure", "Fragile products have elevated return exposure.") };
  });

  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: { shopifyOperationCall: { create: async () => ({}) }, session: { findFirst: async () => ({ scope: "read_orders" }) } },
    client: fakeClient(),
    merchantId: "00000000-0000-0000-0000-000000000031",
    shopId: "00000000-0000-0000-0000-000000000032",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_orders"],
    logger: { info() {}, warn() {}, error() {} },
    maxIterations: 4,
    focusCandidate: { candidateId: "reduce-return-exposure", diagnosedProblem: "Fragile products have elevated return exposure.", businessEvidenceRefs: ["b-2"] },
    initialToolResults: [],
  });

  assert.equal(result.status, "RECOMMEND_ACTION");
  const readRow = result.trace.toolResults.find((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query);
  assert.equal(readRow.candidateId, "reduce-return-exposure");
  assert.equal(readRow.iteration, 0);
});
