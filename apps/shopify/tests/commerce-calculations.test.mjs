import assert from "node:assert/strict";
import test from "node:test";

import {
  calculationScopeFromActionContext,
  executeCommerceCalculations,
  heuristicCommerceCalculationRequests,
} from "../app/lib/merchant-memory/commerce-calculations.server.js";

const NOW = new Date("2026-08-11T09:30:00.000Z");

test("impact estimates quantify scoped low-cover revenue without raw DB access", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma(), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    actionContext: lowCoverActionContext(),
    requests: [
      {
        id: "revenue_impact",
        kind: "impact_estimate",
        measure: "revenue",
        filters: { scope: "current_move" },
        window: { days: 30, label: "trailing_30d" },
        horizonDays: 30,
      },
    ],
  });

  const result = packet.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.currency, "GBP");
  assert.equal(result.totals.atRiskRevenue, 180);
  assert.equal(result.rows.find((row) => row.productId === "p1").value, 180);
  assert.equal(result.rows.find((row) => row.productId === "p2").value, 0);
  assert.doesNotMatch(JSON.stringify(result), /customer|rawPayload|owner@example/i);
});

test("commerce calculations reject missing shop scope before reading commerce data", async () => {
  const reads = [];
  const packet = await executeCommerceCalculations(createCommercePrisma({ onRead: (model) => reads.push(model) }), {
    merchantId: "m1",
    shopId: null,
    now: NOW,
    requests: [{ id: "revenue", kind: "aggregate", measure: "revenue", window: { days: 30 } }],
  });

  assert.equal(packet.results[0].ok, false);
  assert.match(packet.results[0].error, /shopId is required/);
  assert.deepEqual(reads, []);
});

test("impact estimates apply variant-only current-move scope and request filters", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma({ includeIgnoredImpactLine: true }), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    actionContext: variantOnlyActionContext(),
    requests: [
      {
        id: "variant_impact",
        kind: "impact_estimate",
        measure: "revenue",
        filters: { scope: "current_move", channel: "web" },
        window: { days: 30, label: "trailing_30d" },
        horizonDays: 30,
      },
    ],
  });

  const result = packet.results[0];
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map((row) => row.productId), ["p1"]);
  assert.equal(result.rows[0].value, 180);
  assert.equal(result.totals.atRiskRevenue, 180);
  assert.equal(result.dataQuality.filteredLineItemCount, 2);
});

test("rankings and breakdowns return named products and exclude other tenants", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma(), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [
      {
        id: "product_revenue",
        kind: "ranking",
        measure: "line_revenue",
        dimensions: ["product"],
        window: { days: 30, label: "trailing_30d" },
        topN: 5,
      },
    ],
  });

  const result = packet.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].label, "Picnic Xinomavro");
  assert.equal(result.rows[0].value, 180);
  assert.equal(result.rows[1].label, "Pear Skin Sipon");
  assert.equal(result.rows[1].value, 100);
  assert.doesNotMatch(JSON.stringify(result), /Other Tenant Windfall/);
});

test("margin, inventory value and refunds use the same allowlisted executor", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma(), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [
      { id: "margin", kind: "aggregate", measure: "gross_margin", window: { days: 30 } },
      { id: "stock", kind: "aggregate", measure: "retail_stock_value", filters: { productIds: ["p2"] }, window: { days: 30 } },
      { id: "refunds", kind: "aggregate", measure: "refund_amount", window: { days: 30 } },
    ],
  });

  assert.equal(packet.results.find((result) => result.id === "margin").totals.grossMargin, 190);
  assert.equal(packet.results.find((result) => result.id === "stock").totals.retailStockValue, 250);
  assert.equal(packet.results.find((result) => result.id === "refunds").totals.value, 20);
});

