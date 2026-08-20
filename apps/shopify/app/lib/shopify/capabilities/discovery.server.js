// @ts-check

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  diffShopifyCapabilityCatalogs,
  loadShopifyCapabilityCatalog,
  validateShopifyCapabilityCatalog,
} from "./catalog.server.js";

export const FINAL_SHOPIFY_CAPABILITY_SEMANTIC_PROMPT = `You are analysing one Shopify Admin GraphQL operation.

The supplied schema and Shopify documentation are authoritative.

Explain the real-world commerce operation represented by this API.

Identify:
- what state it changes or reads,
- which Shopify entities it affects,
- what conditions logically need to be true for the operation to be useful,
- what evidence should be checked before proposing it,
- what inputs can likely be resolved automatically,
- what decisions may require merchant input,
- what outcomes could later be measured.

Do not invent Shopify functionality not present in the supplied API definition.
Do not map this operation to one hardcoded Jefe feature or recommendation.
Describe the capability generically.

Return JSON with semanticEffects, affectedEntities, requiredEntities, qualificationRequirements, autoResolvableInputs, merchantDecisionInputs, outcomes and tags.`;

/**
 * @param {{ seedCatalogPath?: string | URL; introspectionPath?: string | URL | null }} [input]
 */
export function discoverShopifyCapabilityCatalog(input = {}) {
  const catalog = input.seedCatalogPath
    ? loadShopifyCapabilityCatalog({ catalogPath: input.seedCatalogPath })
    : loadShopifyCapabilityCatalog();
  const introspectionOperations = input.introspectionPath
    ? extractOperationsFromIntrospectionJson(readJson(input.introspectionPath))
    : [];
  const validation = validateShopifyCapabilityCatalog(catalog);
  if (!validation.ok) {
    throw new Error(`Capability discovery produced invalid catalog: ${validation.errors.join("; ")}`);
  }
  return {
    catalog,
    introspection: {
      operationsSeen: introspectionOperations.length,
      matchedSeedOperations: introspectionOperations.filter((operation) =>
        catalog.operations.some((seed) => seed.operation === operation.operation),
      ).length,
    },
    fingerprint: catalogFingerprint(catalog),
  };
}

/**
 * @param {any} introspection
 */
export function extractOperationsFromIntrospectionJson(introspection) {
  const schema = introspection?.data?.__schema ?? introspection?.__schema ?? introspection;
  const types = Array.isArray(schema?.types) ? schema.types : [];
  const byName = new Map(types.map((type) => [type.name, type]));
  const rows = [];
  for (const [operationKind, typeName] of [
    ["MUTATION", schema?.mutationType?.name],
    ["QUERY", schema?.queryType?.name],
  ]) {
    const rootType = byName.get(typeName);
    for (const field of Array.isArray(rootType?.fields) ? rootType.fields : []) {
      rows.push({
        operation: field.name,
        operationKind,
        description: field.description ?? "",
        deprecated: Boolean(field.isDeprecated),
        deprecationReason: field.deprecationReason ?? null,
        arguments: (field.args ?? []).map((arg) => ({
          name: arg.name,
          type: renderGraphqlType(arg.type),
          required: renderGraphqlType(arg.type).endsWith("!"),
        })),
        outputType: renderGraphqlType(field.type),
      });
    }
  }
  return rows;
}

/**
 * @param {any} typeRef
 */
export function renderGraphqlType(typeRef) {
  if (!typeRef) return "Unknown";
  if (typeRef.kind === "NON_NULL") return `${renderGraphqlType(typeRef.ofType)}!`;
  if (typeRef.kind === "LIST") return `[${renderGraphqlType(typeRef.ofType)}]`;
  return typeRef.name ?? "Unknown";
}

/**
 * @param {import("./catalog.server.js").ShopifyCapabilityCatalog} catalog
 */
