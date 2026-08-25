// @ts-check

import { createHash } from "node:crypto";
import { diffShopifyApiCatalogs, validateShopifyApiCatalog } from "./catalog.server.js";
import { classifyShopifyOperationDomain, inferShopifyOperationScopes } from "./domain-taxonomy.server.js";
import { classifyShopifyOperationSafety } from "./mutation-safety.server.js";

/**
 * Re-runs classifyShopifyOperationSafety over an already-generated catalog's operations without
 * needing a fresh Shopify introspection call — every input classification needs (operation,
 * operationKind, domain, scopeConfidence) is already baked into each stub. Used to pick up
 * mutation-safety.server.js changes (e.g. the 2026-08-25 execution-safety architecture change)
 * against the shipped catalog snapshot, and by the full-surface reconciliation report.
 * @param {import("./catalog.server.js").ShopifyApiCatalog} catalog
 * @returns {import("./catalog.server.js").ShopifyApiCatalog}
 */
export function reclassifyShopifyApiCatalog(catalog) {
  const operations = catalog.operations.map((op) => {
    const { safety, execution } = classifyShopifyOperationSafety({
      operation: op.operation,
      operationKind: op.operationKind,
      domain: op.domain,
      scopeConfidence: op.scopeConfidence,
    });
    return { ...op, safety, execution };
  });
  const next = { ...catalog, operations, generatedAt: new Date().toISOString() };
  const validation = validateShopifyApiCatalog(next);
  if (!validation.ok) {
    throw new Error(`Reclassified Shopify API catalog is invalid: ${validation.errors.join("; ")}`);
  }
  return next;
}

/**
 * @param {any} introspection
 * @param {{ apiVersion: string; generatedAt?: string }} options
 */
export function buildShopifyApiCatalogFromIntrospection(introspection, options) {
  const schema = introspection?.data?.__schema ?? introspection?.__schema ?? introspection;
  const types = Array.isArray(schema?.types) ? schema.types : [];
  const byName = new Map(types.map((type) => [type.name, type]));
  const operations = [];
  for (const [operationKind, typeName] of [
    ["QUERY", schema?.queryType?.name],
    ["MUTATION", schema?.mutationType?.name],
  ]) {
    const rootType = byName.get(typeName);
    for (const field of Array.isArray(rootType?.fields) ? rootType.fields : []) {
      operations.push(buildOperationStub(field, operationKind, byName, options.apiVersion));
    }
  }
  const catalog = {
    schemaVersion: "shopify-admin-api-stubs.v1",
    catalogId: `shopify-admin-api:${options.apiVersion}`,
    provider: "SHOPIFY",
    apiSurface: "admin_graphql",
    apiVersion: options.apiVersion,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generatedFrom: {
      kind: "admin_graphql_introspection",
      fingerprint: createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16),
    },
    operations,
  };
  const validation = validateShopifyApiCatalog(catalog);
  if (!validation.ok) {
    throw new Error(`Generated Shopify API catalog is invalid: ${validation.errors.join("; ")}`);
  }
  return catalog;
}

/**
 * @param {import("./catalog.server.js").ShopifyApiCatalog | null} previous
 * @param {import("./catalog.server.js").ShopifyApiCatalog} next
 */
