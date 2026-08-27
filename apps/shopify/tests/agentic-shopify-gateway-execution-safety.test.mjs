import assert from "node:assert/strict";
import test from "node:test";

import { runAgenticShopifyExecution } from "../app/lib/shopify/agentic-runtime/execution-agent.server.js";
import {
  acceptAgenticShopifyAction,
  materializeAgenticShopifyAction,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// docs/ops/agentic-shopify-gateway-full/: proves the execution-agent's Gateway migration reuses
// the real production accepted-Action/revision/idempotency/ledger pipeline unchanged, and that
// generic write safety (idempotency required, must select userErrors, structural GraphQL
// validation) holds at this real call site — not just in the standalone gateway module.

const merchantId = "00000000-0000-0000-0000-000000000031";
const shopId = "00000000-0000-0000-0000-000000000032";
const shopDomain = "jefe-gateway-execution-test.myshopify.com";

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

function hideProductsRecommendation() {
  return {
    title: "Hide out-of-stock product",
    summary: "Hide a product to prevent customers seeing an out-of-stock item.",
    outcome: "The out-of-stock product is hidden from the storefront.",
    scope: "One active product with zero inventory.",
    constraints: ["Do not change prices."],
    materialExpectedEffects: ["Set product status to DRAFT."],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Read the product back and confirm status is DRAFT.",
    reversalStrategy: "Fixture reversal strategy.",
    whyThisAction: "Out-of-stock product visible on storefront.",
    whyNow: "Product found with zero inventory.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    confidence: "high",
  };
}

async function setupAcceptedAction(prisma) {
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });
  return prisma.actions[0];
}

/** A gateway provider that writes a valid productUpdate mutation, then signals WRITES_COMPLETE. */
function gatewayMutationProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const executed = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation && r.ok);
      if (!executed) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
                arguments: {
                  document:
                    'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
                  variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                  purpose: "Hide the out-of-stock product.",
                  expectedEffect: "Set product status to DRAFT.",
                  idempotencyKey: "hide-product-1-gateway",
                },
              },
            ],
          },
        };
      }
      return { json: { status: "WRITES_COMPLETE", progressSummary: "Product mutation issued." } };
    },
  };
}

/** A gateway provider that tries to skip idempotencyKey, then stops (does not retry). */
function gatewayMissingIdempotencyProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const alreadyTried = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
      if (alreadyTried) return { json: { status: "BLOCKED", blocker: "missing_idempotency_key" } };
      return {
        json: {
          status: "CONTINUE",
          toolCalls: [
            {
              tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
              arguments: {
                document:
                  'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
                variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                purpose: "Hide the out-of-stock product.",
                expectedEffect: "Set product status to DRAFT.",
              },
            },
          ],
        },
      };
    },
  };
}

/** A gateway provider that attempts a mutation-shaped document with no userErrors selection, then stops. */
function gatewayMissingUserErrorsProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const alreadyTried = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
      if (alreadyTried) return { json: { status: "BLOCKED", blocker: "missing_user_errors_selection" } };
      return {
        json: {
          status: "CONTINUE",
          toolCalls: [
            {
              tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
              arguments: {
                document: 'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } } }',
                variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                purpose: "Hide the out-of-stock product.",
                expectedEffect: "Set product status to DRAFT.",
                idempotencyKey: "hide-product-2-gateway",
              },
            },
          ],
        },
      };
    },
  };
}

function fakeShopifyClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      if (document.includes("productUpdate")) {
        return { productUpdate: { product: { id: "gid://shopify/Product/1", status: "DRAFT" }, userErrors: [] } };
      }
      return {};
    },
  };
}

