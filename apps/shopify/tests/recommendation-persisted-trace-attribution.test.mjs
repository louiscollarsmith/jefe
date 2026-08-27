import assert from "node:assert/strict";
import test from "node:test";

import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { safeTrace } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";
import { publicShopifyToolResults, SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// Regression coverage for the persisted-trace attribution gap found while diagnosing why a live run
// (68ad8999-fd59-4e8f-9f01-c3f7e2a43860) still showed no candidateId/iteration in its DB row despite
// docs/ops/recommendation-repair-loop-fairness/ already tagging every toolResults row in-memory, from
// a fully current, continuously-running process (ruled out as a stale-build/hot-reload issue first).
//
// Root cause: safeTrace() in recommendation-service.server.js is a *second*, independent trace
// reconstruction that runs at the actual DB-persistence call sites (both the
// no_actionable_opportunity/failed branch and the RECOMMEND_ACTION success branch). It rebuilds each
// row from a fixed key whitelist that predates candidateId/iteration and silently dropped both.
// publicShopifyToolResults() was never the problem — nothing downstream of it preserved what it
// tagged. Fix: safeTrace's row mapper now carries candidateId/iteration through, mirroring
// publicShopifyToolResults exactly. No recommendation behaviour changes.

const CANDIDATE_ID = "reduce-return-exposure";

test("safeTrace preserves candidateId/iteration for FULL_SUCCESS, ALREADY_AVAILABLE, and recommendation_validation rows", () => {
  const toolResults = [
    {
      candidateId: CANDIDATE_ID,
      iteration: 0,
      tool: "recommendation_validation",
      ok: false,
      message: "Recommendation decisions require at least one successful Shopify read (shopify_query).",
      facts: {
        errorCode: "INSUFFICIENT_INVESTIGATION",
        requiredNextTools: [SHOPIFY_GATEWAY_TOOL.query],
        repairInstruction: "Call shopify_query to read relevant Shopify state before recommending.",
      },
      error: { code: "INSUFFICIENT_INVESTIGATION", message: "Recommendation decisions require at least one successful Shopify read (shopify_query)." },
    },
    {
      candidateId: CANDIDATE_ID,
      iteration: 1,
      tool: SHOPIFY_GATEWAY_TOOL.query,
      ok: true,
      message: "products query executed.",
      facts: {
        operation: "products",
        status: "FULL_SUCCESS",
        document: 'query LiveReturnExposureProducts { products(first: 10, query: "tag:fragile") { edges { node { id } } } }',
      },
      error: null,
    },
    {
      candidateId: CANDIDATE_ID,
      iteration: 2,
      tool: SHOPIFY_GATEWAY_TOOL.query,
      ok: true,
      message: "ALREADY_AVAILABLE: this exact GraphQL document and variables were already run successfully in this run.",
      facts: {
        operation: "products",
        status: "ALREADY_AVAILABLE",
        document: 'query LiveReturnExposureProducts { products(first: 10, query: "tag:fragile") { edges { node { id } } } }',
      },
      error: null,
    },
  ];

  // Route through the real upstream tagging step too, exactly as the persistence path does.
  const tagged = publicShopifyToolResults(toolResults);
  const persisted = safeTrace({ turns: [], toolResults: tagged, progressLog: [] });

  assert.equal(persisted.toolResults.length, 3);
  for (const row of persisted.toolResults) {
    assert.equal(row.candidateId, CANDIDATE_ID, `${row.tool} row lost its candidateId in safeTrace`);
    assert.equal(typeof row.iteration, "number", `${row.tool} row lost its iteration in safeTrace`);
  }
  assert.deepEqual(persisted.toolResults.map((r) => r.iteration), [0, 1, 2]);

  const [validationRow, freshRow, cachedRow] = persisted.toolResults;
  assert.equal(validationRow.tool, "recommendation_validation");
  assert.equal(freshRow.facts.status, "FULL_SUCCESS");
  assert.equal(cachedRow.facts.status, "ALREADY_AVAILABLE");
});

// ---------------------------------------------------------------------------
// Integration: the real candidate-investigation loop, through the real persistence sanitizer.
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  beliefs: [{ id: "b-1", key: "returns.exposure", category: "returns", value: { count: 1 }, authority: "deterministic" }],
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

function returnExposureReadCall() {
  return {
    tool: SHOPIFY_GATEWAY_TOOL.query,
    arguments: {
      document: 'query LiveReturnExposureProducts { products(first: 10, query: "tag:fragile") { edges { node { id title } } } }',
      variables: {},
    },
  };
}

function fakeClientForProducts() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      return { products: { edges: [{ node: { id: "gid://shopify/Product/9", title: "Fragile Vase" } }], pageInfo: { hasNextPage: false } } };
    },
  };
}

