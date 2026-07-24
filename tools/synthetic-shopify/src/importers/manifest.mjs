// @ts-check
import fs from "node:fs";
import { manifestPath, readJson, sourcePath, writeJson } from "../output-paths.mjs";

export const IMPORT_PHASES = [
  "validate_destination",
  "create_manifest",
  "generate_dataset",
  "create_products",
  "create_collections",
  "create_variants",
  "create_locations",
  "set_inventory",
  "create_customers",
  "create_orders",
  "create_refunds",
  "validate_shopify_counts",
  "commercial_reconciliation",
  "belief_coverage",
];

export function createManifest({ dataset, shopDomain }) {
  return {
    runId: dataset.meta.runId,
    randomSeed: dataset.meta.randomSeed,
    profile: dataset.meta.profile,
    scenario: dataset.meta.scenario,
    asOf: dataset.meta.asOf,
    shopDomain,
    apiVersion: dataset.meta.apiVersion,
    plannedCounts: dataset.plannedCounts,
    completedCounts: Object.fromEntries(IMPORT_PHASES.map((phase) => [phase, 0])),
    phaseStatus: Object.fromEntries(IMPORT_PHASES.map((phase) => [phase, "pending"])),
    sourceToShopifyIds: {
      products: {},
      variants: {},
      customers: {},
      orders: {},
      refunds: {},
      collections: {},
      locations: {},
      inventoryItems: {},
      lineItems: {},
      transactions: {},
    },
    failures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function persistRun({ dataset, manifest }) {
  writeJson(sourcePath(manifest.shopDomain, manifest.runId), dataset);
  writeJson(manifestPath(manifest.shopDomain, manifest.runId), manifest);
}

export function loadRun({ shopDomain, runId }) {
  const manifestFile = manifestPath(shopDomain, runId);
  if (!fs.existsSync(manifestFile)) throw new Error(`No manifest found at ${manifestFile}`);
  const manifest = readJson(manifestFile);
  const sourceFile = sourcePath(shopDomain, runId);
  if (!fs.existsSync(sourceFile)) throw new Error(`No source dataset found at ${sourceFile}`);
  return { manifest, dataset: readJson(sourceFile) };
}

export function markPhase(manifest, phase, status, count = 0) {
  manifest.phaseStatus[phase] = status;
  manifest.completedCounts[phase] = count;
  manifest.updatedAt = new Date().toISOString();
}

export function recordMapping(manifest, type, sourceId, shopifyId) {
  manifest.sourceToShopifyIds[type][sourceId] = shopifyId;
  const entityType = {
    products: "product",
    variants: "variant",
    customers: "customer",
    orders: "order",
    refunds: "refund",
    collections: "collection",
    locations: "location",
  }[type];
  if (entityType) {
    for (const failure of manifest.failures) {
      if (failure.entityType === entityType && failure.sourceId === sourceId && !failure.resolvedAt) {
        failure.resolvedAt = new Date().toISOString();
      }
    }
  }
  manifest.updatedAt = new Date().toISOString();
}

export function recordFailure(manifest, entityType, sourceId, error, retryable = true) {
  manifest.failures.push({ entityType, sourceId, error: String(error?.message || error), retryable });
  manifest.updatedAt = new Date().toISOString();
}
