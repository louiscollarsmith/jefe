#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateSyntheticShopifyDataset } from "./generator/index.mjs";
import { loadConfig } from "./config/load-config.mjs";
import { createManifest, loadRun, persistRun } from "./importers/manifest.mjs";
import { importDatasetToShopify } from "./importers/shopify.mjs";
import { cleanupSyntheticRun } from "./importers/cleanup.mjs";
import { wipeStore } from "./importers/wipe.mjs";
import { validateSyntheticDataset } from "./validators/dataset.mjs";
import { buildBeliefCoverageReport } from "./validators/coverage.mjs";
import { manifestPath, sourcePath, writeJson } from "./output-paths.mjs";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    switch (command) {
      case "plan":
        await plan(args);
        break;
      case "seed":
        await seed(args);
        break;
      case "resume":
        await resume(args);
        break;
      case "validate":
        await validate(args);
        break;
      case "coverage":
        await coverage(args);
        break;
      case "cleanup":
        await cleanup(args);
        break;
      case "wipe":
        await wipe(args);
        break;
      default:
        usage();
        process.exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error(formatCliError(error));
    process.exit(1);
  }
}

async function plan(args) {
  const { dataset, manifest } = createPlannedRun(args);
  persistRun({ dataset, manifest });
  console.log(JSON.stringify({
    command: "plan",
    runId: manifest.runId,
    shopDomain: manifest.shopDomain,
    plannedCounts: dataset.plannedCounts,
    metrics: dataset.metrics,
    sourcePath: sourcePath(manifest.shopDomain, manifest.runId),
    manifestPath: manifestPath(manifest.shopDomain, manifest.runId),
  }, null, 2));
}

async function seed(args) {
  const { dataset, manifest, loadedExistingRun } = createOrLoadPlannedRun(args);
  if (!loadedExistingRun) persistRun({ dataset, manifest });
  const validation = validateSyntheticDataset(dataset);
  if (!validation.ok) {
    throw new Error(`Generated dataset failed validation:\n${validation.failures.join("\n")}`);
  }
  const result = await importDatasetToShopify({
    dataset,
    manifest,
    dryRun: Boolean(args["dry-run"]),
    allowNonemptyStore: Boolean(args["allow-nonempty-store"]),
    credentialSource: args["credential-source"] ? String(args["credential-source"]) : "db",
  });
  console.log(JSON.stringify({
    command: "seed",
    dryRun: Boolean(args["dry-run"]),
    runId: manifest.runId,
    loadedExistingRun,
    manifestPath: manifestPath(manifest.shopDomain, manifest.runId),
    phaseStatus: result.manifest.phaseStatus,
  }, null, 2));
}

async function resume(args) {
  const shopDomain = requireArg(args, "shop");
  const runId = requireArg(args, "resume-run");
  const { dataset, manifest } = loadRun({ shopDomain, runId });
  const result = await importDatasetToShopify({
    dataset,
    manifest,
    dryRun: Boolean(args["dry-run"]),
    allowNonemptyStore: Boolean(args["allow-nonempty-store"]),
    credentialSource: args["credential-source"] ? String(args["credential-source"]) : "db",
  });
  console.log(JSON.stringify({
    command: "resume",
    runId,
    phaseStatus: result.manifest.phaseStatus,
    failures: result.manifest.failures,
  }, null, 2));
}

async function validate(args) {
  const { dataset, manifest } = getExistingOrGeneratedRun(args);
  const report = validateSyntheticDataset(dataset);
  const outputPath = `${sourcePath(manifest.shopDomain, manifest.runId).replace("source-dataset.json", "")}validation-report.json`;
  writeJson(outputPath, report);
  console.log(JSON.stringify({ command: "validate", ok: report.ok, outputPath, failures: report.failures, warnings: report.warnings }, null, 2));
  if (!report.ok) process.exit(1);
}

async function coverage(args) {
  const { dataset, manifest } = getExistingOrGeneratedRun(args);
  const report = buildBeliefCoverageReport(dataset);
  const outputPath = `${sourcePath(manifest.shopDomain, manifest.runId).replace("source-dataset.json", "")}belief-coverage.json`;
  writeJson(outputPath, report);
  console.log(JSON.stringify({ command: "coverage", definitions: report.length, outputPath }, null, 2));
}

