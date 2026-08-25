import assert from "node:assert/strict";
import test from "node:test";

import { ShopifyAdminGraphqlClient } from "../app/lib/shopify/admin-graphql.server.js";
import { runShopifyGatewayTool, SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// docs/ops/agentic-shopify-gateway-full/ Part 12: a field-level GraphQL error (e.g. ACCESS_DENIED
// on one nested field) must not discard useful data returned alongside it.

const silentLogger = { info() {}, warn() {}, error() {} };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {} });
}

test("requestWithClassification: FULL_SUCCESS when there are no errors", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "t",
    logger: silentLogger,
    fetchImpl: async () => jsonResponse({ data: { shop: { name: "Test Shop" } } }),
  });
  const result = await client.requestWithClassification("query { shop { name } }");
  assert.equal(result.classification, "FULL_SUCCESS");
  assert.deepEqual(result.data, { shop: { name: "Test Shop" } });
  assert.equal(result.errors.length, 0);
});

test("requestWithClassification: AUTHORIZATION_PARTIAL preserves usable data alongside a field-level ACCESS_DENIED", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "t",
    logger: silentLogger,
    fetchImpl: async () =>
      jsonResponse({
        data: { shop: { name: "Test Shop" }, shopifyPaymentsAccount: null },
        errors: [
          {
            message: "Access denied for shopifyPaymentsAccount field.",
            path: ["shopifyPaymentsAccount"],
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      }),
  });
  const result = await client.requestWithClassification("query { shop { name } shopifyPaymentsAccount { id } }");
  assert.equal(result.classification, "AUTHORIZATION_PARTIAL");
  assert.deepEqual(result.data, { shop: { name: "Test Shop" }, shopifyPaymentsAccount: null });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "ACCESS_DENIED");
  assert.deepEqual(result.errors[0].path, ["shopifyPaymentsAccount"]);
});

test("requestWithClassification: PARTIAL_SUCCESS for a non-authorization field error alongside usable data", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "t",
    logger: silentLogger,
    fetchImpl: async () =>
      jsonResponse({
        data: { shop: { name: "Test Shop" }, products: null },
        errors: [{ message: "Internal error resolving products.", path: ["products"], extensions: { code: "INTERNAL_SERVER_ERROR" } }],
      }),
  });
  const result = await client.requestWithClassification("query { shop { name } products(first: 5) { nodes { id } } }");
  assert.equal(result.classification, "PARTIAL_SUCCESS");
  assert.deepEqual(result.data, { shop: { name: "Test Shop" }, products: null });
});

test("requestWithClassification: GRAPHQL_FAILURE when errors leave no usable data", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "t",
    logger: silentLogger,
    fetchImpl: async () => jsonResponse({ errors: [{ message: "Field must have selections", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }),
  });
  const result = await client.requestWithClassification("query { products { count } }");
  assert.equal(result.classification, "GRAPHQL_FAILURE");
  assert.equal(result.data, null);
  assert.equal(result.errors.length, 1);
});

test("requestWithClassification: still throws on HTTP-level transport failure (nothing to salvage)", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "t",
    logger: silentLogger,
    fetchImpl: async () => jsonResponse({ errors: [{ message: "Internal Server Error" }] }, 500),
  });
  await assert.rejects(() => client.requestWithClassification("query { shop { name } }"));
});

test("request() (existing method) is completely unchanged: still throws on any GraphQL error, even with partial data present", async () => {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: "example.myshopify.com",
    accessToken: "t",
    logger: silentLogger,
    fetchImpl: async () =>
      jsonResponse({
        data: { shop: { name: "Test Shop" } },
        errors: [{ message: "Access denied.", extensions: { code: "ACCESS_DENIED" } }],
      }),
  });
  await assert.rejects(() => client.request("query { shop { name } }"));
});

test("gateway shopify_query surfaces partial data as ok:true with classification, when the client supports requestWithClassification", async () => {
  const client = {
    async requestWithClassification() {
      return {
        classification: "AUTHORIZATION_PARTIAL",
        data: { shop: { name: "Test Shop" }, shopifyPaymentsAccount: null },
        errors: [{ message: "Access denied for shopifyPaymentsAccount field.", path: ["shopifyPaymentsAccount"], code: "ACCESS_DENIED" }],
      };
    },
    async request() {
      throw new Error("should not be called when requestWithClassification exists");
    },
  };
  const result = await runShopifyGatewayTool(
    { client, merchantId: "m1", shopId: "s1", shopDomain: "x.myshopify.com", apiVersion: "2026-07", recommendationMode: true, logger: silentLogger },
    { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document: "query { shop { name } shopifyPaymentsAccount { id } }" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.facts.classification, "AUTHORIZATION_PARTIAL");
  assert.equal(result.facts.partialErrors.length, 1);
  assert.deepEqual(result.facts.data, { shop: { name: "Test Shop" }, shopifyPaymentsAccount: null });
});

test("gateway shopify_query falls back to plain request() when the client doesn't support requestWithClassification", async () => {
  const client = { async request() { return { shop: { name: "Test Shop" } }; } };
  const result = await runShopifyGatewayTool(
    { client, merchantId: "m1", shopId: "s1", shopDomain: "x.myshopify.com", apiVersion: "2026-07", recommendationMode: true, logger: silentLogger },
    { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document: "query { shop { name } }" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.facts.classification, "FULL_SUCCESS");
});
