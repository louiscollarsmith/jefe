import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../app/fixtures/dummy-store-data.json" with { type: "json" };

test("dummy store fixture covers Ticket 003 ingestion and downstream scenarios", () => {
  const variants = fixture.products.flatMap((product) =>
    product.variants.map((variant) => ({
      ...variant,
      productScenario: product.scenario,
    })),
  );
  const skus = new Set(variants.map((variant) => variant.sku));
  const scenarios = new Set(fixture.products.map((product) => product.scenario));

  assert.equal(fixture.currency, "GBP");
  assert.ok(fixture.tags.includes("jefe-dummy"));
  assert.ok(fixture.products.length >= 8);
  assert.ok(variants.length >= 10);
  assert.equal(fixture.orders.length, 5);

  assert.ok(scenarios.has("protected_hero_high_margin_low_stock"));
  assert.ok(scenarios.has("stockout_risk"));
  assert.ok(scenarios.has("dead_stock_cash_tied_up"));
  assert.ok(scenarios.has("missing_cogs_confidence_range"));
  assert.ok(scenarios.has("discounted_low_margin"));
  assert.ok(scenarios.has("sales_collapse_after_baseline"));
  assert.ok(scenarios.has("product_unavailable"));

  assert.ok(
    fixture.products.some(
      (product) => product.status === "DRAFT" && product.scenario === "product_unavailable",
    ),
  );
  assert.ok(
    fixture.products.some(
      (product) => product.cogsHint === null && product.scenario === "missing_cogs_confidence_range",
    ),
  );
  assert.ok(
    variants.some(
      (variant) => variant.inventory <= 3 && variant.productScenario === "stockout_risk",
    ),
  );
  assert.ok(
    variants.some(
      (variant) => variant.inventory >= 200 && variant.productScenario === "dead_stock_cash_tied_up",
    ),
  );

  for (const order of fixture.orders) {
    assert.ok(order.name.startsWith("#JDF-"));
    assert.ok(order.lineItems.length > 0);

    for (const lineItem of order.lineItems) {
      assert.ok(skus.has(lineItem.sku), `missing SKU ${lineItem.sku}`);
      assert.ok(lineItem.quantity > 0);
    }
  }

  const discountedOrders = fixture.orders.filter(
    (order) => order.discountPercentage !== null,
  );
  const refundOrders = fixture.orders.filter((order) => order.refundSku !== null);

  assert.ok(discountedOrders.length >= 2);
  assert.equal(refundOrders.length, 1);
  assert.ok(skus.has(refundOrders[0].refundSku));
});
