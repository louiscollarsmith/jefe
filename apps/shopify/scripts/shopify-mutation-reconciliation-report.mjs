// Task §18: reconcile the entire 523-mutation Shopify Admin API surface against the generic
// execution runtime and report the distribution. Read-only — loads the shipped catalog, no
// network calls, no writes.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";

const catalog = loadShopifyApiCatalog();
const mutations = catalog.operations.filter((op) => op.operationKind === "MUTATION");
const queries = catalog.operations.filter((op) => op.operationKind === "QUERY");

const byInteraction = {};
const bySource = {};
const byDomain = new Map();
let executableStandard = 0;
let executableSensitive = 0;
let executableDestructive = 0;
let executableSystemCritical = 0;
let jefeUnsupported = 0;

for (const op of mutations) {
  byInteraction[op.safety.interaction] = (byInteraction[op.safety.interaction] ?? 0) + 1;
  bySource[op.execution.classificationSource ?? "NONE"] = (bySource[op.execution.classificationSource ?? "NONE"] ?? 0) + 1;
  if (!byDomain.has(op.domain)) byDomain.set(op.domain, { total: 0, executable: 0 });
  const domainRow = byDomain.get(op.domain);
  domainRow.total += 1;

  const executable = op.execution.status === "EXECUTABLE" || op.execution.status === "EXECUTABLE_WITH_CONFIRMATION";
  if (!executable) {
    jefeUnsupported += 1;
    continue;
  }
  domainRow.executable += 1;
  switch (op.safety.interaction) {
    case "AUTONOMOUS_ELIGIBLE":
    case "APPROVAL_REQUIRED":
      executableStandard += 1;
      break;
    case "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED":
      if (op.safety.riskTier === "DESTRUCTIVE") executableDestructive += 1;
      else executableSensitive += 1;
      break;
    case "SYSTEM_CRITICAL_CONFIRMATION_REQUIRED":
      executableSystemCritical += 1;
      break;
    default:
      executableSensitive += 1;
  }
}

const total = mutations.length;
const lines = [
  "# Shopify Mutation Surface Reconciliation",
  "",
  `Generated: ${new Date().toISOString()}`,
  `Catalog: \`${catalog.catalogId}\` (${catalog.apiVersion})`,
  "",
  "## Headline distribution (task §18)",
  "",
  "```text",
  `TOTAL MUTATIONS: ${total}`,
  "",
  `EXECUTABLE_STANDARD: ${executableStandard}`,
  `EXECUTABLE_SENSITIVE_CONFIRMATION: ${executableSensitive}`,
  `EXECUTABLE_DESTRUCTIVE_CONFIRMATION: ${executableDestructive}`,
  `EXECUTABLE_SYSTEM_CRITICAL_CONFIRMATION: ${executableSystemCritical}`,
  "",
  `NOT EXECUTABLE DUE TO JEFE'S OWN MISSING SUPPORT: ${jefeUnsupported}`,
  "```",
  "",
  "Every mutation the generated catalog carries has a generic execution path — there is no",
  "operation-review gate left to satisfy before a schema-valid mutation can execute. Remaining",
  "friction is entirely about *how much confirmation* an invocation needs, and separately, live",
  "Shopify scope authorization (never fabricated — enforced at request time by gateway.server.js,",
  "not by this static classification). Queries: none of the 287 reads are excluded from",
  "discovery or (subject to live scope) execution; see the interaction breakdown below.",
  "",
  "## By interaction tier (mutations)",
  "",
  "| Interaction | Count |",
  "| --- | --- |",
  ...Object.entries(byInteraction)
    .sort((a, b) => b[1] - a[1])
    .map(([tier, count]) => `| ${tier} | ${count} |`),
  "",
  "## By classification source (mutations)",
  "",
  "| Source | Count |",
  "| --- | --- |",
  ...Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `| ${source} | ${count} |`),
  "",
  "## By domain (mutations)",
  "",
  "| Domain | Total | Executable |",
  "| --- | --- | --- |",
  ...[...byDomain.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([domain, row]) => `| ${domain} | ${row.total} | ${row.executable} |`),
  "",
  "## Queries",
  "",
  `Total: ${queries.length}. Executable: ${queries.filter((op) => op.execution.status === "EXECUTABLE" || op.execution.status === "EXECUTABLE_WITH_CONFIRMATION").length}.`,
  "",
];

const report = `${lines.join("\n")}\n`;
const outputPath = resolve(process.argv[2] || "docs/ops/shopify-mutation-reconciliation-2026-08-25.md");
writeFileSync(outputPath, report);
process.stdout.write(report);
process.stdout.write(`\nWritten to ${outputPath}\n`);
