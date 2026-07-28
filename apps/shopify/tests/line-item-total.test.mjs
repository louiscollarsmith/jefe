import { test } from "node:test";
import assert from "node:assert/strict";

import { lineItemDiscountedTotal } from "../app/lib/ingestion/shopify/canonical.server.js";

// Regression for the webhook line-item bug: REST-shaped orders (orders/create,
// orders/updated) have no `discountedTotalSet`, so the previous fallback stored
// `total_discount` (the discount) as the line total.

test("REST line item total is unit*qty - discount, not the discount", () => {
  assert.equal(
    lineItemDiscountedTotal({ price: "50.00", quantity: 2, total_discount: "5.00" }),
    "95.00",
  );
});

test("REST line item with no discount", () => {
  assert.equal(
    lineItemDiscountedTotal({ price: "19.99", quantity: 3 }),
    "59.97",
  );
});

test("GraphQL discountedTotalSet is used unchanged", () => {
  assert.equal(
    lineItemDiscountedTotal({
      discountedTotalSet: { shopMoney: { amount: "95.00", currencyCode: "GBP" } },
    }),
    "95.00",
  );
});

test("discount cannot push the line total below zero", () => {
  assert.equal(
    lineItemDiscountedTotal({ price: "10.00", quantity: 1, total_discount: "15.00" }),
    "0.00",
  );
});

test("no unit price yields null rather than a wrong number", () => {
  assert.equal(lineItemDiscountedTotal({ quantity: 2 }), null);
});
