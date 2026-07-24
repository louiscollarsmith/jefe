// @ts-check
import { money, quantile, shippingForMerchandise } from "../generator/money.mjs";

/**
 * @param {ReturnType<import("../generator/index.mjs").generateSyntheticShopifyDataset>} dataset
 */
export function validateSyntheticDataset(dataset) {
  const failures = [];
  const warnings = [];
  const normalOrders = dataset.orders.filter((order) => !order.isTest);
  const productsById = new Map(dataset.products.map((product) => [product.sourceId, product]));
  const variantsById = new Map(dataset.products.flatMap((product) => product.variants.map((variant) => [variant.sourceId, variant])));
  const customersById = new Map(dataset.customers.map((customer) => [customer.sourceId, customer]));
  expectUnique(
    failures,
    "product source IDs",
    dataset.products.map((product) => product.sourceId),
  );
  expectUnique(
    failures,
    "product handles",
    dataset.products.map((product) => product.handle),
  );
  expectUnique(
    failures,
    "variant source IDs",
    dataset.products.flatMap((product) => product.variants.map((variant) => variant.sourceId)),
  );
  expectUnique(
    failures,
    "customer emails",
    dataset.customers.map((customer) => customer.email),
  );
  expectUnique(
    failures,
    "order source IDs",
    dataset.orders.map((order) => order.sourceId),
  );

  expectEqual(failures, "active product count", dataset.plannedCounts.activeProducts, dataset.products.filter((product) => product.status === "ACTIVE").length);
  expectEqual(failures, "archived product count", dataset.plannedCounts.archivedProducts, dataset.products.filter((product) => product.status === "ARCHIVED").length);
  expectEqual(failures, "draft product count", dataset.plannedCounts.draftProducts, dataset.products.filter((product) => product.status === "DRAFT").length);
  expectEqual(failures, "refund transaction count", dataset.refunds.length, dataset.refunds.filter((refund) => refund.transactions.some((transaction) => transaction.status === "SUCCESS")).length);

  for (const customer of dataset.customers) {
    if (!customer.email.endsWith("@example.com")) failures.push(`Customer ${customer.sourceId} uses a non-reserved email address`);
    if (customer.phone) failures.push(`Customer ${customer.sourceId} unexpectedly has a phone number`);
  }

  for (const product of dataset.products) {
    expectUnique(
      failures,
      `${product.sourceId} option values`,
      product.variants.map((variant) => variant.optionValue),
    );
  }

  for (const order of dataset.orders) {
    if (order.customerSourceId && !customersById.has(order.customerSourceId)) failures.push(`Order ${order.sourceId} references unknown customer ${order.customerSourceId}`);
    if (order.email && !order.email.endsWith("@example.com")) failures.push(`Order ${order.sourceId} uses a non-reserved email address`);
    for (const line of order.lineItems) {
      if (line.productSourceId && !productsById.has(line.productSourceId)) failures.push(`Line item ${line.sourceId} references unknown product ${line.productSourceId}`);
      if (line.variantSourceId && !variantsById.has(line.variantSourceId)) failures.push(`Line item ${line.sourceId} references unknown variant ${line.variantSourceId}`);
    }
    const subtotal = money(order.lineItems.reduce((sum, line) => sum + line.totalPrice, 0));
    const expectedTotal = money(subtotal - order.totalDiscount + order.totalShipping + order.totalTax);
    if (Math.abs(expectedTotal - order.totalPrice) > 0.02) failures.push(`Order ${order.sourceId} does not reconcile: expected ${expectedTotal}, found ${order.totalPrice}`);
    if (!order.isTest && order.totalPrice > 0) {
      const expectedShipping = order.discountCode === "SHIPFREE" ? 0 : shippingForMerchandise(money(subtotal - order.totalDiscount));
      if (Math.abs(expectedShipping - order.totalShipping) > 0.02) failures.push(`Order ${order.sourceId} shipping is ${order.totalShipping}, expected ${expectedShipping}`);
    }
  }

  for (const refund of dataset.refunds) {
    const order = dataset.orders.find((candidate) => candidate.sourceId === refund.orderSourceId);
    if (!order) {
      failures.push(`Refund ${refund.sourceId} references unknown order ${refund.orderSourceId}`);
      continue;
    }
    if (new Date(refund.processedAt).getTime() <= new Date(order.processedAt).getTime()) failures.push(`Refund ${refund.sourceId} is not after its order`);
    if (refund.amount <= 0) failures.push(`Refund ${refund.sourceId} amount must be greater than zero`);
    const transactionTotal = money(refund.transactions.filter((transaction) => transaction.status === "SUCCESS").reduce((sum, transaction) => sum + transaction.amount, 0));
    if (transactionTotal <= 0) failures.push(`Refund ${refund.sourceId} successful transaction total must be greater than zero`);
    if (Math.abs(transactionTotal - refund.amount) > 0.02) failures.push(`Refund ${refund.sourceId} does not reconcile to successful refund transactions`);
    for (const item of refund.refundLineItems) {
      if (!order.lineItems.some((line) => line.sourceId === item.orderLineItemSourceId)) failures.push(`Refund ${refund.sourceId} references unknown original line item ${item.orderLineItemSourceId}`);
    }
  }
  for (const order of dataset.orders) {
    const orderRefunds = dataset.refunds.filter((refund) => refund.orderSourceId === order.sourceId);
    const refundedTotal = money(orderRefunds.reduce((sum, refund) => sum + refund.amount, 0));
    if (refundedTotal - order.totalPrice > 0.02) failures.push(`Refunds for ${order.sourceId} total ${refundedTotal}, greater than order payment ${order.totalPrice}`);
    for (const line of order.lineItems) {
      const refundedQuantity = orderRefunds
        .flatMap((refund) => refund.refundLineItems)
        .filter((item) => item.orderLineItemSourceId === line.sourceId)
        .reduce((sum, item) => sum + item.quantity, 0);
      if (refundedQuantity > line.quantity) failures.push(`Refunds for ${order.sourceId} line ${line.sourceId} refund quantity ${refundedQuantity}, greater than purchased quantity ${line.quantity}`);
    }
  }

  const values = normalOrders.map((order) => order.totalPrice);
  const itemCounts = normalOrders.map((order) => order.lineItems.reduce((sum, line) => sum + line.quantity, 0));
  const report = {
    ok: failures.length === 0,
    failures,
    warnings,
    counts: dataset.plannedCounts,
    grossOrderValueByCurrency: groupSum(normalOrders, "currency", "totalPrice"),
    refundAmountByCurrency: groupSum(dataset.refunds, "currency", "amount"),
    orderValue: {
      mean: average(values),
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      p75: quantile(values, 0.75),
      p90: quantile(values, 0.9),
    },
    baskets: {
      averageItems: average(itemCounts),
      medianItems: quantile(itemCounts, 0.5),
      singleBottleShare: percentage(itemCounts.filter((count) => count === 1).length, itemCounts.length),
      multiBottleShare: percentage(itemCounts.filter((count) => count > 1).length, itemCounts.length),
      largeBasketShare: percentage(itemCounts.filter((count) => count >= 4).length, itemCounts.length),
    },
    customers: {
      knownOrderShare: percentage(normalOrders.filter((order) => order.customerSourceId).length, normalOrders.length),
      guestOrderShare: percentage(normalOrders.filter((order) => !order.customerSourceId).length, normalOrders.length),
      repeatCustomerRate: repeatCustomerRate(dataset.customers, normalOrders),
    },
    inventory: inventorySummary(dataset.inventoryLevels),
  };

  if (report.baskets.singleBottleShare < 30 || report.baskets.singleBottleShare > 55) warnings.push("Single-bottle order share is outside target tolerance");
  if (report.customers.guestOrderShare < 4 || report.customers.guestOrderShare > 10) warnings.push("Guest order share is outside target tolerance");
  return report;
}

