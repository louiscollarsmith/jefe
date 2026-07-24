// @ts-check
import { DETERMINISTIC_BELIEF_REGISTRY } from "../../../../apps/shopify/app/lib/merchant-memory/deterministic-belief-registry.server.js";

const EXERCISED_TOPICS = [
  ["catalog", ["products", "variants", "statuses", "prices", "collections", "sku quality"]],
  ["inventory", ["positive inventory", "zero stock", "low stock", "negative stock", "tracked variant coverage"]],
  ["customers", ["known customers", "guest orders", "repeat customer rate", "VIP repeat tail"]],
  ["orders", ["7/30/90/180 day windows", "AOV", "basket sizes", "discounts", "shipping threshold", "currency consistency"]],
  ["refunds", ["refund records", "refund line items", "successful refund transactions", "refund timing"]],
  ["data", ["link coverage", "stored-history completeness", "healthy anomaly zeros"]],
  ["business", ["store currency", "store name fallback"]],
];

export function buildBeliefCoverageReport(dataset) {
  const healthy = dataset.meta.scenario === "healthy_gbp";
  return DETERMINISTIC_BELIEF_REGISTRY.map((definition) => {
    const categoryTopics = EXERCISED_TOPICS.find(([category]) => definition.key.startsWith(`${category}.`))?.[1] || ["synthetic Shopify evidence"];
    const anomaly = /duplicate|blank|zero_value|missing|orphan|malformed|negative|mixed_currency|custom_line/i.test(definition.key);
    const expectedOutcome = healthy && anomaly
      ? "derived_zero"
      : expectedOutcomeForDefinition(definition, dataset);
    return {
      beliefKey: definition.key,
      expectedOutcome,
      expectedRange: expectedRange(definition.key, dataset),
      supportingSyntheticInputs: categoryTopics,
      notes: definition.tranche,
    };
  });
}

function expectedOutcomeForDefinition(definition, dataset) {
  const key = definition.key;
  if (key.includes("inventory") && dataset.inventoryLevels.length === 0) return "insufficient_data";
  if (key.includes("refund") && dataset.refunds.length === 0) return "insufficient_data";
  if (key.includes("currency") && dataset.meta.scenario === "quality_edge_cases") return "blocked_by_data_quality";
  if (definition.minimumData?.toLowerCase?.().includes("not applicable")) return "not_applicable";
  return "derived";
}

function expectedRange(key, dataset) {
  const counts = dataset.plannedCounts;
  const metrics = dataset.metrics;
  if (key.includes("active_product_count")) return range(counts.activeProducts, 0);
  if (key.includes("product_count")) return range(counts.products, 2);
  if (key.includes("variant_count")) return range(counts.variants, 2);
  if (key.includes("customer") && key.includes("count")) return range(counts.customers, 0);
  if (key.includes("order") && key.includes("count")) return range(counts.nonTestOrders, 12);
  if (key.includes("repeat_customer_rate")) return range(metrics.customers.repeatCustomerRate, 3);
  if (key.includes("refund") && key.includes("incidence")) return range(metrics.refunds.refundedOrderIncidence, 1.5);
  if (key.includes("average_order_value")) return range(metrics.orderValue.mean, 8);
  if (key.includes("median")) return range(metrics.orderValue.median, 8);
  if (key.includes("positive_available_units")) return range(metrics.inventory.positiveStock, Math.max(10, metrics.inventory.positiveStock * 0.05));
  if (key.includes("negative_inventory")) return range(metrics.inventory.negativeStockMagnitude, Math.max(1, metrics.inventory.negativeStockMagnitude));
  return undefined;
}

function range(value, tolerance) {
  return { min: Number((value - tolerance).toFixed(2)), max: Number((value + tolerance).toFixed(2)) };
}
