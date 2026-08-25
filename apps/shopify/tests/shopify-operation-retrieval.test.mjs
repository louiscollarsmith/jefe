// Retrieval regression tests (Task 3 §7 follow-on) for retrieveShopifyApiOperations
// (app/lib/shopify/api/retrieval.server.js). No LLM, no pipeline — this exercises the keyword
// scoring + SHOPIFY_QUERY_EXPANSIONS layer directly against the real generated catalog for
// plausible merchant-problem phrasings across a spread of domains, plus the specific historical
// cost/margin regression already fixed via query-expansions.server.js's `cost: ["inventory
// item"]` expansion.
//
// Each phrasing below was checked directly against the real catalog before being committed here
// (not guessed) — 2-3 phrasings were tried per domain, and the one that most robustly surfaces a
// real, relevant operation within the top 8 was kept. See the per-case comments for what was
// tried and why the chosen phrasing is not a hair's-breadth pass.

import assert from "node:assert/strict";
import test from "node:test";

import { retrieveShopifyApiOperations } from "../app/lib/shopify/api/retrieval.server.js";

function operationNames(query, options) {
  return retrieveShopifyApiOperations(query, { limit: 8, ...options }).map((row) => row.operation);
}

test("customers: 'gone quiet and stopped repeat purchasing' surfaces a real customer query op", () => {
  const ops = operationNames("customers who have gone quiet and stopped repeat purchasing");
  assert.ok(
    ops.some((op) => op === "customer" || op === "customers" || op === "customerUpdate"),
    `expected a customer operation in top 8, got ${JSON.stringify(ops)}`,
  );
});

test("discounts_promotions: 'which discount code should we run for this sale' surfaces discountCodeBasicCreate", () => {
  const ops = operationNames("which discount code should we run for this sale");
  assert.ok(ops.includes("discountCodeBasicCreate"), `expected discountCodeBasicCreate in top 8, got ${JSON.stringify(ops)}`);
});

test("inventory: 'check inventory levels and available stock by location' surfaces real inventory-domain ops", () => {
  const rows = retrieveShopifyApiOperations("check inventory levels and available stock by location", { limit: 8 });
  const inventoryDomainOps = rows.filter((r) => r.domain === "inventory").map((r) => r.operation);
  assert.ok(inventoryDomainOps.length >= 3, `expected several inventory-domain ops in top 8, got ${JSON.stringify(rows.map((r) => r.operation))}`);
  assert.ok(inventoryDomainOps.includes("locations"), `expected "locations" in top 8, got ${JSON.stringify(inventoryDomainOps)}`);
});

test("fulfillment: 'list all fulfillment orders' surfaces the real fulfillmentOrders query op", () => {
  // Tried first: "fulfillment orders that are open and unfulfilled" and "open fulfillment
  // orders" — both surface plenty of fulfillment-domain ops but push the specific
  // "fulfillmentOrders" query itself to the score-tied edge of the top 8 (position 7/8, tied on
  // score with several siblings — too fragile to assert on by name). "list all fulfillment
  // orders" ranks fulfillmentOrders solidly at position 2 with a clear score margin.
  const ops = operationNames("list all fulfillment orders");
  assert.ok(ops.includes("fulfillmentOrders"), `expected fulfillmentOrders in top 8, got ${JSON.stringify(ops)}`);
});

test("returns: 'get the return for this order' surfaces real returns-domain operations", () => {
  // The returns domain's read-only query ops (return, returnableFulfillments, returnCalculate)
  // use single concatenated camelCase operation names ("returnablefulfillments" as one token),
  // so they don't get the retrieval scorer's exact-operation-name-token bonus the way a
  // single-word op like "return" or "orders" does — that's a tokenizer characteristic, not
  // something query-expansions.server.js can fix (expansions add terms, they don't change how
  // operation names are tokenized). What DOES reliably surface for this phrasing is the returns
  // domain itself: its own mutation-named ops (reverseFulfillmentOrder /
  // reverseFulfillmentOrderDispose) rank at the very top, and the "return" query op itself is
  // still present in the top 8. Asserted at the domain level here because that's the honest,
  // robust claim; the exact-op assertion is additionally checked as a documented bonus.
  const rows = retrieveShopifyApiOperations("get the return for this order", { limit: 8 });
  const ops = rows.map((r) => r.operation);
  assert.ok(rows.some((r) => r.domain === "returns"), `expected a returns-domain operation in top 8, got ${JSON.stringify(ops)}`);
  assert.ok(ops.includes("return"), `expected the "return" query operation itself in top 8, got ${JSON.stringify(ops)}`);
});

test("navigation: 'bestselling collection missing from site navigation menu' surfaces the real menus query op", () => {
  const ops = operationNames("bestselling collection missing from site navigation menu");
  assert.ok(ops.includes("menus") || ops.includes("menu"), `expected a menu operation in top 8, got ${JSON.stringify(ops)}`);
});

test("publishing_channels: 'which sales channels is this product published to' surfaces real publishing-channel ops", () => {
  const ops = operationNames("which sales channels is this product published to");
  assert.ok(
    ops.some((op) => op === "channel" || op === "channels" || op === "publication" || op === "publications"),
    `expected a publishing_channels operation in top 8, got ${JSON.stringify(ops)}`,
  );
});

test("orders: 'recent orders placed by customers' surfaces the real orders query op", () => {
  const ops = operationNames("recent orders placed by customers");
  assert.ok(ops.includes("orders") || ops.includes("order"), `expected an orders operation in top 8, got ${JSON.stringify(ops)}`);
});

test("products: 'products that are out of stock or draft' surfaces the real products query op", () => {
  const ops = operationNames("products that are out of stock or draft");
  assert.ok(ops.includes("products") || ops.includes("product"), `expected a products operation in top 8, got ${JSON.stringify(ops)}`);
});

// ---------------------------------------------------------------------------
// Historical regression: cost/margin phrasing must surface an inventory-item cost operation.
// Fixed via query-expansions.server.js's `cost: ["inventory item"]` (and `margin`) entries,
// which map the merchant's own "cost" language onto Shopify's InventoryItem cost field, since no
// operation or description otherwise uses the word "cost" the way a merchant would ask it.
// This test proves that expansion still fires; it does not re-touch query-expansions.server.js.
// ---------------------------------------------------------------------------

test("regression: 'what does this product actually cost us' surfaces an inventory-item cost operation", () => {
  const ops = operationNames("what does this product actually cost us");
  assert.ok(
    ops.includes("inventoryItemUpdate") || ops.includes("inventoryItems") || ops.includes("inventoryItem"),
    `expected an inventory-item operation in top 8, got ${JSON.stringify(ops)}`,
  );
});

test("regression: a second cost-adjacent phrasing ('margin on this item') also surfaces an inventory-item operation", () => {
  const ops = operationNames("what's our margin on this item");
  assert.ok(
    ops.includes("inventoryItemUpdate") || ops.includes("inventoryItems") || ops.includes("inventoryItem"),
    `expected an inventory-item operation in top 8, got ${JSON.stringify(ops)}`,
  );
});
