import assert from "node:assert/strict";
import test from "node:test";
import { createClearanceShopifyClient } from "../app/lib/actions/clearance-shopify-client.server.js";

/** Mock gql client: canned responses keyed by whether it's the update mutation. */
function makeGql(responses) {
  const calls = [];
  return {
    calls,
    request: async (query, variables) => {
      calls.push({ op: query.match(/(?:query|mutation)\s+(\w+)/)?.[1], variables });
      const key = query.includes("productVariantsBulkUpdate") ? "update" : "get";
      const r = responses[key];
      return typeof r === "function" ? r(variables) : r;
    },
  };
}

test("createClearanceShopifyClient requires a gql client", () => {
  assert.throws(() => createClearanceShopifyClient(null), /request/);
});

test("getVariantPrice returns the numeric price + caches the product id for the write", async () => {
  const gql = makeGql({
    get: {
      productVariant: {
        id: "gid://shopify/ProductVariant/1",
        price: "42.50",
        product: { id: "gid://shopify/Product/9" },
      },
    },
    update: {
      productVariantsBulkUpdate: {
        productVariants: [{ id: "gid://shopify/ProductVariant/1", price: "30.00" }],
        userErrors: [],
      },
    },
  });
  const client = createClearanceShopifyClient(gql);
  const price = await client.getVariantPrice("gid://shopify/ProductVariant/1");
  assert.equal(price, 42.5);
  // updateVariantPrice reuses the cached product id — no second get query.
  await client.updateVariantPrice("gid://shopify/ProductVariant/1", 30);
  assert.deepEqual(gql.calls.map((c) => c.op), ["ClearanceVariantPrice", "ClearanceSetVariantPrice"]);
  const update = gql.calls.find((c) => c.op === "ClearanceSetVariantPrice");
  assert.equal(update.variables.productId, "gid://shopify/Product/9");
  assert.deepEqual(update.variables.variants, [{ id: "gid://shopify/ProductVariant/1", price: "30" }]);
});

test("getVariantPrice returns null for a missing variant", async () => {
  const client = createClearanceShopifyClient(makeGql({ get: { productVariant: null } }));
  assert.equal(await client.getVariantPrice("gid://x"), null);
});

test("updateVariantPrice without a cached product id queries it first", async () => {
  const gql = makeGql({
    get: { productVariant: { id: "v1", price: "10.00", product: { id: "p1" } } },
    update: { productVariantsBulkUpdate: { productVariants: [{ id: "v1", price: "8.00" }], userErrors: [] } },
  });
  const client = createClearanceShopifyClient(gql);
  await client.updateVariantPrice("v1", 8); // no prior getVariantPrice → must fetch the product id
  assert.deepEqual(gql.calls.map((c) => c.op), ["ClearanceVariantPrice", "ClearanceSetVariantPrice"]);
});

test("updateVariantPrice throws on Shopify userErrors", async () => {
  const gql = makeGql({
    get: { productVariant: { id: "v1", price: "10.00", product: { id: "p1" } } },
    update: { productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: ["price"], message: "bad price" }] } },
  });
  const client = createClearanceShopifyClient(gql);
  await client.getVariantPrice("v1");
  await assert.rejects(() => client.updateVariantPrice("v1", -5), /userErrors/);
});

test("updateVariantPrice throws when the product id can't be resolved", async () => {
  const gql = makeGql({ get: { productVariant: { id: "v1", price: "10.00", product: null } } });
  const client = createClearanceShopifyClient(gql);
  await assert.rejects(() => client.updateVariantPrice("v1", 8), /product id/);
});
