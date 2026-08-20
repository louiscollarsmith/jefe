#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  discoverShopifyCapabilityCatalog,
  renderShopifyCapabilityReport,
} from "../app/lib/shopify/capabilities/discovery.server.js";

const args = new Set(process.argv.slice(2));
const introspectionArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--introspection="));
const reportPathArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--report="));

const introspectionPath = introspectionArg
  ? resolve(introspectionArg.split("=").slice(1).join("="))
  : null;
const reportPath = reportPathArg
  ? resolve(reportPathArg.split("=").slice(1).join("="))
  : resolve("docs/ops/shopify-capability-catalog.md");

const result = discoverShopifyCapabilityCatalog({ introspectionPath });
const report = renderShopifyCapabilityReport(result.catalog);

if (!args.has("--check")) {
  writeFileSync(reportPath, report);
}

process.stdout.write(
  [
    `catalog=${result.catalog.catalogId}`,
    `apiVersion=${result.catalog.apiVersion}`,
    `operations=${result.catalog.operations.length}`,
    `fingerprint=${result.fingerprint}`,
    `introspectionOperationsSeen=${result.introspection.operationsSeen}`,
    `introspectionMatchedSeedOperations=${result.introspection.matchedSeedOperations}`,
    args.has("--check") ? "mode=check" : `report=${reportPath}`,
  ].join("\n") + "\n",
);