export function renderShopifyCapabilityReport(catalog) {
  const lines = [
    "# Shopify Capability Catalog",
    "",
    `Catalog: \`${catalog.catalogId}\``,
    "",
    `API version: \`${catalog.apiVersion}\``,
    "",
    `Machine-readable source: \`app/lib/shopify/capabilities/catalogs/shopify-capabilities-2026-07.json\``,
    "",
    "| Operation | Semantic effect | Write | Scope | Jefe support | Approval | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const operation of catalog.operations) {
    lines.push(
      [
        `\`${operation.operation}\``,
        escapePipes(operation.semantic.semanticEffects[0] ?? operation.description),
        operation.operationKind === "MUTATION" ? "yes" : "no",
        operation.requiredScopes.map((scope) => `\`${scope}\``).join(", ") || "none",
        operation.admission.jefeSupport,
        operation.admission.approvalRisk,
        operation.admission.status,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push(
    "",
    "## Architecture",
    "",
    "Before this catalogue, Jefe's executable Shopify knowledge was centred on action/use-case identifiers such as `execute:price_markdown:dead_stock` and `execute:shopify_inventory_transfer:restock`. The new substrate separates the provider primitive (`productVariantsBulkUpdate`, `inventoryTransferCreate`) from Jefe's business use case, semantic interpretation and execution admission.",
    "",
    "Runtime execution remains bounded: a capability can be discovered and semantically searched without becoming executable. Execution still requires an admitted manifest, required scopes, a Jefe executor, known inputs, approval/autonomy policy and the typed adapter path.",
    "",
    "## Discovery",
    "",
    "The deterministic development command is `npm run shopify:capabilities:discover`. It loads the versioned machine-readable catalogue, validates manifest structure, can compare optional Admin GraphQL introspection JSON supplied with `--introspection=path/to/schema.json`, and writes this report. The catalogue is tied to Shopify API version `2026-07`; a future API-version refresh should generate the new version beside this one, diff them, inspect changed operations, then migrate consumers.",
    "",
    "## Capability Manifest",
    "",
    "Each manifest keeps `technical` facts from Shopify's API contract separate from `semantic` interpretation. Technical facts include operation kind, input/output types, required arguments, user-error shape, scopes and deprecation. Semantic metadata carries provenance, effects, affected entities, qualification requirements, auto-resolvable inputs, merchant decisions, outcomes and retrieval tags.",
    "",
    "## Versioning",
    "",
    "`diffShopifyCapabilityCatalogs(previous, next)` reports added, removed and changed operations, including required scopes, argument contracts, input/output types, descriptions and deprecation. Consumers should resolve capabilities by stable provider refs plus API version, not by timeless mutation assumptions.",
    "",
    "## Existing Hardcoding",
    "",
    "The old action registry still exists because Task 2 has not migrated recommendation generation. Current typed adapters are preserved as Jefe executors: `clearance-adapter` maps to `productVariantsBulkUpdate`, `product-status-adapter` and `listing-copy-adapter` map to safe subsets of `productUpdate`, and `inventory-transfer-adapter` maps to `inventoryTransferCreate`. Business target names such as `dead_stock`, `missing_product_type`, `stale_listing` and `restock` are no longer canonical Shopify capability definitions; they remain compatibility refs for the existing recommendation/action flow.",
    "",
    "## Generalisation Proof",
    "",
    "The catalogue includes previously unmodelled operations without operation-specific opportunity code: `discountCodeBasicCreate`, `collectionCreate` and `metafieldsSet` all have semantic manifests and qualification plans. Search can retrieve them from conditions such as promotion/conversion, messy navigation or custom structured metadata, but availability resolution correctly reports missing adapter/scope or high-risk admission before execution.",
    "",
    "## Semantic Prompt",
    "",
    "```text",
    FINAL_SHOPIFY_CAPABILITY_SEMANTIC_PROMPT,
    "```",
    "",
    "## Inventory Transfer Qualification Proof",
    "",
    "`inventoryTransferCreate` is admitted as a generic Shopify operation for moving existing stock between locations. Its manifest requires `inventory.source.available_quantity` to be a positive number. A shortage with zero stock anywhere therefore fails qualification before recommendation generation, while a shortage with stock at another location can qualify once identities and location differences are resolved. No operation-specific restock rule is needed; the conclusion follows from the manifest requirement and the generic qualification evaluator.",
    "",
    "## Tests",
    "",
    "`tests/shopify-capability-catalog.test.mjs` covers schema parsing, API-versioned catalogue validation, required inputs/scopes, semantic provenance, capability search, qualification-plan generation, authorization resolution, safe execution admission, catalogue diffing, legacy adapter bridging, three unmodelled operations, and the inventory-transfer source-stock distinction.",
    "",
    "## Luna Evaluation",
    "",
    "The final Luna semantic prompt is checked in above. This local run did not call live Luna because the test runner disables external LLM calls and no production merchant data or secrets are used. The handoff path is to run the same prompt against one operation at a time in a development-safe environment, compare output to official Shopify descriptions, and update the manifest only after validation.",
    "",
    "## Failures Discovered",
    "",
    "The first pass showed the report was too thin for operator handoff, so the generator now includes architecture, discovery, versioning, hardcoding, generalisation and Task 2 notes. The inventory-transfer proof also forced the source-stock requirement to be explicit in the manifest rather than hidden in restock-specific code.",
    "",
    "## Task 2 Handoff",
    "",
    "Recommendation generation should retrieve a small set of candidate write capabilities with `searchShopifyCapabilities(condition, { writeOnly: true })`, build qualification plans with `buildShopifyCapabilityQualificationPlan`, satisfy evidence requirements from the canonical mirror before bounded Shopify reads, then call `resolveShopifyCapabilityAvailability` with declared scopes, merchant-granted scopes, API version, executor refs and input completeness. Only capabilities with `executionStatus: AVAILABLE` should become execute steps; everything else should become approve/reauth/instruct paths with the exact reason preserved."
  );
  return `${lines.join("\n")}\n`;
}

/**
 * @param {import("./catalog.server.js").ShopifyCapabilityCatalog} previous
 * @param {import("./catalog.server.js").ShopifyCapabilityCatalog} next
 */
export function summarizeCatalogDiff(previous, next) {
  const diff = diffShopifyCapabilityCatalogs(previous, next);
  return {
    apiVersionChanged: previous.apiVersion !== next.apiVersion,
    addedCount: diff.added.length,
    removedCount: diff.removed.length,
    changedCount: diff.changed.length,
    diff,
  };
}

/** @param {import("./catalog.server.js").ShopifyCapabilityCatalog} catalog */
export function catalogFingerprint(catalog) {
  return createHash("sha256")
    .update(JSON.stringify(catalog.operations))
    .digest("hex")
    .slice(0, 16);
}

/** @param {string | URL} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string} value */
function escapePipes(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}
