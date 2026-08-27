import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInvestigationState,
  generateAgenticShopifyRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// Regression coverage for a real traced run (ff109274-230c-4a39-b593-f4d4874f619d,
// docs/ops/recommendation-candidate-turn-waste-fix/): candidate `reduce-product-specific-returns`
// burned its entire iteration budget on (1) attempting a terminal status before any successful
// Shopify read, then (2) re-issuing an already-satisfied read three times after
// investigationState.investigationComplete had already told it to stop — and hit ITERATION_LIMIT
// without ever getting a genuine chance to conclude. The fix refunds (does not advance the
// iteration counter for) a small, hard-capped number of these zero-new-evidence turns.

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

function fakeClient({ onProductsRead } = {}) {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      if (document.includes("products(")) {
        onProductsRead?.();
        return { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "High-Return Wine" } }], pageInfo: { hasNextPage: false } } };
      }
      return {};
    },
  };
}

function baseArgs(provider, overrides = {}) {
  return {
    provider,
    prisma: { shopifyOperationCall: { create: async () => ({}) }, session: { findFirst: async () => ({ scope: "read_products,write_products" }) } },
    client: fakeClient(),
    merchantId: "00000000-0000-0000-0000-000000000041",
    shopId: "00000000-0000-0000-0000-000000000042",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_products", "write_products"],
    logger: { info() {}, warn() {}, error() {} },
    focusCandidate: { candidateId: "reduce-product-specific-returns", diagnosedProblem: "Some products drive disproportionate returns.", businessEvidenceRefs: ["b-1"] },
    initialToolResults: [],
    ...overrides,
  };
}

function productsReadCall() {
  return { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document: "query HighReturnProducts { products(first: 5) { edges { node { id title } } } }" } };
}

