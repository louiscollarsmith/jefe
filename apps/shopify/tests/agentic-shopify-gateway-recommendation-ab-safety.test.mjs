import assert from "node:assert/strict";
import test from "node:test";

import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";
import {
  scriptedProvider,
  fakeShopifyClient,
  baseInput,
  candidateFixture,
  validRec,
} from "./helpers/agentic-recommendation-fixtures.mjs";

// docs/ops/agentic-shopify-gateway-recommendation-ab/: proves the Gateway wiring into the real
// candidate-investigation call site (recommendation-agent.server.js) preserves every safety
// property already proven standalone in agentic-shopify-gateway-safety.test.mjs, at the actual
// integration layer that runs in production — not just in the gateway module in isolation.

/** @param {string} document @param {Record<string, any>} [variables] */
function gatewayQueryCall(document, variables = {}) {
  return { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document, variables } };
}

const VALID_PRODUCTS_QUERY = "query { products(first: 5) { edges { node { id title status } } } }";
const MUTATION_SHAPED_DOCUMENT =
  'mutation { productDelete(input: { id: "gid://shopify/Product/1" }) { deletedProductId userErrors { field message } } }';

async function withSurface(surface, fn) {
  const previous = process.env.SHOPIFY_AGENT_SURFACE;
  process.env.SHOPIFY_AGENT_SURFACE = surface;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SHOPIFY_AGENT_SURFACE;
    else process.env.SHOPIFY_AGENT_SURFACE = previous;
  }
}

test("gateway surface + focusCandidate: a real read through shopify_query reaches RECOMMEND_ACTION", async () => {
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayQueryCall(VALID_PRODUCTS_QUERY)] };
      return { status: "RECOMMEND_ACTION", recommendation: validRec() };
    });
    const input = baseInput({
      provider,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c1", "Draft product with inventory", 1) },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    assert.equal(result.status, "RECOMMEND_ACTION");
    const queryRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
    assert.equal(queryRows.length, 1);
    assert.equal(queryRows[0].ok, true);
    assert.equal(result.trace.toolResults.some((r) => r.tool === "call_shopify_operation"), false);
    // Regression guard: buildRecommendationDiagnostics must also recognize gateway reads — it was
    // found still hardcoded to the catalog tool names when first wired (docs/ops/
    // agentic-shopify-gateway-recommendation-ab/15-remaining-limitations.md #6), producing an
    // empty diagnostics.shopifyReads even when real reads happened.
    assert.equal(result.diagnostics.shopifyReads.length, 1);
    assert.equal(result.diagnostics.shopifyReads[0].ok, true);
  });
});

test("gateway is also applied to open-ended discovery (no focusCandidate) — docs/ops/agentic-shopify-gateway-full/ made Gateway universal, superseding the earlier focusCandidate-only scope restriction", async () => {
  // docs/ops/agentic-shopify-gateway-recommendation-ab/ originally scoped the Gateway wiring to
  // only the real candidate-investigation call site (focusCandidate present), leaving open-ended
  // discovery on the catalog surface deliberately, since it had zero production callers. The
  // catalog dispatcher was later removed entirely (docs/ops/agentic-shopify-gateway-full/), so
  // open-ended discovery now also runs on Gateway — there is no remaining catalog surface for it
  // to fall back to, regardless of focusCandidate.
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayQueryCall(VALID_PRODUCTS_QUERY)] };
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "test" };
    });
    const input = baseInput({ provider, snapshot: { beliefs: [] } }); // no focusCandidate override
    const result = await generateAgenticShopifyRecommendation(input);
    const queryRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
    assert.equal(queryRows.length, 1);
    assert.equal(queryRows[0].ok, true);
  });
});

test("gateway surface + focusCandidate: shopify_prepare_mutation and shopify_execute_mutation remain unavailable in recommendation mode", async () => {
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => {
      if (payload.iteration === 0) {
        return {
          status: "CONTINUE",
          toolCalls: [
            { tool: SHOPIFY_GATEWAY_TOOL.prepareMutation, arguments: { document: MUTATION_SHAPED_DOCUMENT } },
            { tool: SHOPIFY_GATEWAY_TOOL.executeMutation, arguments: { document: MUTATION_SHAPED_DOCUMENT, idempotencyKey: "k1" } },
          ],
        };
      }
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "mutation tools unavailable", candidateDisposition: "NON_EXECUTABLE" };
    });
    const input = baseInput({
      provider,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c2", "Delete a stale product", 1) },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    const prepareRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.prepareMutation);
    const executeRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
    assert.equal(prepareRows.length, 1);
    assert.equal(prepareRows[0].ok, false);
    assert.equal(prepareRows[0].error.code, "MUTATION_TOOL_UNAVAILABLE");
    assert.equal(executeRows.length, 1);
    assert.equal(executeRows[0].ok, false);
    assert.equal(executeRows[0].error.code, "MUTATION_TOOL_UNAVAILABLE");
  });
});