test("mixed currency and invalid planner shapes return caveats or rejected results", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma({ mixedCurrency: true }), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [
      { id: "revenue", kind: "aggregate", measure: "revenue", window: { days: 30 } },
      { id: "raw", kind: "sql", measure: "revenue", window: { days: 30 } },
    ],
  });

  assert.equal(packet.results[0].ok, true);
  assert.equal(packet.results[0].currency, null);
  // Honesty: a money measure with no single currency is refused (matches the belief
  // layer), never summed across currencies into a bare number.
  assert.equal(
    packet.results[0].dataQuality.moneyUnavailable,
    "multi_currency_no_conversion",
  );
  assert.match(
    packet.results[0].caveats.join(" "),
    /multiple currencies|without conversion/i,
  );
  assert.equal(packet.results[1].ok, false);
  assert.match(packet.results[1].error, /Unsupported calculation kind/);
});

test("heuristic planning scopes calculation requests to the current move", () => {
  const requests = heuristicCommerceCalculationRequests({
    message: "Can you quantify the predicted loss of revenue?",
    actionContext: lowCoverActionContext(),
  });
  const scope = calculationScopeFromActionContext(lowCoverActionContext());

  assert.equal(requests[0].kind, "impact_estimate");
  assert.equal(requests[0].filters.scope, "current_move");
  assert.deepEqual(scope.productIds, ["p1", "p2"]);
});