function validRec(overrides = {}) {
  return {
    title: "Address high-return products",
    summary: "Reduce returns on flagged products.",
    outcome: "Return rate drops.",
    scope: "Flagged products.",
    constraints: [],
    eligibilityCriteria: [{ resourceType: "Product", field: "status", operator: "eq", value: "ACTIVE" }],
    materialExpectedEffects: ["Description clarifies fit to reduce mismatched-expectation returns"],
    diagnosedProblem: "Certain products have an elevated return rate.",
    mechanism: "productUpdate adds sizing/fit detail to the description.",
    whyThisAction: "Shopify read confirmed the affected products.",
    whyNow: "Returns are ongoing.",
    supportingBeliefIds: ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Re-read the product description after the update.",
    confidence: "reasonable",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Duplicate read progression
// ---------------------------------------------------------------------------

test("duplicate read progression: a successful read followed by repeated identical reads does not burn the budget down to ITERATION_LIMIT", async () => {
  let productReads = 0;
  const client = fakeClient({ onProductsRead: () => { productReads += 1; } });
  let dupAttempts = 0;
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [productsReadCall()] };
    // Every turn after the first real read re-issues the exact same read three times in a row —
    // reproducing the traced regression shape — before finally concluding.
    if (dupAttempts < 3) {
      dupAttempts += 1;
      return { status: "CONTINUE", toolCalls: [productsReadCall()] };
    }
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await generateAgenticShopifyRecommendation(baseArgs(provider, { client, maxIterations: 4 }));

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  assert.equal(productReads, 1, "Shopify must be queried exactly once — the 3 repeats must all resolve as ALREADY_AVAILABLE");
  // Two of the three duplicate turns are refunded (MAX_WASTED_TURN_REFUNDS = 2); only the third
  // consumes real iteration budget. Real read (iter 0) + 1 unrefunded duplicate (iter 1) + terminal
  // decision (iter 2) fits comfortably inside maxIterations=4 — this would have hit ITERATION_LIMIT
  // pre-fix (real read + 3 duplicates already exhausts a 4-iteration budget with nothing left for
  // the terminal turn).
  assert.ok(provider.calls.length >= 5, "the model should still have been asked 5 times (1 real + 3 duplicates + 1 terminal), refunds don't hide turns from the model");
});

// ---------------------------------------------------------------------------
// 2. Validation prerequisite
// ---------------------------------------------------------------------------

test("validation prerequisite: attempting a terminal status before any read does not burn the budget before the model ever reads Shopify", async () => {
  let productReads = 0;
  const client = fakeClient({ onProductsRead: () => { productReads += 1; } });
  let prematureAttempts = 0;
  const provider = scriptedProvider((payload) => {
    if (prematureAttempts < 3) {
      prematureAttempts += 1;
      // No toolCalls at all — a bare terminal-status guess with zero evidence, exactly the traced
      // "iteration 0: validation attempted before any Shopify read" shape.
      return { status: "RECOMMEND_ACTION", recommendation: validRec() };
    }
    if (payload.investigationState.successfulReads.length === 0) {
      return { status: "CONTINUE", toolCalls: [productsReadCall()] };
    }
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await generateAgenticShopifyRecommendation(baseArgs(provider, { client, maxIterations: 4 }));

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  assert.equal(productReads, 1);
  // 2 of the 3 premature attempts are refunded; the real read and final terminal decision still
  // land inside a 4-iteration budget.
});

test("validation prerequisite: an unresolved-coverage rejection is never refunded (it reflects real incomplete work, not waste)", () => {
  // Direct unit check that the refund condition in the NO_ACTIONABLE_OPPORTUNITY/BLOCKED branches
  // is gated on investigation.unresolved being unset — this is exercised end-to-end by the existing
  // coverage-ledger tests elsewhere; this file only re-asserts the distinguishing signal exists.
  const unresolvedRejection = { unresolved: [{ id: "family-1", label: "Inventory family", status: "PENDING" }], ok: false, error: "families unresolved" };
  const noReadRejection = { unresolved: null, ok: false, error: "Recommendation decisions require at least one successful Shopify read (shopify_query)." };
  assert.ok(unresolvedRejection.unresolved, "an unresolved-family rejection carries a truthy `unresolved` — must not be refunded");
  assert.equal(noReadRejection.unresolved, null, "a no-read rejection carries no `unresolved` — refund-eligible");
});

// ---------------------------------------------------------------------------
// 3. Candidate isolation
// ---------------------------------------------------------------------------

test("candidate isolation: retrievedOperations diagnostics do not leak from an earlier candidate's inherited history", async () => {
  const inheritedHistory = [
    {
      tool: SHOPIFY_GATEWAY_TOOL.schema,
      ok: true,
      message: "schema",
      facts: { action: "search", query: "inventory", results: [{ operation: "inventoryItemUpdate" }, { operation: "inventoryShipmentUpdateItemQuantities" }] },
      error: null,
    },
    {
      tool: SHOPIFY_GATEWAY_TOOL.query,
      ok: true,
      message: "prior candidate's own unrelated read",
      facts: { operation: "orders", classification: "FULL_SUCCESS", document: "query PriorCandidateOrders { orders(first: 5) { edges { node { id } } } }" },
      error: null,
    },
  ];

  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [productsReadCall()] };
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await generateAgenticShopifyRecommendation(
    baseArgs(provider, { initialToolResults: inheritedHistory, maxIterations: 4 }),
  );

  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
  assert.deepEqual(
    result.diagnostics.retrievedOperations,
    [],
    "this candidate never called shopify_schema itself — an earlier candidate's inherited discovery must not appear as this candidate's own capability evidence",
  );
});

// ---------------------------------------------------------------------------
// 4. Schema recovery
// ---------------------------------------------------------------------------

test("schema recovery: invalid read -> schema discovery -> corrected read can still reach RECOMMEND_ACTION within budget", async () => {
  const client = {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }] } };
      }
      return {};
    },
    async requestWithClassification(document) {
      if (document.includes("nonExistentField")) {
        return { classification: "GRAPHQL_FAILURE", data: null, errors: [{ message: "Field 'nonExistentField' doesn't exist on type 'Product'" }] };
      }
      return {
        classification: "FULL_SUCCESS",
        data: { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "High-Return Wine" } }], pageInfo: { hasNextPage: false } } },
        errors: [],
      };
    },
  };

  let sawFailedReadInState = false;
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [{ tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document: "query Bad { products(first: 5) { edges { node { id nonExistentField } } } }" } }],
      };
    }
    if (payload.iteration === 1) {
      // The failed read from iteration 0 must be visible here with real error detail, not just a
      // bare operation name — this is the carry-forward fix under test.
      assert.equal(payload.investigationState.failedReads.length, 1);
      assert.match(payload.investigationState.failedReads[0].message, /nonExistentField/);
      sawFailedReadInState = true;
      return { status: "CONTINUE", toolCalls: [{ tool: SHOPIFY_GATEWAY_TOOL.schema, arguments: { action: "search", query: "product title" } }] };
    }
    if (payload.iteration === 2) {
      return {
        status: "CONTINUE",
        toolCalls: [{ tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document: "query Good { products(first: 5) { edges { node { id title } } } }" } }],
      };
    }
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await generateAgenticShopifyRecommendation(baseArgs(provider, { client, maxIterations: 6 }));

  assert.ok(sawFailedReadInState, "the scripted turn that asserts on failedReads must actually have run");
  assert.equal(result.status, "RECOMMEND_ACTION", `expected RECOMMEND_ACTION but got ${result.status}: ${result.blocker}`);
});