async function cleanup(args) {
  const shopDomain = requireArg(args, "shop");
  const runId = requireArg(args, "resume-run");
  const summary = await cleanupSyntheticRun({
    shopDomain,
    runId,
    dryRun: Boolean(args["dry-run"]),
    allowNonemptyStore: Boolean(args["allow-nonempty-store"]),
    credentialSource: args["credential-source"] ? String(args["credential-source"]) : "db",
  });
  console.log(JSON.stringify(summary, null, 2));
}

async function wipe(args) {
  const shopDomain = requireArg(args, "shop");
  const summary = await wipeStore({
    shopDomain,
    dryRun: Boolean(args["dry-run"]) || !Boolean(args.yes),
    allowNonemptyStore: true,
    credentialSource: args["credential-source"] ? String(args["credential-source"]) : "db",
    includeOrders: Boolean(args["include-orders"]),
    yes: Boolean(args.yes),
  });
  console.log(JSON.stringify(summary, null, 2));
}

function createPlannedRun(args) {
  const config = loadConfig(args.config);
  const shopDomain = args.shop || "unbound.myshopify.com";
  const dataset = generateSyntheticShopifyDataset({
    shopDomain,
    profile: args.profile,
    seed: args.seed,
    asOf: args["as-of"],
    scenario: args.scenario,
    config,
  });
  const manifest = createManifest({ dataset, shopDomain });
  return { dataset, manifest };
}

export function createOrLoadPlannedRun(args) {
  const planned = createPlannedRun(args);
  const existingManifestPath = manifestPath(planned.manifest.shopDomain, planned.manifest.runId);
  const existingSourcePath = sourcePath(planned.manifest.shopDomain, planned.manifest.runId);
  if (fs.existsSync(existingManifestPath) && fs.existsSync(existingSourcePath)) {
    return {
      ...loadRun({
        shopDomain: planned.manifest.shopDomain,
        runId: planned.manifest.runId,
      }),
      loadedExistingRun: true,
    };
  }
  return { ...planned, loadedExistingRun: false };
}

function getExistingOrGeneratedRun(args) {
  if (args["resume-run"]) return loadRun({ shopDomain: requireArg(args, "shop"), runId: args["resume-run"] });
  const planned = createPlannedRun(args);
  if (!fs.existsSync(sourcePath(planned.manifest.shopDomain, planned.manifest.runId))) {
    persistRun(planned);
  }
  return planned;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function requireArg(args, key) {
  if (!args[key] || args[key] === true) throw new Error(`Missing required --${key}`);
  return String(args[key]);
}

function usage() {
  console.log(`Usage:
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- plan --shop jefe-wine-test.myshopify.com --profile realistic --seed 1042026 --as-of 2026-07-23T12:00:00+01:00
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- seed --shop jefe-wine-test.myshopify.com --dry-run
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- seed --shop jefe-wine-test.myshopify.com --credential-source env --dry-run
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- resume --shop jefe-wine-test.myshopify.com --resume-run synth_...
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- validate --shop jefe-wine-test.myshopify.com --resume-run synth_...
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- coverage --shop jefe-wine-test.myshopify.com --resume-run synth_...
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- cleanup --shop jefe-wine-test.myshopify.com --resume-run synth_... --dry-run
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- wipe --shop jefe-wine-test.myshopify.com --dry-run
  npm --prefix tools/synthetic-shopify run synthetic-shopify -- wipe --shop jefe-wine-test.myshopify.com --include-orders --yes`);
}

export function formatCliError(error) {
  if (!error || typeof error !== "object") return String(error);
  const formatted = {
    message: error instanceof Error ? error.message : String(error),
  };
  if ("name" in error && error.name) formatted.name = error.name;
  if ("status" in error && error.status) formatted.status = error.status;
  if ("requestId" in error && error.requestId) formatted.requestId = error.requestId;
  if ("retryAfterMs" in error && error.retryAfterMs) formatted.retryAfterMs = error.retryAfterMs;
  if ("errors" in error && error.errors) {
    formatted.shopifyErrors = error.errors;
  }
  if ("operationName" in error && error.operationName) {
    formatted.operationName = error.operationName;
  }
  if ("sourceId" in error && error.sourceId) {
    formatted.sourceId = error.sourceId;
  }
  if ("userErrors" in error && error.userErrors) {
    formatted.shopifyUserErrors = error.userErrors;
  }
  if (Object.keys(formatted).length === 1) return formatted.message;
  return JSON.stringify(formatted, null, 2);
}
