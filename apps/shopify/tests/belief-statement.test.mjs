import assert from "node:assert/strict";
import test from "node:test";
import { renderBeliefStatement, STATEMENT_FORMATTED_KEYS } from "../app/lib/merchant-memory/belief-statement.server.js";

test("dead_stock: plain-English statement in Jefe's voice", () => {
  const s = renderBeliefStatement({
    key: "products.dead_stock.trailing_90d",
    value: {
      deadStockProductCount: 3,
      totalTrappedCapital: 4200,
      currency: "GBP",
      topDeadProduct: { title: "Winback Seasonal Bundle", trappedCapital: 2736 },
    },
  });
  assert.equal(s, "3 products have stock but no sales in the last 90 days, about £4,200 tied up. The biggest is Winback Seasonal Bundle.");
});

test("dead_stock: singular grammar", () => {
  const s = renderBeliefStatement({
    key: "products.dead_stock.trailing_90d",
    value: { deadStockProductCount: 1, totalTrappedCapital: 500, currency: "GBP", topDeadProduct: { title: "X" } },
  });
  assert.match(s, /^1 product has stock/);
});

test("dead_stock: no trapped-capital clause when zero/unknown", () => {
  const s = renderBeliefStatement({
    key: "products.dead_stock.trailing_90d",
    value: { deadStockProductCount: 2, totalTrappedCapital: 0, topDeadProduct: { title: "Y" } },
  });
  assert.equal(s, "2 products have stock but no sales in the last 90 days. The biggest is Y.");
});

test("dead_stock: no dead products → null", () => {
  assert.equal(renderBeliefStatement({ key: "products.dead_stock.trailing_90d", value: { deadStockProductCount: 0 } }), null);
});

test("unknown key → null (surface keeps its own fallback)", () => {
  assert.equal(renderBeliefStatement({ key: "business.something_else", value: {} }), null);
});

test("null-safe on bad input", () => {
  assert.equal(renderBeliefStatement(null), null);
  assert.equal(renderBeliefStatement(undefined), null);
  assert.equal(renderBeliefStatement({ value: {} }), null);
  assert.equal(renderBeliefStatement({ key: "products.dead_stock.trailing_90d", value: null }), null);
});

test("STATEMENT_FORMATTED_KEYS advertises coverage", () => {
  assert.ok(STATEMENT_FORMATTED_KEYS.includes("products.dead_stock.trailing_90d"));
});
