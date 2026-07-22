import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../app/fixtures/dummy-store-data.json" with { type: "json" };
import klaviyoWinbackFixture from "../app/fixtures/klaviyo-winback-scenario-data.json" with { type: "json" };
import watchdogFixture from "../app/fixtures/watchdog-scenario-data.json" with { type: "json" };
import { getMissingShopifyScopes } from "../app/services/shopify-scopes.server.js";

test("dummy store fixture covers Shopify ingestion and downstream scenarios", () => {
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
    assertFixtureCustomer(order.customer);

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

test("dummy store scope check treats Shopify write scopes as read scopes", () => {
  const missingScopes = getMissingShopifyScopes(
    [
      "read_locations",
      "read_products",
      "write_products",
      "read_inventory",
      "write_inventory",
      "read_customers",
      "write_customers",
      "read_orders",
      "write_orders",
    ],
    "read_locations,write_inventory,write_orders,write_products,write_customers",
  );

  assert.deepEqual(missingScopes, []);
});

test("Klaviyo winback scenario fixture creates dormant customer orders", () => {
  const variants = new Map(
    klaviyoWinbackFixture.products.flatMap((product) =>
      product.variants.map((variant) => [
        variant.sku,
        { ...variant, product },
      ]),
    ),
  );
  const scenarioKeys = new Set(
    klaviyoWinbackFixture.scenarios.map((scenario) => scenario.key),
  );
  const emails = klaviyoWinbackFixture.orders.map((order) => order.customer.email);
  const uniqueEmails = new Set(emails);
  const reusedRecentEmails = new Set([
    "louis+jefe-test-001@quiver.co.uk",
    "louis+jefe-test-002@quiver.co.uk",
    "louis+jefe-test-003@quiver.co.uk",
    "louis+jefe-test-006@quiver.co.uk",
  ]);

  assert.equal(klaviyoWinbackFixture.currency, "GBP");
  assert.ok(
    klaviyoWinbackFixture.tags.includes("jefe-klaviyo-winback-scenario"),
  );
  assert.deepEqual(scenarioKeys, new Set([
    "dormant_customers",
    "recent_reorder_exclusion",
    "repeat_dormant_buyer",
  ]));
  assert.equal(klaviyoWinbackFixture.orders.length, 16);
  assert.ok(uniqueEmails.size < klaviyoWinbackFixture.orders.length);
  assert.ok(
    Array.from(reusedRecentEmails).every((email) => emails.includes(email)),
  );

  for (const order of klaviyoWinbackFixture.orders) {
    assert.ok(order.name.startsWith("#JWB-"));
    assert.ok(order.daysAgo >= 60);
    assert.ok(order.daysAgo <= 180);
    assertFixtureCustomer(order.customer);

    for (const lineItem of order.lineItems) {
      assert.ok(variants.has(lineItem.sku), `missing SKU ${lineItem.sku}`);
      assert.ok(lineItem.quantity > 0);
    }
  }

  assert.ok(
    klaviyoWinbackFixture.orders.some(
      (order) => Number(order.customer.email.match(/\d{3}/)?.[0]) >= 19,
    ),
  );
});

test("watchdog scenario fixture covers exact dev scenarios", () => {
  const variants = new Map(
    watchdogFixture.products.flatMap((product) =>
      product.variants.map((variant) => [
        variant.sku,
        { ...variant, product },
      ]),
    ),
  );
  const scenarioKeys = new Set(
    watchdogFixture.scenarios.map((scenario) => scenario.key),
  );
  const ordersByScenario = groupOrdersByScenario(watchdogFixture.orders);

  assert.equal(watchdogFixture.currency, "GBP");
  assert.ok(watchdogFixture.tags.includes("jefe-watchdog-scenario"));
  assert.equal(
    new Set(watchdogFixture.products.map((product) => product.handle)).size,
    watchdogFixture.products.length,
  );
  assert.equal(
    new Set(watchdogFixture.orders.map((order) => order.name)).size,
    watchdogFixture.orders.length,
  );
  assert.deepEqual(scenarioKeys, new Set([
    "refund_spike",
    "sales_collapse",
    "product_unavailable",
    "revenue_drop",
    "missing_cogs_important_seller",
    "high_return_product",
  ]));

  for (const order of watchdogFixture.orders) {
    assert.ok(order.name.startsWith("#JWS-"));
    assertFixtureCustomer(order.customer);

    for (const lineItem of order.lineItems) {
      assert.ok(variants.has(lineItem.sku), `missing SKU ${lineItem.sku}`);
      assert.ok(lineItem.quantity > 0);
    }
  }

  const hoodieBaselineUnits = unitsSold({
    orders: ordersByScenario.get("sales_collapse_baseline") ?? [],
    sku: "JWDS-HOODIE-BLK-M",
  });
  const hoodieLast7dUnits = unitsSold({
    orders: watchdogFixture.orders.filter((order) => order.daysAgo <= 7),
    sku: "JWDS-HOODIE-BLK-M",
  });

  assert.equal(hoodieBaselineUnits, 20);
  assert.equal(hoodieLast7dUnits, 0);

  const unavailableProduct = watchdogFixture.products.find(
    (product) => product.scenario === "product_unavailable",
  );
  assert.equal(unavailableProduct.finalStatus, "DRAFT");
  assert.equal(unavailableProduct.finalInventory, 0);
  assert.equal(
    unitsSold({
      orders: ordersByScenario.get("product_unavailable_recent_sale") ?? [],
      sku: "JWDS-MUG-TRAVEL",
    }),
    3,
  );

  const revenueBaseline = revenueForSku({
    orders: ordersByScenario.get("revenue_drop_baseline") ?? [],
    variants,
    sku: "JWDS-REV-MIX",
  });
  const revenueCurrentWeek = revenueForSku({
    orders: ordersByScenario.get("revenue_drop_current_week") ?? [],
    variants,
    sku: "JWDS-REV-MIX",
  });

  assert.equal(revenueBaseline / 4, 1000);
  assert.equal(revenueCurrentWeek, 400);

  const missingCogsProduct = watchdogFixture.products.find(
    (product) => product.scenario === "missing_cogs_important_seller",
  );
  const missingCogsRevenue = revenueForSku({
    orders: ordersByScenario.get("missing_cogs_important_seller") ?? [],
    variants,
    sku: "JWDS-MYSTERY-SELLER",
  });

  assert.equal(missingCogsProduct.cogsHint, null);
  assert.ok(missingCogsRevenue > 100);

  const refundSpikeOrders =
    ordersByScenario.get("refund_spike_current_week") ?? [];
  assert.equal(
    refundSpikeOrders.filter((order) => order.refundSku === "JWDS-REFUND-BOTTLE")
      .length,
    5,
  );
  assert.equal(
    (ordersByScenario.get("refund_spike_baseline_normal_refund") ?? []).length,
    1,
  );

  const summerDressOrders = ordersByScenario.get("high_return_product") ?? [];
  const summerDressRefunds = summerDressOrders.filter(
    (order) => order.refundSku === "JWDS-SUMMER-DRESS",
  ).length;

  assert.equal(summerDressOrders.length, 8);
  assert.ok(summerDressRefunds / summerDressOrders.length > 0.25);

  const uniqueCustomers = new Set(
    watchdogFixture.orders.map((order) => order.customer.email),
  );
  assert.ok(uniqueCustomers.size < watchdogFixture.orders.length);
  assert.ok(uniqueCustomers.size >= 10);
});

function assertFixtureCustomer(customer) {
  assert.match(
    customer.email,
    /^louis\+jefe-test-\d{3}@quiver\.co\.uk$/,
  );
  assert.ok(customer.firstName);
  assert.ok(customer.lastName);
  assert.equal(customer.acceptsMarketing, true);
}

function unitsSold({ orders, sku }) {
  return orders.reduce(
    (sum, order) =>
      sum +
      order.lineItems
        .filter((lineItem) => lineItem.sku === sku)
        .reduce((lineSum, lineItem) => lineSum + lineItem.quantity, 0),
    0,
  );
}

function revenueForSku({ orders, variants, sku }) {
  const variant = variants.get(sku);

  assert.ok(variant, `missing variant ${sku}`);

  return unitsSold({ orders, sku }) * Number(variant.price);
}

function groupOrdersByScenario(orders) {
  const groups = new Map();

  for (const order of orders) {
    const existing = groups.get(order.scenario) ?? [];
    existing.push(order);
    groups.set(order.scenario, existing);
  }

  return groups;
}