function returnExposureRec() {
  return {
    title: "Reduce return exposure on fragile items",
    summary: "s",
    outcome: "o",
    scope: "sc",
    constraints: [],
    eligibilityCriteria: [{ resourceType: "Product", field: "id", operator: "eq", value: "1" }],
    materialExpectedEffects: ["e"],
    diagnosedProblem: "Fragile products have elevated return exposure.",
    mechanism: "productUpdate adds care instructions to the description.",
    whyThisAction: "Live read confirmed fragile-tagged products exist.",
    whyNow: "n",
    supportingBeliefIds: ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "v",
    reversalStrategy: "Fixture reversal strategy.",
    confidence: "strong",
  };
}

test("real pipeline: INSUFFICIENT_INVESTIGATION -> fresh read -> re-asked (ALREADY_AVAILABLE) -> RECOMMEND_ACTION keeps candidateId/iteration through publicShopifyToolResults and safeTrace all the way to the persisted shape", async () => {
  const provider = scriptedProvider((payload) => {
    // iteration 0: no read yet — attempts RECOMMEND_ACTION immediately, triggers INSUFFICIENT_INVESTIGATION.
    if (payload.iteration === 0) return { status: "RECOMMEND_ACTION", recommendation: returnExposureRec() };
    // iteration 1: complies with the repair instruction — its own first, fresh read.
    if (payload.iteration === 1) return { status: "CONTINUE", toolCalls: [returnExposureReadCall()] };
    // iteration 2: re-asks the identical query — Gateway dedup returns ALREADY_AVAILABLE.
    if (payload.iteration === 2) return { status: "CONTINUE", toolCalls: [returnExposureReadCall()] };
    // iteration 3: investigation is now satisfied — concludes.
    return { status: "RECOMMEND_ACTION", recommendation: returnExposureRec() };
  });

  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: { shopifyOperationCall: { create: async () => ({}) }, session: { findFirst: async () => ({ scope: "read_products,write_products" }) } },
    client: fakeClientForProducts(),
    merchantId: "00000000-0000-0000-0000-000000000031",
    shopId: "00000000-0000-0000-0000-000000000032",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_products", "write_products"],
    logger: { info() {}, warn() {}, error() {} },
    maxIterations: 4,
    focusCandidate: { candidateId: CANDIDATE_ID, diagnosedProblem: "Fragile products have elevated return exposure.", businessEvidenceRefs: ["b-1"] },
    initialToolResults: [],
  });

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);

  // result.trace.toolResults is already publicShopifyToolResults' output — exactly what the real
  // candidate-pipeline hands to recommendation-service.server.js for persistence.
  const validationRow = result.trace.toolResults.find((r) => r.tool === "recommendation_validation");
  const freshRow = result.trace.toolResults.find((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.ok && r.facts?.classification === "FULL_SUCCESS");
  const cachedRow = result.trace.toolResults.find((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.ok && r.facts?.status === "ALREADY_AVAILABLE");
  assert.ok(validationRow, "expected an INSUFFICIENT_INVESTIGATION recommendation_validation row");
  assert.ok(freshRow, "expected one fresh FULL_SUCCESS read");
  assert.ok(cachedRow, "expected one ALREADY_AVAILABLE cache-hit read");
  for (const row of [validationRow, freshRow, cachedRow]) {
    assert.equal(row.candidateId, CANDIDATE_ID);
    assert.equal(typeof row.iteration, "number");
  }

  // The actual persistence step (recommendation-service.server.js) runs every trace through
  // safeTrace() before it reaches result_json — this is what the DB actually stores.
  const persisted = safeTrace(result.trace);
  const persistedValidation = persisted.toolResults.find((r) => r.tool === "recommendation_validation");
  const persistedFresh = persisted.toolResults.find((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.facts?.status === "FULL_SUCCESS");
  const persistedCached = persisted.toolResults.find((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.facts?.status === "ALREADY_AVAILABLE");
  assert.ok(persistedValidation && persistedFresh && persistedCached, "expected all three row kinds to survive safeTrace");
  for (const row of [persistedValidation, persistedFresh, persistedCached]) {
    assert.equal(row.candidateId, CANDIDATE_ID, `${row.tool} lost candidateId in safeTrace`);
    assert.equal(typeof row.iteration, "number", `${row.tool} lost iteration in safeTrace`);
  }
});