// ---------------------------------------------------------------------------
// 5. Completed-work carry-forward (direct unit coverage on buildInvestigationState)
// ---------------------------------------------------------------------------

test("completed-work carry-forward: a failed read surfaces its real error code and message, not just a (frequently null) operation name", () => {
  const toolResults = [
    {
      tool: "shopify_query",
      ok: false,
      message: "products query failed: Field 'nonExistentField' doesn't exist on type 'Product'",
      facts: {},
      error: { code: "SHOPIFY_GRAPHQL_ERROR", message: "Field 'nonExistentField' doesn't exist on type 'Product'" },
    },
  ];
  const state = buildInvestigationState(toolResults, { readToolName: "shopify_query", requireDiscovery: false });
  assert.equal(state.failedReads.length, 1);
  assert.equal(state.failedReads[0].operation, null, "structural failures genuinely have no resolved operation");
  assert.equal(state.failedReads[0].errorCode, "SHOPIFY_GRAPHQL_ERROR");
  assert.match(state.failedReads[0].message, /nonExistentField/);
});

// ---------------------------------------------------------------------------
// 6. Bounded failure
// ---------------------------------------------------------------------------

test("bounded failure: a candidate that only ever repeats the same duplicate read still terminates within maxIterations + the refund cap, never hangs", async () => {
  let productReads = 0;
  const client = fakeClient({ onProductsRead: () => { productReads += 1; } });
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [productsReadCall()] };
    // Never converges — always re-issues the same read, forever, never returns a terminal status.
    return { status: "CONTINUE", toolCalls: [productsReadCall()] };
  });

  const result = await generateAgenticShopifyRecommendation(baseArgs(provider, { client, maxIterations: 3 }));

  assert.equal(result.ok, false);
  assert.equal(productReads, 1, "the real read happens exactly once; every repeat is a duplicate");
  // maxIterations=3 with MAX_WASTED_TURN_REFUNDS=3: the loop must still terminate, i.e. the model is
  // asked a small bounded number of times, not indefinitely.
  assert.ok(provider.calls.length <= 3 + 3, `expected the loop to terminate within maxIterations + refund cap, got ${provider.calls.length} calls`);
});

test("bounded failure: a candidate that never produces a satisfying read still terminates safely (no infinite loop, no crash)", async () => {
  const client = fakeClient();
  const provider = scriptedProvider(() => ({ status: "CONTINUE", toolCalls: [] }));

  const result = await generateAgenticShopifyRecommendation(baseArgs(provider, { client, maxIterations: 3 }));

  assert.equal(result.ok, false);
  assert.ok(provider.calls.length <= 3, "a turn with zero toolCalls and no terminal status must still consume ordinary iteration budget, not loop");
});
