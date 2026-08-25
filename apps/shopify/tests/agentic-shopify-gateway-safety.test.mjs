import assert from "node:assert/strict";
import test from "node:test";

import { analyzeGatewayDocument, GATEWAY_MODE } from "../app/lib/shopify/gateway/document.server.js";
import { buildSyntheticGatewayStub } from "../app/lib/shopify/gateway/synthetic-stub.server.js";
import { loadGatewaySchemaIndex } from "../app/lib/shopify/gateway/schema-index.server.js";
import { runShopifyGatewayTool, SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// Part 12 of docs/ops/agentic-shopify-gateway/: prove recommendation/verification-mode agents
// cannot mutate Shopify even when the model actively tries to defeat the boundary. Every case here
// asserts REJECTION comes from parsed GraphQL structure (analyzeGatewayDocument's AST checks),
// never from trusting an operation name or the model's own claim about what it's doing.

const index = loadGatewaySchemaIndex();

function analyzeQuery(documentText, variables) {
  return analyzeGatewayDocument({ documentText, mode: GATEWAY_MODE.queryOnly, variables, schemaIndex: index });
}
function analyzeMutation(documentText, variables) {
  return analyzeGatewayDocument({ documentText, mode: GATEWAY_MODE.mutationOnly, variables, schemaIndex: index });
}

test("shopify_query rejects an explicit mutation document", () => {
  const result = analyzeQuery(
    'mutation { productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId userErrors { field message } } }',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SAFETY_OPERATION_KIND_MISMATCH");
});

test("shopify_query rejects an aliased mutation — aliasing the operation does not change its GraphQL operation type", () => {
  const result = analyzeQuery(
    'mutation Reads { productDelete(input: {id: "1"}) { deletedProductId userErrors { field message } } }',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SAFETY_OPERATION_KIND_MISMATCH");
});

test("rejects multiple operations in one document (query+mutation together)", () => {
  const result = analyzeQuery(
    'query { shop { id } } mutation { productDelete(input: {id: "1"}) { deletedProductId userErrors { field message } } }',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "MULTIPLE_OPERATIONS_IN_DOCUMENT");
});

test("rejects a named fragment used to indirect a mutation selection", () => {
  const result = analyzeMutation(
    "mutation { ...F } fragment F on Mutation { productDelete(input: {id: \"1\"}) { deletedProductId userErrors { field message } } }",
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "FRAGMENTS_NOT_SUPPORTED");
});

test("rejects an inline fragment at the operation root", () => {
  const result = analyzeMutation(
    'mutation { ... on Mutation { productDelete(input: {id: "1"}) { deletedProductId userErrors { field message } } } }',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "INLINE_FRAGMENT_NOT_SUPPORTED");
});

test("rejects a second root mutation field smuggled alongside a reviewed one", () => {
  const result = analyzeMutation(
    'mutation { a: productUpdate(input: {id: "1"}) { userErrors { field message } } b: collectionDelete(input: {id: "2"}) { deletedCollectionId userErrors { field message } } }',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "MULTIPLE_ROOT_MUTATION_FIELDS");
});

test("rejects malformed GraphQL intended to defeat the parser", () => {
  const result = analyzeQuery("query { products( { }");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GRAPHQL_SYNTAX_ERROR");
});

test("allows introspection through the query tool (it is schema-shaped, not a mutation)", () => {
  const result = analyzeQuery("query { __schema { queryType { name } } }");
  assert.equal(result.ok, true);
  assert.equal(result.operationKind, "QUERY");
});

test("rejects a mutation-typed field wrapped as a query even though its name reads like a query", () => {
  // bulkOperationRunQuery is, per Shopify's real schema, a MUTATION root field despite the name —
  // proves classification never trusts operation-name shape, only the parsed AST operation tag.
  const result = analyzeQuery(
    'mutation { bulkOperationRunQuery(query: "{ products { edges { node { id } } } }") { bulkOperation { id } userErrors { field message } } }',
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SAFETY_OPERATION_KIND_MISMATCH");
});

test("rejects an unsupported/unknown directive", () => {
  const result = analyzeQuery("query { products(first: 1) @exfiltrate { edges { node { id } } } }");
  assert.equal(result.ok, false);
  assert.equal(result.code, "DIRECTIVE_NOT_SUPPORTED");
});

test("rejects a mutation document that omits userErrors — HTTP 200 alone must never look like success", () => {
  const result = analyzeMutation('mutation { productUpdate(input: {id: "1"}) { product { id } } }');
  assert.equal(result.ok, false);
  assert.equal(result.code, "MUTATION_MUST_SELECT_USER_ERRORS");
});

test("rejects pagination past the gateway cap, from a literal", () => {
  const result = analyzeQuery("query { products(first: 9999) { edges { node { id } } } }");
  assert.equal(result.ok, false);
  assert.equal(result.code, "STRUCTURAL_LIMIT_EXCEEDED");
});

test("rejects pagination past the gateway cap, from a bound variable", () => {
  const result = analyzeQuery("query($n: Int!) { products(first: $n) { edges { node { id } } } }", { n: 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STRUCTURAL_LIMIT_EXCEEDED");
});

test("rejects a document nested past the structural depth limit", () => {
  // 20 levels of self-nesting via a field that doesn't even need to resolve — the depth check
  // runs before any provider call, purely on parsed shape.
  const nested = "a".repeat(0); // no-op, keeps eslint quiet about unused var patterns
  let doc = "id";
  for (let i = 0; i < 20; i += 1) doc = `field { ${doc} }`;
  const result = analyzeQuery(`query { products { edges { node { ${doc} } } } }`);
  assert.equal(result.ok, false);
  assert.equal(result.code, "STRUCTURAL_LIMIT_EXCEEDED");
  void nested;
});

test("a genuinely valid read passes and is normalized/printable", () => {
  const result = analyzeQuery("query { products(first: 5) { edges { node { id title } } } }");
  assert.equal(result.ok, true);
  assert.equal(result.rootField, "products");
  assert.equal(result.domain, "products");
  assert.equal(result.safety.interaction, "AUTONOMOUS_ELIGIBLE");
});

test("a genuinely valid mutation passes, classifies, and builds an executable synthetic stub", () => {
  const result = analyzeMutation(
    'mutation($id: ID!) { productDelete(input: {id: $id}) { deletedProductId userErrors { field message } } }',
    { id: "gid://shopify/Product/1" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.rootField, "productDelete");
  assert.equal(result.safety.riskTier, "DESTRUCTIVE");
  assert.equal(result.safety.interaction, "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED");
  const stub = buildSyntheticGatewayStub({ analysis: result, apiVersion: index.apiVersion });
  assert.equal(stub.operation, "productDelete");
  assert.equal(stub.operationKind, "MUTATION");
  assert.ok(stub.document.includes("productDelete"));
});

test("an operation absent from the local catalog snapshot still gets a real, non-dead-end classification", () => {
  // Simulates a brand-new Shopify mutation released after the last catalog regeneration — the
  // whole point of the gateway is that this must not require anyone to hand-add an entry.
  const result = analyzeMutation(
    'mutation { totallyNewFutureMutationXYZ(input: {id: "1"}) { userErrors { field message } } }',
  );
  assert.equal(result.ok, true);
  assert.equal(result.knownInSchemaIndex, false);
  assert.notEqual(result.execution.status, "UNSUPPORTED_SEMANTICS");
  assert.equal(result.execution.status, "EXECUTABLE_WITH_CONFIRMATION");
  assert.equal(result.safety.interaction, "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED");
});

test("recommendation mode's tool dispatcher never exposes the mutation tools at all — not just instructed against", async () => {
  const ctx = {
    client: { request: async () => ({}) },
    merchantId: "m1",
    shopId: "s1",
    shopDomain: "jefe-local-store.myshopify.com",
    apiVersion: index.apiVersion,
    recommendationMode: true,
  };
  const prepareResult = await runShopifyGatewayTool(ctx, {
    tool: SHOPIFY_GATEWAY_TOOL.prepareMutation,
    arguments: { document: 'mutation { productDelete(input: {id: "1"}) { deletedProductId userErrors { field message } } }' },
  });
  assert.equal(prepareResult.ok, false);
  assert.equal(prepareResult.error.code, "MUTATION_TOOL_UNAVAILABLE");

  const executeResult = await runShopifyGatewayTool(ctx, {
    tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
    arguments: {
      document: 'mutation { productDelete(input: {id: "1"}) { deletedProductId userErrors { field message } } }',
      idempotencyKey: "k1",
    },
  });
  assert.equal(executeResult.ok, false);
  assert.equal(executeResult.error.code, "MUTATION_TOOL_UNAVAILABLE");
});

test("verification mode's tool dispatcher also refuses mutation tools", async () => {
  const ctx = {
    client: { request: async () => ({}) },
    merchantId: "m1",
    shopId: "s1",
    shopDomain: "jefe-local-store.myshopify.com",
    apiVersion: index.apiVersion,
    verificationMode: true,
  };
  const result = await runShopifyGatewayTool(ctx, {
    tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
    arguments: { document: "mutation { appUninstall { userErrors { field message } } }", idempotencyKey: "k1" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MUTATION_TOOL_UNAVAILABLE");
});

test("even if a recommendation-mode agent calls shopify_query with a mutation document directly, it is rejected structurally", async () => {
  const ctx = {
    client: { request: async () => ({}) },
    merchantId: "m1",
    shopId: "s1",
    shopDomain: "jefe-local-store.myshopify.com",
    apiVersion: index.apiVersion,
    recommendationMode: true,
  };
  const result = await runShopifyGatewayTool(ctx, {
    tool: SHOPIFY_GATEWAY_TOOL.query,
    arguments: { document: 'mutation { productDelete(input: {id: "1"}) { deletedProductId userErrors { field message } } }' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SAFETY_OPERATION_KIND_MISMATCH");
});