export function assertDatasetValid(dataset) {
  const report = validateSyntheticDataset(dataset);
  if (!report.ok) {
    throw new Error(`Synthetic dataset validation failed:\n${report.failures.join("\n")}`);
  }
  return report;
}

function expectEqual(failures, label, expected, actual) {
  if (expected !== actual) failures.push(`${label}: expected ${expected}, found ${actual}`);
}

function expectUnique(failures, label, values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    const key = String(value || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(value);
    seen.add(key);
  }
  if (duplicates.size) failures.push(`${label} must be unique: ${[...duplicates].join(", ")}`);
}

function groupSum(rows, key, valueKey) {
  const grouped = {};
  for (const row of rows) {
    grouped[row[key]] = money((grouped[row[key]] || 0) + (row[valueKey] || 0));
  }
  return grouped;
}

function average(values) {
  if (!values.length) return 0;
  return money(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentage(numerator, denominator) {
  if (!denominator) return 0;
  return money((numerator / denominator) * 100);
}

function repeatCustomerRate(customers, orders) {
  const counts = new Map();
  for (const order of orders) {
    if (order.customerSourceId) counts.set(order.customerSourceId, (counts.get(order.customerSourceId) || 0) + 1);
  }
  return percentage([...counts.values()].filter((count) => count > 1).length, customers.length);
}

function inventorySummary(levels) {
  return {
    levelCount: levels.length,
    positiveStock: levels.filter((level) => level.available > 0).reduce((sum, level) => sum + level.available, 0),
    zeroStockVariants: new Set(levels.filter((level) => level.available === 0).map((level) => level.variantSourceId)).size,
    negativeStockMagnitude: Math.abs(levels.filter((level) => level.available < 0).reduce((sum, level) => sum + level.available, 0)),
    lowStockVariants: new Set(levels.filter((level) => level.available > 0 && level.available <= 3).map((level) => level.variantSourceId)).size,
  };
}
