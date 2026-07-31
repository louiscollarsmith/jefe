import assert from "node:assert/strict";
import test from "node:test";
import { createProductStatusShopifyClient } from "../app/lib/actions/product-status-shopify-client.server.js";

/** A gql double that keys canned responses on the operation name. */
function makeGql(handler) {
  const calls = [];
  return {
    calls,
    async request(query, variables) {
      const op = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      calls.push({ op, query, variables });
      return handler({ op, query, variables });
    },
  };
}

test("factory requires a gql client with request()", () => {
  assert.throws(() => createProductStatusShopifyClient(null), /gql client/);
  assert.throws(() => createProductStatusShopifyClient({}), /gql client/);
});

test("getProductStatus returns the status, or null when absent", async () => {
  const client = createProductStatusShopifyClient(makeGql(({ op }) => (op === "ProductStatusRead" ? { product: { id: "p1", status: "ACTIVE" } } : {})));
  assert.equal(await client.getProductStatus("p1"), "ACTIVE");
  const nullClient = createProductStatusShopifyClient(makeGql(() => ({ product: null })));
  assert.equal(await nullClient.getProductStatus("pX"), null);
});

test("updateProductStatus posts productUpdate with { product: { id, status } } and returns the product", async () => {
  const gql = makeGql(({ op }) => (op === "ProductStatusSet" ? { productUpdate: { product: { id: "p1", status: "ARCHIVED" }, userErrors: [] } } : {}));
  const client = createProductStatusShopifyClient(gql);
  const res = await client.updateProductStatus("p1", "ARCHIVED");
  assert.deepEqual(res, { id: "p1", status: "ARCHIVED" });
  const call = gql.calls.find((c) => c.op === "ProductStatusSet");
  assert.deepEqual(call.variables, { product: { id: "p1", status: "ARCHIVED" } });
});

test("updateProductStatus throws on userErrors (never silently no-ops)", async () => {
  const client = createProductStatusShopifyClient(makeGql(() => ({ productUpdate: { product: null, userErrors: [{ field: ["status"], message: "invalid" }] } })));
  await assert.rejects(() => client.updateProductStatus("p1", "ARCHIVED"), /userErrors/);
});

test("operations are named so the double + Shopify can identify them", async () => {
  const gql = makeGql(({ op }) => (op === "ProductStatusRead" ? { product: { id: "p1", status: "DRAFT" } } : { productUpdate: { product: { id: "p1", status: "ACTIVE" }, userErrors: [] } }));
  const client = createProductStatusShopifyClient(gql);
  await client.getProductStatus("p1");
  await client.updateProductStatus("p1", "ACTIVE");
  assert.deepEqual(gql.calls.map((c) => c.op), ["ProductStatusRead", "ProductStatusSet"]);
});
