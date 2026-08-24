// @ts-check
//
// Shared, generalized fixture harness for controlled-domain recommendation tests (Task 3:
// "Build controlled domain fixtures"). Generalizes the exact pattern already proven in
// candidate-pipeline.test.mjs (scriptedProvider / fakeShopifyClient / candidateFixture /
// validRec) so multiple domain-fixture test files can share one implementation instead of
// each hand-rolling their own. Uses the real generated Shopify API catalog (loadShopifyApiCatalog)
// so "this domain can win" fixtures are checked against real, audited execution-status
// classifications — not a hand-authored toy catalog.

import { SHOPIFY_AGENT_TOOL } from "../../app/lib/shopify/agentic-runtime/tools.server.js";
import { loadShopifyApiCatalog } from "../../app/lib/shopify/api/catalog.server.js";

export const REAL_CATALOG = loadShopifyApiCatalog();

export const MERCHANT_ID = "00000000-0000-0000-0000-0000000000f1";
export const SHOP_ID = "00000000-0000-0000-0000-0000000000f2";

export const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * @param {(payload: any, calls: any[]) => any} router
 */
export function scriptedProvider(router) {
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

/**
 * @param {Record<string, unknown>} routes Map of a substring of the GraphQL document to the
 *   response to return when a request document contains it. Checked in insertion order.
 * @param {{ grantedScopes?: string[] }} [options] `grantedScopes` becomes the fake
 *   `currentAppInstallation.accessScopes` response — the gateway resolves execution
 *   authorization *live* from this call (never trusting a passed-in grantedScopes param; see
 *   gateway.server.js's resolveGatewayAuthorizationScopes), so a fixture that wants a
 *   non-product domain's reads/writes to be gateway-admitted must set this explicitly.
 */
export function fakeShopifyClient(routes = {}, options = {}) {
  const entries = Object.entries(routes);
  const grantedScopes = options.grantedScopes ?? ["read_products", "write_products"];
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return {
          currentAppInstallation: { accessScopes: grantedScopes.map((handle) => ({ handle })) },
        };
      }
      for (const [needle, response] of entries) {
        if (document.includes(needle)) return typeof response === "function" ? response(document) : response;
      }
      return {};
    },
  };
}

/**
 * @param {{ provider: any; snapshot: any; grantedScopes?: string[]; overrides?: Record<string, any> }} input
 */
export function baseInput({ provider, snapshot, grantedScopes = ["read_products", "write_products"], client, overrides = {} }) {
  return {
    provider,
    prisma: {
      shopifyOperationCall: { create: async () => ({}) },
      session: { findFirst: async () => ({ scope: grantedScopes.join(",") }) },
    },
    client: client ?? fakeShopifyClient({}, { grantedScopes }),
    merchantId: MERCHANT_ID,
    shopId: SHOP_ID,
    shopDomain: "jefe-fixture-store.myshopify.com",
    snapshot,
    grantedScopes,
    catalog: REAL_CATALOG,
    logger: quietLogger,
    perCandidateIterations: 4,
    ...overrides,
  };
}

/** @param {string} id @param {string} diagnosedProblem @param {number} priority @param {Record<string, any>} [extra] */
export function candidateFixture(id, diagnosedProblem, priority, extra = {}) {
  return {
    candidateId: id,
    diagnosedProblem,
    priority,
    businessEvidenceRefs: extra.businessEvidenceRefs ?? [],
    ...extra,
  };
}

/** @param {string} operation @param {Record<string, any>} [variables] */
export function readCall(operation, variables = { first: 5 }) {
  return { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation, variables, purpose: "Verify candidate against Shopify state." } };
}

/** @param {string} [query] */
export function retrieveCall(query = "operation") {
  return { tool: SHOPIFY_AGENT_TOOL.retrieveOperations, arguments: { query, limit: 5 } };
}

/**
 * A valid semantic recommendation. `feasibleWriteOperations` should be a real operation name
 * from REAL_CATALOG for domain fixtures (checked separately against the catalog's execution
 * status by the test, not by this schema validator).
 * @param {Record<string, any>} overrides
 */
export function validRec(overrides = {}) {
  return {
    title: "Fixture recommendation",
    summary: "Fixture summary.",
    outcome: "Fixture outcome.",
    scope: "Fixture scope.",
    constraints: [],
    eligibilityCriteria: [],
    materialExpectedEffects: ["Fixture effect."],
    diagnosedProblem: "Fixture diagnosed problem.",
    mechanism: "Fixture mechanism.",
    whyThisAction: "Fixture rationale.",
    whyNow: "Fixture urgency.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Fixture verification plan.",
    confidence: "strong",
    ...overrides,
  };
}

/** Candidate script helper: iteration 0 reads (or a custom tool call), iteration 1 concludes. */
export function investigate(conclusion, { toolCalls } = {}) {
  return (payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: toolCalls ?? [readCall("products")] };
    return conclusion;
  };
}

/** Look up an operation's real execution status/domain from the generated catalog. */
export function catalogOp(operationName) {
  return REAL_CATALOG.operations.find((op) => op.operation === operationName) ?? null;
}

/** True if the named operation is currently attemptable (EXECUTABLE / EXECUTABLE_WITH_CONFIRMATION) in the real catalog. */
export function isAttemptable(operationName) {
  const op = catalogOp(operationName);
  return op != null && ["EXECUTABLE", "EXECUTABLE_WITH_CONFIRMATION"].includes(op.execution?.status);
}
