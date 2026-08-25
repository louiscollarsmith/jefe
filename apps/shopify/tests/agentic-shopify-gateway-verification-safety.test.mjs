import assert from "node:assert/strict";
import test from "node:test";

import { runAgenticShopifyVerification } from "../app/lib/shopify/agentic-runtime/verification-agent.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// docs/ops/agentic-shopify-gateway-full/: proves verification's Gateway migration remains
// structurally read-only at the real call site, including when the model actively tries to defeat
// that boundary — not just in the standalone gateway module.

const merchantId = "00000000-0000-0000-0000-000000000041";
const shopId = "00000000-0000-0000-0000-000000000042";
const shopDomain = "jefe-gateway-verification-test.myshopify.com";
const quietLogger = { info() {}, warn() {}, error() {} };

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

function acceptedActionFixture() {
  return {
    id: "action-verify-1",
    merchantId,
    shopId,
    title: "Hide out-of-stock product",
    summary: "Hide product with zero inventory.",
    status: "accepted",
    progress: {
      agentic: {
        acceptedActionRevision: "rev-1",
        currentActionRevision: "rev-1",
        semanticAction: {
          revision: "rev-1",
          outcome: "Product gid://shopify/Product/1 is DRAFT.",
          verificationPlan: "Read the product back and confirm status is DRAFT.",
          eligibilityCriteria: [],
        },
      },
    },
  };
}

function fakePrisma() {
  return {
    merchantAction: { findFirst: async () => acceptedActionFixture(), updateMany: async () => ({ count: 1 }) },
    shopifyOperationCall: { findMany: async () => [] },
  };
}

test("gateway verification: mutation tools are never offered and are hard-denied if requested anyway", async () => {
  await withSurface("gateway", async () => {
    const provider = {
      enabled: true,
      provider: "test",
      model: "scripted",
      async generateStructuredJson() {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
                arguments: {
                  document: 'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }',
                  variables: { product: { id: "gid://shopify/Product/1", status: "ACTIVE" } },
                  idempotencyKey: "sneaky-1",
                },
              },
            ],
          },
        };
      },
    };
    const client = { async request() { throw new Error("Shopify client must never be called during verification"); } };
    const result = await runAgenticShopifyVerification({
      provider,
      prisma: fakePrisma(),
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: "action-verify-1",
      maxIterations: 2,
      logger: quietLogger,
    });
    assert.notEqual(result.status, "OUTCOME_ACHIEVED");
    // Verification's turn normalizer only recognizes shopify_schema/shopify_query — a
    // shopify_execute_mutation call is structurally indistinguishable from any other unrecognized
    // tool name and is dropped before it ever reaches a dispatcher, let alone the Shopify client.
    const mutationRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
    assert.equal(mutationRows.length, 0);
  });
});

test("gateway verification: a mutation-shaped document sent to shopify_query is rejected structurally, never reaches Shopify", async () => {
  await withSurface("gateway", async () => {
    let clientCalled = false;
    const provider = {
      enabled: true,
      provider: "test",
      model: "scripted",
      async generateStructuredJson({ prompt }) {
        const payload = JSON.parse(prompt);
        const alreadyTried = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
        if (alreadyTried) return { json: { status: "BLOCKED", blocker: "rejected_document" } };
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.query,
                arguments: {
                  document: 'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }',
                  variables: { product: { id: "gid://shopify/Product/1", status: "ACTIVE" } },
                },
              },
            ],
          },
        };
      },
    };
    const client = {
      async request() {
        clientCalled = true;
        return {};
      },
    };
    const result = await runAgenticShopifyVerification({
      provider,
      prisma: fakePrisma(),
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: "action-verify-1",
      maxIterations: 2,
      logger: quietLogger,
    });
    assert.notEqual(result.status, "OUTCOME_ACHIEVED");
    const queryRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
    assert.equal(queryRows.length, 1);
    assert.equal(queryRows[0].ok, false);
    assert.equal(queryRows[0].error.code, "SAFETY_OPERATION_KIND_MISMATCH");
    assert.equal(clientCalled, false);
  });
});

test("gateway verification: a real read confirming the outcome reaches OUTCOME_ACHIEVED", async () => {
  await withSurface("gateway", async () => {
    const provider = {
      enabled: true,
      provider: "test",
      model: "scripted",
      async generateStructuredJson({ prompt }) {
        const payload = JSON.parse(prompt);
        const read = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.ok);
        if (!read) {
          return {
            json: {
              status: "CONTINUE",
              toolCalls: [
                {
                  tool: SHOPIFY_GATEWAY_TOOL.query,
                  arguments: { document: "query($id: ID!) { product(id: $id) { id status } }", variables: { id: "gid://shopify/Product/1" } },
                },
              ],
            },
          };
        }
        return {
          json: {
            status: "OUTCOME_ACHIEVED",
            progressSummary: "Product confirmed DRAFT.",
            verification: { verified: true, evidence: ["product(gid://shopify/Product/1).status === DRAFT"], remaining: [] },
          },
        };
      },
    };
    const client = {
      async request(document) {
        if (document.includes("product(")) return { product: { id: "gid://shopify/Product/1", status: "DRAFT" } };
        return {};
      },
    };
    const result = await runAgenticShopifyVerification({
      provider,
      prisma: fakePrisma(),
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: "action-verify-1",
      logger: quietLogger,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "OUTCOME_ACHIEVED");
    assert.equal(result.trace.toolResults.some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.ok), true);
  });
});