export function renderShopifyApiGenerationReport(previous, next) {
  const diff = previous
    ? diffShopifyApiCatalogs(previous, next)
    : { added: next.operations.map((operation) => operation.id), removed: [], changed: [] };
  const lines = [
    "# Shopify Admin API Stub Generation",
    "",
    `Catalog: \`${next.catalogId}\``,
    `API version: \`${next.apiVersion}\``,
    `Generated at: \`${next.generatedAt}\``,
    "",
    `Operations: ${next.operations.length}`,
    `Queries: ${next.operations.filter((operation) => operation.operationKind === "QUERY").length}`,
    `Mutations: ${next.operations.filter((operation) => operation.operationKind === "MUTATION").length}`,
    "",
    "## Diff",
    "",
    `Added: ${diff.added.length}`,
    `Removed: ${diff.removed.length}`,
    `Changed: ${diff.changed.length}`,
  ];
  if (diff.added.length) lines.push("", "### Added", "", ...diff.added.map((id) => `- \`${id}\``));
  if (diff.removed.length) lines.push("", "### Removed", "", ...diff.removed.map((id) => `- \`${id}\``));
  if (diff.changed.length) {
    lines.push("", "### Changed", "");
    for (const change of diff.changed) {
      lines.push(`- \`${change.id}\`: ${change.changes.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {any} field
 * @param {"QUERY" | "MUTATION"} operationKind
 * @param {Map<string, any>} byName
 * @param {string} apiVersion
 */
function buildOperationStub(field, operationKind, byName, apiVersion) {
  const args = (field.args ?? []).map((arg) => ({
    name: arg.name,
    type: renderGraphqlType(arg.type),
    required: renderGraphqlType(arg.type).endsWith("!"),
  }));
  const inputObjects = {};
  const enumTypes = {};
  for (const arg of args) {
    collectTypeMetadata(arg.type, byName, inputObjects, enumTypes, new Set());
  }
  const domain = classifyShopifyOperationDomain(field.name);
  const { requiredScopes, scopeConfidence } = inferShopifyOperationScopes(field.name, domain, operationKind);
  const { safety, execution } = classifyShopifyOperationSafety({
    operation: field.name,
    operationKind,
    domain,
    scopeConfidence,
  });
  return {
    id: `shopify.admin_graphql.${apiVersion}.${operationKind.toLowerCase()}.${field.name}`,
    operation: field.name,
    operationKind,
    domain,
    description: cleanShopifyDescription(field.description) || `${operationKind === "QUERY" ? "Reads" : "Mutates"} Shopify ${field.name}.`,
    requiredScopes,
    scopeConfidence,
    safety,
    execution,
    arguments: args,
    inputObjects,
    enumTypes,
    returnType: renderGraphqlType(field.type),
    deprecation: {
      deprecated: Boolean(field.isDeprecated),
      reason: field.deprecationReason ?? null,
    },
    document: buildMinimalDocument(field.name, operationKind, args),
    tags: inferTags(field.name),
  };
}

/**
 * @param {string} typeName
 * @param {Map<string, any>} byName
 * @param {Record<string, any>} inputObjects
 * @param {Record<string, string[]>} enumTypes
 * @param {Set<string>} seen
 */
function collectTypeMetadata(typeName, byName, inputObjects, enumTypes, seen) {
  const named = unwrapTypeName(typeName);
  if (!named || seen.has(named)) return;
  seen.add(named);
  const type = byName.get(named);
  if (!type) return;
  if (type.kind === "ENUM") {
    enumTypes[named] = (type.enumValues ?? []).map((value) => value.name);
    return;
  }
  if (type.kind !== "INPUT_OBJECT") return;
  inputObjects[named] = {
    fields: (type.inputFields ?? []).map((field) => ({
      name: field.name,
      type: renderGraphqlType(field.type),
      required: renderGraphqlType(field.type).endsWith("!"),
    })),
  };
  for (const field of inputObjects[named].fields) {
    collectTypeMetadata(field.type, byName, inputObjects, enumTypes, seen);
  }
}

/** @param {any} typeRef */
export function renderGraphqlType(typeRef) {
  if (!typeRef) return "Unknown";
  if (typeRef.kind === "NON_NULL") return `${renderGraphqlType(typeRef.ofType)}!`;
  if (typeRef.kind === "LIST") return `[${renderGraphqlType(typeRef.ofType)}]`;
  return typeRef.name ?? "Unknown";
}

/** @param {string} rendered */
function unwrapTypeName(rendered) {
  return rendered.replace(/[![\]]/g, "");
}

/**
 * @param {string} operation
 * @param {"QUERY" | "MUTATION"} operationKind
 * @param {Array<{ name: string; type: string }>} args
 */
function buildMinimalDocument(operation, operationKind, args) {
  const variables = args.map((arg) => `$${arg.name}: ${arg.type}`).join(", ");
  const callArgs = args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const name = `Jefe${operation[0].toUpperCase()}${operation.slice(1)}`;
  const header = `${operationKind === "QUERY" ? "query" : "mutation"} ${name}${variables ? `(${variables})` : ""}`;
  return `${header} { ${operation}${callArgs ? `(${callArgs})` : ""} { __typename } }`;
}

// Shopify's schema descriptions are full markdown docs with embedded shopify.dev links —
// [`Product`](https://shopify.dev/...) repeated throughout. Left raw, those links flood both
// the retrieval scorer's token haystack (every description shares the same "docs", "api",
// "admin", "graphql", "objects" boilerplate, drowning out real signal) and every LLM prompt
// that includes a retrieved stub. Strip link syntax and truncate to the first real paragraph.
/** @param {string | null | undefined} raw */
function cleanShopifyDescription(raw) {
  const text = String(raw ?? "")
    .replace(/\[`?([^\]]+?)`?\]\([^)]*\)/g, "$1") // [`Product`](url) -> Product
    .replace(/https?:\/\/\S+/g, "") // any remaining bare URL
    .replace(/[`*>]/g, "") // markdown emphasis/quote noise
    .replace(/\s+/g, " ")
    .trim();
  const firstParagraph = text.split(/(?<=[.!?])\s(?=[A-Z])/)[0] ?? text;
  return (firstParagraph.length > 20 ? firstParagraph : text).slice(0, 320).trim();
}

/** @param {string} operation */
function inferTags(operation) {
  return operation
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