test("gateway surface + focusCandidate: a mutation-shaped document sent to shopify_query is rejected structurally, never reaches Shopify", async () => {
  await withSurface("gateway", async () => {
    let clientCalled = false;
    const client = {
      async request(document) {
        clientCalled = true;
        return { products: { edges: [] } };
      },
    };
    const provider = scriptedProvider((payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayQueryCall(MUTATION_SHAPED_DOCUMENT)] };
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "could not read Shopify state", candidateDisposition: "BLOCKED_BY_EVIDENCE" };
    });
    const input = baseInput({
      provider,
      client,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c3", "Delete a stale product", 1) },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    const queryRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
    assert.equal(queryRows.length, 1);
    assert.equal(queryRows[0].ok, false);
    assert.equal(queryRows[0].error.code, "SAFETY_OPERATION_KIND_MISMATCH");
    assert.equal(clientCalled, false, "the mutation document must never reach the Shopify client");
    assert.notEqual(result.status, "RECOMMEND_ACTION");
  });
});

test("gateway surface + focusCandidate: schema lookup is optional — a read alone is sufficient to reach RECOMMEND_ACTION", async () => {
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => {
      // No shopify_schema call anywhere in this script — straight to a valid read.
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayQueryCall(VALID_PRODUCTS_QUERY)] };
      return { status: "RECOMMEND_ACTION", recommendation: validRec() };
    });
    const input = baseInput({
      provider,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c4", "Draft product with inventory", 1) },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    assert.equal(result.status, "RECOMMEND_ACTION");
    assert.equal(result.trace.toolResults.some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.schema), false);
  });
});

test("gateway surface + focusCandidate: RECOMMEND_ACTION with zero successful reads is still rejected (INSUFFICIENT_INVESTIGATION)", async () => {
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => ({ status: "RECOMMEND_ACTION", recommendation: validRec() }));
    const input = baseInput({
      provider,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c5", "Draft product with inventory", 1), maxIterations: 2 },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    assert.notEqual(result.status, "RECOMMEND_ACTION");
    assert.equal(
      result.trace.toolResults.some((r) => r.tool === "recommendation_validation" && r.error?.code === "INSUFFICIENT_INVESTIGATION"),
      true,
    );
  });
});

test("gateway surface + focusCandidate: a real read followed by a genuine NO_ACTIONABLE_OPPORTUNITY is accepted, not misreported as insufficient investigation", async () => {
  // Regression test for a real bug found during the live A/B run (docs/ops/
  // agentic-shopify-gateway-recommendation-ab/): the NO_ACTIONABLE_OPPORTUNITY and BLOCKED
  // branches each call validateInvestigation independently of the RECOMMEND_ACTION branch, and
  // both were still hardcoded to the catalog tool names — so a gateway-mode candidate with a real
  // successful shopify_query read was still rejected as INSUFFICIENT_INVESTIGATION whenever the
  // model concluded NO_ACTIONABLE_OPPORTUNITY or BLOCKED instead of RECOMMEND_ACTION.
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayQueryCall(VALID_PRODUCTS_QUERY)] };
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Shopify state disproves the premise.", candidateDisposition: "REJECTED" };
    });
    const input = baseInput({
      provider,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c7", "Draft product with inventory", 1) },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    assert.equal(result.status, "NO_ACTIONABLE_OPPORTUNITY");
    assert.equal(
      result.trace.toolResults.some((r) => r.tool === "recommendation_validation" && r.error?.code === "INSUFFICIENT_INVESTIGATION"),
      false,
    );
  });
});

test("gateway surface + focusCandidate: a real read followed by BLOCKED is accepted, not misreported as insufficient investigation", async () => {
  await withSurface("gateway", async () => {
    const provider = scriptedProvider((payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [gatewayQueryCall(VALID_PRODUCTS_QUERY)] };
      return { status: "BLOCKED", blocker: "Missing cost data.", candidateDisposition: "BLOCKED_BY_EVIDENCE" };
    });
    const input = baseInput({
      provider,
      snapshot: { beliefs: [] },
      overrides: { focusCandidate: candidateFixture("c8", "Draft product with inventory", 1) },
    });
    const result = await generateAgenticShopifyRecommendation(input);
    assert.equal(result.status, "BLOCKED");
    assert.equal(
      result.trace.toolResults.some((r) => r.tool === "recommendation_validation" && r.error?.code === "INSUFFICIENT_INVESTIGATION"),
      false,
    );
  });
});
