import assert from "node:assert/strict";
import test from "node:test";

import {
  validateInvestigation,
  generateAgenticShopifyRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { runCandidateDrivenRecommendation } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// Regression coverage for docs/ops/recommendation-already-available-validation-fix/. Root cause:
// candidate-pipeline.server.js shares one toolResults history across every candidate in a run
// (initialToolResults carries each prior candidate's tool calls forward). validateInvestigation's
// "at least one successful read" check scanned that *entire* shared history with no boundary, so
// a candidate could get read-credit purely from a DIFFERENT, earlier candidate's unrelated read —
// including with zero tool calls of its own. The fix (`ownResultsStartIndex`) scopes the check to
// the current candidate's own turns, while still letting a candidate that itself asks for an
// already-known query (and gets ALREADY_AVAILABLE back) satisfy the requirement.

// ---------------------------------------------------------------------------
// Part 1: unit coverage on validateInvestigation directly
// ---------------------------------------------------------------------------

function freshRead(operation = "products") {
  return { tool: "shopify_query", ok: true, facts: { operation, status: "FULL_SUCCESS" }, error: null };
}
function alreadyAvailableRead(operation = "products") {
  return { tool: "shopify_query", ok: true, facts: { operation, status: "ALREADY_AVAILABLE" }, error: null };
}
function failedRead(operation = "products") {
  return { tool: "shopify_query", ok: false, facts: { operation }, error: { code: "SHOPIFY_ERROR", message: "boom" } };
}
const GATEWAY_OPTS = { readToolName: "shopify_query", requireDiscovery: false, acceptAlreadyAvailableRead: true };

test("fresh success satisfies investigation", () => {
  assert.equal(validateInvestigation([freshRead()], null, null, GATEWAY_OPTS).ok, true);
});

test("cached success (ALREADY_AVAILABLE) satisfies investigation when accepted", () => {
  assert.equal(validateInvestigation([alreadyAvailableRead()], null, null, GATEWAY_OPTS).ok, true);
});

test("cached success does NOT satisfy investigation when not accepted (single open-ended loop default)", () => {
  assert.equal(
    validateInvestigation([alreadyAvailableRead()], null, null, { readToolName: "shopify_query", requireDiscovery: false }).ok,
    false,
  );
});

test("a failed read (fresh or cached) never satisfies investigation", () => {
  assert.equal(validateInvestigation([failedRead()], null, null, GATEWAY_OPTS).ok, false);
});

test("ownResultsStartIndex: a read before the boundary does not count, even if fresh", () => {
  const toolResults = [freshRead("products")]; // this row belongs to an earlier candidate
  const result = validateInvestigation(toolResults, null, null, { ...GATEWAY_OPTS, ownResultsStartIndex: toolResults.length });
  assert.equal(result.ok, false, "a read that predates this candidate's own turns must not count");
});

test("ownResultsStartIndex: a read at/after the boundary counts", () => {
  const toolResults = [freshRead("products")];
  const startIndex = toolResults.length;
  toolResults.push(alreadyAvailableRead("products")); // this candidate's own turn asked and got ALREADY_AVAILABLE
  const result = validateInvestigation(toolResults, null, null, { ...GATEWAY_OPTS, ownResultsStartIndex: startIndex });
  assert.equal(result.ok, true, "a read this candidate itself triggered must count, cached or not");
});

test("unrelated cached evidence does not satisfy a different evidence question by default scoping", () => {
  // Candidate A's products read is unrelated to candidate B's orders/customers question. Even
  // though it's a genuinely fresh, successful read, it must not count toward B's own requirement
  // once scoped to B's own turns.
  const toolResults = [freshRead("products")];
  const bStartIndex = toolResults.length; // B's investigation begins with zero of its own reads
  const result = validateInvestigation(toolResults, null, null, { ...GATEWAY_OPTS, ownResultsStartIndex: bStartIndex });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Part 2: integration coverage through the real candidate-pipeline path
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  beliefs: [{ id: "b-1", key: "catalog.draft_product_count", category: "catalog", value: { count: 1 }, authority: "deterministic" }],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 1,
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

function fakeShopifyClient(productsCallLog = []) {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      if (document.includes("products(")) {
        productsCallLog.push(document);
        return {
          products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }], pageInfo: { hasNextPage: false } },
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

function gatewayReadCall(variables = { first: 5 }) {
  return {
    tool: SHOPIFY_GATEWAY_TOOL.query,
    arguments: { document: "query($first: Int!) { products(first: $first) { edges { node { id title status } } } }", variables },
  };
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

test("real reproduced shape: a candidate that itself intentionally re-requests an earlier candidate's exact query, and gets ALREADY_AVAILABLE, still reaches RECOMMEND_ACTION", async () => {
  const productsCallLog = [];
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          { candidateId: "activate-draft-products", diagnosedProblem: "Draft products are unpublished", priority: 1, possibleIntervention: "publish", businessEvidenceRefs: ["b-1"] },
          { candidateId: "increase-basket-completion", diagnosedProblem: "Baskets are single-item", priority: 2, possibleIntervention: "cross-sell", businessEvidenceRefs: ["b-1"] },
        ],
      };
    }
    if (payload.mode === "rescue_discovery") return { candidates: [] };
    if (payload.focusCandidate.candidateId === "activate-draft-products") {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayReadCall()] };
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "No draft products found.", candidateDisposition: "REJECTED" };
    }
    if (payload.focusCandidate.candidateId === "increase-basket-completion") {
      // This candidate itself judges the identical products query relevant to its own
      // basket-composition question and deliberately issues it again (gatewayReadCall() with the
      // same document+variables as candidate A). Gateway dedup should hand back ALREADY_AVAILABLE
      // rather than re-executing — a genuine, self-attempted, grounded read, not a freebie from an
      // unrelated candidate.
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayReadCall()] };
      return { status: "RECOMMEND_ACTION", recommendation: validRec({ diagnosedProblem: "Baskets are single-item; the same product catalog shows cross-sell room." }) };
    }
    throw new Error(`unexpected candidate ${payload.focusCandidate.candidateId}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider, { client: fakeShopifyClient(productsCallLog) }));

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  const secondCandidate = result.diagnostics.candidateQueue.find((c) => c.candidateId === "increase-basket-completion");
  assert.equal(secondCandidate.status, "RECOMMENDED");

  // Prove the ALREADY_AVAILABLE row is genuinely backed by a real prior successful execution, and
  // that candidate B's own turn is what surfaced it (not a bare assertion that the run "passed").
  assert.equal(productsCallLog.length, 1, "Shopify must be queried exactly once — candidate B's identical request should dedup, not re-execute");
  const freshReads = result.trace.toolResults.filter((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query && row.ok && row.facts?.status !== "ALREADY_AVAILABLE");
  const cachedReads = result.trace.toolResults.filter((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query && row.ok && row.facts?.status === "ALREADY_AVAILABLE");
  assert.equal(freshReads.length, 1, "candidate A's original call is the one and only fresh execution");
  assert.equal(cachedReads.length, 1, "candidate B's own turn produced exactly one ALREADY_AVAILABLE row, pointing back at that same execution");
});

test("cross-candidate evidence scope: a candidate that makes zero tool calls of its own cannot ride an unrelated candidate's read to RECOMMEND_ACTION", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          { candidateId: "cand-a", diagnosedProblem: "Are there draft products?", priority: 1, possibleIntervention: "x", businessEvidenceRefs: ["b-1"] },
          { candidateId: "cand-b", diagnosedProblem: "Are orders linked to customers?", priority: 2, possibleIntervention: "y", businessEvidenceRefs: ["b-1"] },
        ],
      };
    }
    if (payload.mode === "rescue_discovery") return { candidates: [] };
    if (payload.focusCandidate.candidateId === "cand-a") {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayReadCall()] };
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "A does not hold up.", candidateDisposition: "REJECTED" };
    }
    if (payload.focusCandidate.candidateId === "cand-b") {
      // B never calls shopify_query at all — it must not be able to conclude on the strength of
      // candidate A's unrelated products read still sitting in the shared history.
      return { status: "RECOMMEND_ACTION", recommendation: validRec({ diagnosedProblem: "Orders are not linked to customers." }) };
    }
    throw new Error(`unexpected candidate ${payload.focusCandidate.candidateId}`);
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.notEqual(result.status, "RECOMMEND_ACTION");
  const candidateB = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-b");
  assert.notEqual(candidateB.status, "RECOMMENDED");
});

// ---------------------------------------------------------------------------
// Part 3: "reduce-return-exposure" reproduction — a candidate whose own successful read is
// spread across multiple internal LLM/tool turns within one generateAgenticShopifyRecommendation
// call. The successful read must remain attributable to the candidate across all of its turns
// and satisfy validation, whether it's the first candidate in the run or inherits earlier
// (unrelated) history via initialToolResults.
// ---------------------------------------------------------------------------

function returnExposureReadCall() {
  return {
    tool: SHOPIFY_GATEWAY_TOOL.query,
    arguments: {
      document: 'query LiveReturnExposureProducts { products(first: 10, query: "tag:fragile") { edges { node { id title } } } }',
      variables: {},
    },
  };
}

function returnExposureRec(overrides = {}) {
  return validRec({
    title: "Reduce return exposure on fragile items",
    diagnosedProblem: "Fragile products have elevated return exposure.",
    mechanism: "productUpdate adds care instructions to the description.",
    whyThisAction: "Live read confirmed fragile-tagged products exist.",
    ...overrides,
  });
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

test("reduce-return-exposure shape: turn0 own LiveReturnExposureProducts read (FULL_SUCCESS) -> turn1 terminal RECOMMEND_ACTION, no prior history", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [returnExposureReadCall()] };
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
    focusCandidate: { candidateId: "reduce-return-exposure", diagnosedProblem: "Fragile products have elevated return exposure.", businessEvidenceRefs: ["b-1"] },
    initialToolResults: [],
  });

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  const readRows = result.trace.toolResults.filter((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query && row.ok);
  assert.equal(readRows.length, 1);
  assert.match(readRows[0].facts.document, /LiveReturnExposureProducts/);
});

test("reduce-return-exposure shape: candidate inherits an earlier, unrelated candidate's history, still passes on its own FULL_SUCCESS read, terminal BLOCKED", async () => {
  const inheritedHistory = [
    { tool: SHOPIFY_GATEWAY_TOOL.schema, ok: true, message: "schema", facts: { field: "Product.tags" }, error: null },
    {
      tool: SHOPIFY_GATEWAY_TOOL.query,
      ok: true,
      message: "prior candidate's own unrelated read",
      facts: { operation: "orders", classification: "FULL_SUCCESS", document: "query PriorCandidateOrders { orders(first: 5) { edges { node { id } } } }" },
      error: null,
    },
    {
      tool: "recommendation_validation",
      ok: false,
      message: "prior candidate rejected",
      facts: { errorCode: "NO_ACTIONABLE_OPPORTUNITY" },
      error: { code: "NO_ACTIONABLE_OPPORTUNITY", message: "prior candidate rejected" },
    },
  ];

  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [returnExposureReadCall()] };
    return { status: "BLOCKED", blocker: "No safe write path yet for fragile-item copy changes.", candidateDisposition: "BLOCKED" };
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
    focusCandidate: { candidateId: "reduce-return-exposure", diagnosedProblem: "Fragile products have elevated return exposure.", businessEvidenceRefs: ["b-1"] },
    initialToolResults: inheritedHistory,
  });

  assert.equal(result.status, "BLOCKED", `expected BLOCKED (a substantive judgement) but got ${result.status}: ${result.blocker}`);
  assert.notEqual(result.blocker, "Recommendation decisions require at least one successful Shopify read (shopify_query).");
  // The candidate's own read must land after ownResultsStartIndex (index 3, after the 3 inherited
  // rows) — prove it's genuinely attributable to this candidate, not the inherited history.
  const ownReadIndex = result.trace.toolResults.findIndex((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query && row.facts?.document?.includes("LiveReturnExposureProducts"));
  assert.ok(ownReadIndex >= inheritedHistory.length, `expected the candidate's own read at or after index ${inheritedHistory.length}, got ${ownReadIndex}`);
});