function createCommercePrisma({
  mixedCurrency = false,
  includeIgnoredImpactLine = false,
  onRead = () => {},
} = {}) {
  const products = [
    { id: "p1", merchantId: "m1", shopId: "s1", title: "Picnic Xinomavro", vendor: "Picnic", productType: "Wine", status: "ACTIVE" },
    { id: "p2", merchantId: "m1", shopId: "s1", title: "Pear Skin Sipon", vendor: "Pear", productType: "Wine", status: "ACTIVE" },
    { id: "p4", merchantId: "m1", shopId: "s-other", title: "Same Merchant Other Shop", vendor: "Other", productType: "Wine", status: "ACTIVE" },
    { id: "p3", merchantId: "m2", shopId: "s2", title: "Other Tenant Windfall", vendor: "Other", productType: "Wine", status: "ACTIVE" },
  ];
  const variants = [
    { id: "v1", merchantId: "m1", shopId: "s1", productId: "p1", title: "Default", sku: "PX", price: 60, currency: "GBP", unitCost: 20 },
    { id: "v2", merchantId: "m1", shopId: "s1", productId: "p2", title: "Default", sku: "PS", price: 50, currency: "GBP", unitCost: 30 },
    { id: "v4", merchantId: "m1", shopId: "s-other", productId: "p4", title: "Default", sku: "SO", price: 888, currency: "GBP", unitCost: 1 },
    { id: "v3", merchantId: "m2", shopId: "s2", productId: "p3", title: "Default", sku: "OT", price: 999, currency: "GBP", unitCost: 1 },
  ];
  const orders = [
    { id: "o1", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 200, totalDiscount: 10, processedAt: daysAgo(10), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
    { id: "o2", merchantId: "m1", shopId: "s1", currency: mixedCurrency ? "USD" : "GBP", totalPrice: 80, totalDiscount: 0, processedAt: daysAgo(20), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
    { id: "o4", merchantId: "m1", shopId: "s-other", currency: "GBP", totalPrice: 8888, totalDiscount: 0, processedAt: daysAgo(5), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
    ...(includeIgnoredImpactLine ? [{ id: "o5", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 500, totalDiscount: 0, processedAt: daysAgo(4), financialStatus: "paid", sourceName: "retail", shippingCountry: "GB" }] : []),
    { id: "o3", merchantId: "m2", shopId: "s2", currency: "GBP", totalPrice: 9999, totalDiscount: 0, processedAt: daysAgo(5), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
  ];
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const lineItems = [
    { merchantId: "m1", shopId: "s1", orderId: "o1", productId: "p1", variantId: "v1", sku: "PX", title: "Picnic Xinomavro", quantity: 2, unitPrice: 50, totalPrice: 100, discount: 5 },
    { merchantId: "m1", shopId: "s1", orderId: "o1", productId: "p2", variantId: "v2", sku: "PS", title: "Pear Skin Sipon", quantity: 1, unitPrice: 100, totalPrice: 100, discount: 5 },
    { merchantId: "m1", shopId: "s1", orderId: "o2", productId: "p1", variantId: "v1", sku: "PX", title: "Picnic Xinomavro", quantity: 1, unitPrice: 80, totalPrice: 80, discount: 0 },
    { merchantId: "m1", shopId: "s-other", orderId: "o4", productId: "p4", variantId: "v4", sku: "SO", title: "Same Merchant Other Shop", quantity: 1, unitPrice: 8888, totalPrice: 8888, discount: 0 },
    ...(includeIgnoredImpactLine ? [{ merchantId: "m1", shopId: "s1", orderId: "o5", productId: "p1", variantId: "v1", sku: "PX", title: "Picnic Xinomavro", quantity: 5, unitPrice: 100, totalPrice: 500, discount: 0 }] : []),
    { merchantId: "m2", shopId: "s2", orderId: "o3", productId: "p3", variantId: "v3", sku: "OT", title: "Other Tenant Windfall", quantity: 1, unitPrice: 9999, totalPrice: 9999, discount: 0 },
  ];
  const inventoryLevels = [
    { merchantId: "m1", shopId: "s1", variantId: "v1", available: 0 },
    { merchantId: "m1", shopId: "s1", variantId: "v2", available: 5 },
    { merchantId: "m1", shopId: "s-other", variantId: "v4", available: 100 },
    { merchantId: "m2", shopId: "s2", variantId: "v3", available: 100 },
  ];
  const refunds = [
    { merchantId: "m1", shopId: "s1", orderId: "o1", amount: 20, currency: "GBP", processedAt: daysAgo(3), reason: "customer" },
    { merchantId: "m2", shopId: "s2", orderId: "o3", amount: 9999, currency: "GBP", processedAt: daysAgo(3), reason: "other" },
  ];

  return {
    product: { findMany: async ({ where }) => (onRead("product"), products.filter((row) => tenant(row, where))) },
    variant: { findMany: async ({ where }) => (onRead("variant"), variants.filter((row) => tenant(row, where))) },
    order: { findMany: async ({ where }) => (onRead("order"), orders.filter((row) => tenant(row, where) && inWindow(row.processedAt, where.processedAt))) },
    orderLineItem: {
      findMany: async ({ where }) =>
        (onRead("orderLineItem"),
        lineItems
          .filter((row) => tenant(row, where) && inWindow(orderById.get(row.orderId)?.processedAt, where.order?.processedAt))
          .map((row) => ({ ...row, order: orderById.get(row.orderId) }))),
    },
    inventoryLevel: { findMany: async ({ where }) => (onRead("inventoryLevel"), inventoryLevels.filter((row) => tenant(row, where))) },
    refund: {
      findMany: async ({ where }) =>
        (onRead("refund"),
        refunds
          .filter((row) => tenant(row, where) && inWindow(row.processedAt, where.processedAt))
          .map((row) => ({ ...row, order: orderById.get(row.orderId) }))),
    },
    actionExecution: { findMany: async () => [] },
  };
}

function lowCoverActionContext() {
  return {
    currentSystemContext: {
      blocks: [
        {
          kind: "structured_evidence",
          source: "merchant_memory",
          data: {
            key: "inventory.low_cover_products.trailing_30d",
            items: [
              { productId: "p1", title: "Picnic Xinomavro", available: 0, unitsSold: 3, dailyVelocity: 0.1, daysOfCover: 0 },
              { productId: "p2", title: "Pear Skin Sipon", available: 5, unitsSold: 1, dailyVelocity: 0.03, daysOfCover: 150 },
            ],
          },
        },
      ],
    },
  };
}

function variantOnlyActionContext() {
  return {
    currentSystemContext: {
      blocks: [
        {
          kind: "action_preview",
          source: "action_execution",
          data: {
            topItems: [
              { variantId: "v1", title: "Picnic Xinomavro" },
            ],
          },
        },
      ],
    },
  };
}

function daysAgo(days) {
  return new Date(NOW.getTime() - days * 86400000);
}

function tenant(row, where) {
  return row.merchantId === where.merchantId && (!where.shopId || row.shopId === where.shopId);
}

function inWindow(value, filter) {
  if (!filter) return true;
  const time = value?.getTime?.() ?? new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (filter.gte && time < filter.gte.getTime()) return false;
  if (filter.lte && time > filter.lte.getTime()) return false;
  return true;
}

test("a multi-currency money measure answers per currency instead of refusing", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma({ mixedCurrency: true }), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [{ id: "revenue", kind: "aggregate", measure: "revenue", window: { days: 60 } }],
  });

  const result = packet.results[0];
  assert.equal(result.ok, true);

  // Each figure is money in a STATED currency — which needs no FX. This is the
  // answer, not a consolation prize: 113 of 222 real merchants are multi-currency
  // and every one of them has a dominant currency, so refusing outright withholds
  // an answer that was available (founder ruling, 2026-08-12).
  const byCurrency = Object.fromEntries(result.rows.map((row) => [row.dimensions.currency, row.value]));
  assert.deepEqual(byCurrency, { GBP: 200, USD: 80 });
  assert.deepEqual(result.dataQuality.currencies, ["GBP", "USD"]);

  // The lead, so a caller can say "£200, 71% of value" rather than print every row.
  assert.equal(result.dataQuality.dominantCurrency, "GBP");
  // 200/280 — value-weighted, not row-weighted. Row-weighting would give 0.5 here.
  assert.equal(result.dataQuality.dominantCurrencyShare, 0.7143);

  // What must NOT happen: a cross-currency total. 200+80=280 is not money.
  assert.equal(result.currency, null);
  assert.equal(result.totals.value ?? null, null);
  assert.equal(result.dataQuality.moneyUnavailable, "multi_currency_no_conversion");
  assert.doesNotMatch(JSON.stringify(result.totals), /280/);

  // The refusal of a TOTAL carries the offer of the breakdown — never a dead end.
  assert.match(result.caveats.join(" "), /reported separately/i);
  assert.match(result.caveats.join(" "), /GBP is the largest at 71%/);
});

test("a single-currency store's result shape is unchanged by currency bucketing", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma(), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [{ id: "revenue", kind: "aggregate", measure: "revenue", window: { days: 60 } }],
  });

  const result = packet.results[0];
  // Money measures bucket by currency internally, but the dimension is stripped
  // back out when there is only one — otherwise 109 of 222 merchants would get a
  // changed row shape to fix a problem they do not have.
  assert.equal(result.rows.every((row) => row.dimensions.currency === undefined), true);
  assert.equal(result.currency, "GBP");
  assert.equal(result.totals.value, 280);
  assert.equal(result.dataQuality.moneyUnavailable, undefined);
});

test("currency is a requestable dimension, so per-market answers are first-class", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma({ mixedCurrency: true }), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [{
      id: "by_currency",
      kind: "breakdown",
      measure: "revenue",
      dimensions: ["currency"],
      window: { days: 60 },
    }],
  });

  const result = packet.results[0];
  assert.equal(result.ok, true);
  assert.deepEqual(result.dimensions, ["currency"]);
  assert.deepEqual(
    Object.fromEntries(result.rows.map((row) => [row.label, row.value])),
    { GBP: 200, USD: 80 },
  );
});

test("non-money measures are untouched by currency bucketing", async () => {
  const packet = await executeCommerceCalculations(createCommercePrisma({ mixedCurrency: true }), {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
    requests: [{ id: "units", kind: "aggregate", measure: "units_sold", window: { days: 60 } }],
  });

  const result = packet.results[0];
  // Units are countable across currencies; splitting them would be noise, and
  // withholding them would be worse — they are what stays answerable when money
  // does not.
  assert.equal(result.rows.every((row) => row.dimensions.currency === undefined), true);
  assert.equal(result.dataQuality.moneyUnavailable, undefined);
  // units_sold totals under `value` (totalsFromRows), not `unitsSold`.
  assert.ok(result.totals.value > 0);
});
