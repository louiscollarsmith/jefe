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

test("top_product_revenue_share: concentration in Jefe's voice", () => {
  assert.equal(
    renderBeliefStatement({ key: "products.top_product_revenue_share.trailing_90d", value: { percentage: 71, topN: 2 } }),
    "Your top 2 products bring in 71% of your revenue.",
  );
  assert.equal(
    renderBeliefStatement({ key: "products.top_product_revenue_share.trailing_90d", value: { percentage: 60, topN: 1 } }),
    "Your top product brings in 60% of your revenue.",
  );
});

test("top_returned_products: rate, with units fallback", () => {
  assert.equal(
    renderBeliefStatement({ key: "products.top_returned_products.trailing_180d", value: { topReturnedProduct: { title: "Repair Balm", returnRatePercent: 12 } } }),
    "Repair Balm comes back most — about 12% of the ones you sell get returned.",
  );
  assert.match(
    renderBeliefStatement({ key: "products.top_returned_products.trailing_180d", value: { topReturnedProduct: { title: "X", returnRatePercent: null, returnedUnits: 4 } } }),
    /^X has the most returns lately — 4 units sent back\.$/,
  );
});

test("low_cover_products: days of cover + others running low", () => {
  assert.equal(
    renderBeliefStatement({ key: "inventory.low_cover_products.trailing_30d", value: { topAtRiskProduct: { title: "Rosehip Serum", daysOfCover: 5 }, atRiskProductCount: 3 } }),
    "Rosehip Serum runs low soon — about 5 days of stock left at the current pace, and 2 others running low.",
  );
  assert.equal(
    renderBeliefStatement({ key: "inventory.low_cover_products.trailing_30d", value: { topAtRiskProduct: { title: "Solo", daysOfCover: 1 }, atRiskProductCount: 1 } }),
    "Solo runs low soon — about 1 day of stock left at the current pace.",
  );
});

test("refunded_order_rate: rate, sub-1% keeps a decimal", () => {
  assert.equal(renderBeliefStatement({ key: "refunds.refunded_order_rate.all_time", value: { percentage: 4 } }), "About 4% of your orders get refunded.");
  assert.equal(renderBeliefStatement({ key: "refunds.refunded_order_rate.all_time", value: { percentage: 0.4 } }), "About 0.4% of your orders get refunded.");
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