function fakePrisma() {
  const prisma = {
    actions: [],
    events: [],
    operationCalls: [],
    $transaction: async (run) => run(prisma),
    merchantAction: {
      create: async ({ data }) => {
        const row = { id: `action-${prisma.actions.length + 1}`, ...data, createdAt: new Date(), updatedAt: new Date() };
        prisma.actions.push(row);
        return row;
      },
      findFirst: async ({ where }) =>
        prisma.actions.find(
          (row) => (!where.id || row.id === where.id) && (!where.merchantId || row.merchantId === where.merchantId) && (!where.shopId || row.shopId === where.shopId),
        ) ?? null,
      update: async ({ where, data }) => {
        const row = prisma.actions.find((item) => item.id === where.id);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row ?? null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of prisma.actions) {
          if ((!where.id || row.id === where.id) && (!where.merchantId || row.merchantId === where.merchantId) && (!where.shopId || row.shopId === where.shopId)) {
            Object.assign(row, data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        prisma.events.push(data);
        return data;
      },
      findMany: async () => prisma.events,
    },
    shopifyOperationCall: {
      create: async ({ data }) => {
        const row = { id: `op-${prisma.operationCalls.length + 1}`, ...data, createdAt: new Date() };
        prisma.operationCalls.push(row);
        return row;
      },
      findFirst: async ({ where }) =>
        [...prisma.operationCalls]
          .reverse()
          .find(
            (row) =>
              row.merchantId === where.merchantId &&
              row.shopId === where.shopId &&
              row.idempotencyKey === where.idempotencyKey &&
              row.operationName === where.operationName,
          ) ?? null,
    },
    session: { findFirst: async () => ({ scope: "read_products,write_products" }) },
  };
  return prisma;
}

const quietLogger = { info() {}, warn() {}, error() {} };

test("gateway execution: a valid mutation with idempotencyKey and userErrors reaches WRITES_COMPLETE through the real accepted-Action pipeline", async () => {
  await withSurface("gateway", async () => {
    const prisma = fakePrisma();
    const action = await setupAcceptedAction(prisma);
    const result = await runAgenticShopifyExecution({
      provider: gatewayMutationProvider(),
      prisma,
      client: fakeShopifyClient(),
      merchantId,
      shopId,
      shopDomain,
      actionId: action.id,
      grantedScopes: ["read_products", "write_products"],
      logger: quietLogger,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "WRITES_COMPLETE");
    assert.equal(result.wroteToShopify, true);
    const executeRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
    assert.equal(executeRows.length, 1);
    assert.equal(executeRows[0].ok, true);
    // Real ledger row was written by the shared gateway.server.js pipeline, unmodified.
    assert.equal(prisma.operationCalls.some((r) => r.operationKind === "MUTATION" && r.status === "OK"), true);
  });
});

test("gateway execution: WRITES_COMPLETE is rejected when the mutation actually failed — found via a real golden-path run", async () => {
  await withSurface("gateway", async () => {
    const prisma = fakePrisma();
    const action = await setupAcceptedAction(prisma);
    // Client whose mutation always errors — simulates the real PROVIDER_ERROR observed in
    // docs/ops/agentic-shopify-gateway-full/real-dev-store-golden-path-trace.json.
    const client = {
      async request(document) {
        if (document.includes("currentAppInstallation")) {
          return { currentAppInstallation: { accessScopes: [{ handle: "write_products" }] } };
        }
        if (document.includes("productUpdate")) {
          throw new Error("Shopify GraphQL response errors");
        }
        return {};
      },
    };
    let sawValidationError = false;
    const provider = {
      enabled: true,
      provider: "test",
      model: "scripted",
      async generateStructuredJson({ prompt }) {
        const payload = JSON.parse(prompt);
        const validationError = (payload.toolResults ?? []).find(
          (r) => r.tool === "execution_validation" && r.error?.code === "WRITES_COMPLETE_WITHOUT_SUCCESSFUL_WRITE",
        );
        if (validationError) {
          sawValidationError = true;
          // Model gives up after seeing the correction rather than looping forever.
          return { json: { status: "BLOCKED", blocker: "mutation kept failing" } };
        }
        const attempted = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
        if (!attempted) {
          return {
            json: {
              status: "CONTINUE",
              toolCalls: [
                {
                  tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
                  arguments: {
                    document:
                      'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
                    variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                    purpose: "Hide the out-of-stock product.",
                    expectedEffect: "Set product status to DRAFT.",
                    idempotencyKey: "hide-product-fails-then-claims-done",
                  },
                },
              ],
            },
          };
        }
        // This is the real observed behaviour: the model claims WRITES_COMPLETE right after its
        // own mutation attempt failed, without having retried or acknowledged the failure.
        return { json: { status: "WRITES_COMPLETE", progressSummary: "Product mutation issued." } };
      },
    };
    const result = await runAgenticShopifyExecution({
      provider,
      prisma,
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: action.id,
      grantedScopes: ["read_products", "write_products"],
      maxIterations: 4,
      logger: quietLogger,
    });
    assert.equal(sawValidationError, true, "the false WRITES_COMPLETE claim must be caught and fed back to the model");
    assert.notEqual(result.status, "WRITES_COMPLETE");
    assert.equal(Boolean(result.wroteToShopify), false);
  });
});

test("gateway execution: a real Shopify GraphQL error's specific detail reaches the agent, not a generic message — found via the same real golden-path run", async () => {
  await withSurface("gateway", async () => {
    const prisma = fakePrisma();
    const action = await setupAcceptedAction(prisma);
    const client = {
      async request(document) {
        if (document.includes("currentAppInstallation")) {
          return { currentAppInstallation: { accessScopes: [{ handle: "write_products" }] } };
        }
        if (document.includes("productUpdate")) {
          const error = new Error("Shopify GraphQL response errors");
          error.errors = [
            {
              message: "Field 'code' doesn't exist on type 'UserError'",
              path: ["mutation", "productUpdate", "userErrors", "code"],
              extensions: { code: "undefinedField" },
            },
          ];
          throw error;
        }
        return {};
      },
    };
    let executeResult = null;
    const provider = {
      enabled: true,
      provider: "test",
      model: "scripted",
      async generateStructuredJson({ prompt }) {
        const payload = JSON.parse(prompt);
        const attempted = (payload.toolResults ?? []).some((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
        if (attempted) return { json: { status: "BLOCKED", blocker: "stop after seeing the real error" } };
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
                arguments: {
                  document:
                    'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message code } } }',
                  variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                  purpose: "x",
                  expectedEffect: "x",
                  idempotencyKey: "k1",
                },
              },
            ],
          },
        };
      },
    };
    const result = await runAgenticShopifyExecution({
      provider,
      prisma,
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: action.id,
      grantedScopes: ["read_products", "write_products"],
      maxIterations: 2,
      logger: quietLogger,
    });
    executeResult = result.trace.toolResults.find((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
    assert.equal(executeResult.ok, false);
    assert.match(executeResult.error.message, /Field 'code' doesn't exist on type 'UserError'/);
  });
});

test("gateway execution: a mutation without an idempotencyKey is refused before it can reach Shopify", async () => {
  await withSurface("gateway", async () => {
    const prisma = fakePrisma();
    const action = await setupAcceptedAction(prisma);
    let clientCalled = false;
    const client = {
      async request(document) {
        if (document.includes("currentAppInstallation")) {
          return { currentAppInstallation: { accessScopes: [{ handle: "write_products" }] } };
        }
        clientCalled = true;
        return {};
      },
    };
    const result = await runAgenticShopifyExecution({
      provider: gatewayMissingIdempotencyProvider(),
      prisma,
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: action.id,
      grantedScopes: ["read_products", "write_products"],
      maxIterations: 2,
      logger: quietLogger,
    });
    assert.notEqual(result.status, "WRITES_COMPLETE");
    const executeRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
    assert.equal(executeRows.length, 1);
    assert.equal(executeRows[0].ok, false);
    assert.equal(executeRows[0].error.code, "MISSING_IDEMPOTENCY_KEY");
    assert.equal(clientCalled, false, "no mutation request should ever reach the Shopify client without an idempotency key");
  });
});

test("gateway execution: a mutation that omits userErrors is rejected before it can reach Shopify", async () => {
  await withSurface("gateway", async () => {
    const prisma = fakePrisma();
    const action = await setupAcceptedAction(prisma);
    let clientCalled = false;
    const client = {
      async request(document) {
        if (document.includes("currentAppInstallation")) {
          return { currentAppInstallation: { accessScopes: [{ handle: "write_products" }] } };
        }
        clientCalled = true;
        return {};
      },
    };
    const result = await runAgenticShopifyExecution({
      provider: gatewayMissingUserErrorsProvider(),
      prisma,
      client,
      merchantId,
      shopId,
      shopDomain,
      actionId: action.id,
      grantedScopes: ["read_products", "write_products"],
      maxIterations: 2,
      logger: quietLogger,
    });
    assert.notEqual(result.status, "WRITES_COMPLETE");
    const executeRows = result.trace.toolResults.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
    assert.equal(executeRows.length, 1);
    assert.equal(executeRows[0].ok, false);
    assert.equal(executeRows[0].error.code, "MUTATION_MUST_SELECT_USER_ERRORS");
    assert.equal(clientCalled, false);
  });
});

test("gateway execution: a mutation without an accepted Action revision is refused (unaccepted action cannot mutate)", async () => {
  await withSurface("gateway", async () => {
    const prisma = fakePrisma();
    // materialize but do NOT accept
    const { action } = await materializeAgenticShopifyAction(prisma, { merchantId, shopId, recommendation: hideProductsRecommendation() });
    const result = await runAgenticShopifyExecution({
      provider: gatewayMutationProvider(),
      prisma,
      client: fakeShopifyClient(),
      merchantId,
      shopId,
      shopDomain,
      actionId: action.id,
      grantedScopes: ["read_products", "write_products"],
      logger: quietLogger,
    });
    // runAgenticShopifyExecution itself refuses to start without an accepted+current revision.
    assert.equal(result.ok, false);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.blocker, "accepted_action_revision_missing_or_stale");
  });
});
