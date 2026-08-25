// @ts-check
//
// Targeted schema discovery for the Agentic Shopify Gateway (docs/ops/agentic-shopify-gateway-full/).
//
// Source of truth note: this index is built from the checked-in pinned schema cache
// (schema-cache.server.js / schema-cache/shopify-admin-schema-<version>.json), itself produced by
// live Admin GraphQL introspection. This module never restricts which operations the agent may
// query or mutate — see document.server.js, which classifies and validates ANY root field name the
// agent writes, cache-known or not, via the same name/domain-structural rules regardless
// (domain-taxonomy.server.js, mutation-safety.server.js). The cache is used here purely as the most
// complete locally available snapshot of real Shopify type/argument/enum/description data. When a
// live Shopify Admin token is available, the identical index can be rebuilt from a fresh
// introspection call instead (loadGatewaySchemaIndex accepts a pre-built cache for exactly this
// reason) — nothing about the gateway's request/validation/execution path depends on which source
// produced it.
//
// What this index genuinely supports: root Query/Mutation field existence, argument names/types/
// required-ness, enum values, input-object shapes, and descriptions — everything Shopify captured
// during introspection. What it does NOT support: full object-type (e.g. Product, Order) field
// graphs, because the cache only walks the argument/input type graph reachable from each root
// field, not arbitrary output selections. A selection-set field that doesn't exist is caught by
// Shopify's own GraphQL response, not locally — see document.server.js's normalized-error path,
// which is the explicitly sanctioned fallback for exactly this gap (Part 3: "If Shopify rejects a
// field or arguments, return a compact error that allows the LLM to repair its query").

import { loadPinnedShopifySchemaCache } from "./schema-cache.server.js";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

/** @typedef {import("./schema-cache.server.js").PinnedSchemaCache} PinnedSchemaCache */

/**
 * @param {{ catalog?: PinnedSchemaCache }} [input]
 */
export function loadGatewaySchemaIndex(input = {}) {
  const catalog = input.catalog ?? loadPinnedShopifySchemaCache();
  /** @type {Map<string, any>} */
  const byOperation = new Map();
  for (const operation of catalog.operations) {
    byOperation.set(operation.operation, operation);
  }
  return {
    apiVersion: catalog.apiVersion,
    generatedAt: catalog.generatedAt ?? null,
    generatedFrom: catalog.generatedFrom ?? "pinned-schema-introspection-snapshot",
    operationCount: catalog.operations.length,
    byOperation,
  };
}

/**
 * @typedef {ReturnType<typeof loadGatewaySchemaIndex>} GatewaySchemaIndex
 */

/**
 * Observability signal for /health — reports how big/fresh the Gateway's pinned schema cache is,
 * mirroring what the retired catalog health check reported (docs/ops/agentic-shopify-gateway-full/
 * Part 12/17).
 * @param {GatewaySchemaIndex} [index]
 */
export function getGatewaySchemaHealth(index = loadGatewaySchemaIndex()) {
  let queries = 0;
  let mutations = 0;
  for (const operation of index.byOperation.values()) {
    if (operation.operationKind === "MUTATION") mutations += 1;
    else queries += 1;
  }
  return {
    status: index.operationCount ? "ok" : "unavailable",
    apiVersion: index.apiVersion,
    fields: index.operationCount,
    queries,
    mutations,
    generatedAt: index.generatedAt,
    generatedFrom: index.generatedFrom,
  };
}

/**
 * Targeted keyword/relevance search over root Query/Mutation fields — returns compact summaries,
 * never full type dumps. This is the tool-facing "search types/fields by concept" primitive.
 * @param {GatewaySchemaIndex} index
 * @param {string} queryText
 * @param {{ kind?: "QUERY" | "MUTATION"; limit?: number }} [options]
 */
export function searchGatewaySchema(index, queryText, options = {}) {
  const terms = tokenize(queryText);
  const limit = boundedLimit(options.limit);
  /** @type {Array<{ operation: any; score: number }>} */
  const scored = [];
  for (const operation of index.byOperation.values()) {
    if (options.kind && operation.operationKind !== options.kind) continue;
    const score = relevanceScore(terms, operation);
    if (score > 0) scored.push({ operation, score });
  }
  scored.sort((a, b) => b.score - a.score || a.operation.operation.localeCompare(b.operation.operation));
  return scored.slice(0, limit).map(({ operation }) => summarizeField(operation));
}

/**
 * @param {GatewaySchemaIndex} index
 * @param {string} fieldName
 */
export function inspectGatewayField(index, fieldName) {
  const operation = index.byOperation.get(fieldName);
  if (!operation) return null;
  return {
    operation: operation.operation,
    operationKind: operation.operationKind,
    domain: operation.domain,
    description: truncate(operation.description, 600),
    returnType: operation.returnType,
    deprecation: operation.deprecation,
    requiredScopes: operation.requiredScopes,
    scopeConfidence: operation.scopeConfidence,
    arguments: (operation.arguments ?? []).map((argument) => ({
      name: argument.name,
      type: argument.type,
      required: argument.required,
    })),
    inputObjects: compactTypeMap(operation.inputObjects),
    enumTypes: compactTypeMap(operation.enumTypes),
  };
}

/**
 * Root Query or Mutation field names only (names, not full definitions) — the "inspect root
 * query/mutation fields" primitive. Bounded so an agent enumerating the surface never floods
 * context; pair with search/inspect for detail.
 * @param {GatewaySchemaIndex} index
 * @param {"QUERY" | "MUTATION"} kind
 * @param {{ prefix?: string; limit?: number }} [options]
 */
export function listGatewayRootFields(index, kind, options = {}) {
  const prefix = (options.prefix ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const names = [];
  for (const operation of index.byOperation.values()) {
    if (operation.operationKind !== kind) continue;
    if (prefix && !operation.operation.toLowerCase().includes(prefix)) continue;
    names.push(operation.operation);
  }
  names.sort();
  return names.slice(0, limit);
}

/**
 * @param {GatewaySchemaIndex} index
 * @param {string} typeName
 */
export function inspectGatewayEnum(index, typeName) {
  for (const operation of index.byOperation.values()) {
    const values = operation.enumTypes?.[typeName];
    if (values) return { type: typeName, values };
  }
  return null;
}

/**
 * @param {GatewaySchemaIndex} index
 * @param {string} typeName
 */
export function inspectGatewayInputObject(index, typeName) {
  for (const operation of index.byOperation.values()) {
    const fields = operation.inputObjects?.[typeName];
    if (fields) return { type: typeName, fields };
  }
  return null;
}

/** @param {any} operation */
function summarizeField(operation) {
  return {
    operation: operation.operation,
    operationKind: operation.operationKind,
    domain: operation.domain,
    description: truncate(operation.description, 220),
    returnType: operation.returnType,
    argumentNames: (operation.arguments ?? []).map((argument) => argument.name),
    deprecated: Boolean(operation.deprecation?.deprecated),
  };
}

/** @param {string} text */
function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** @param {string[]} terms @param {any} operation */
function relevanceScore(terms, operation) {
  if (!terms.length) return 0;
  const haystack = `${operation.operation} ${operation.domain} ${operation.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (operation.operation.toLowerCase().includes(term)) score += 5;
    if (operation.domain.toLowerCase() === term) score += 3;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/** @param {unknown} value */
function boundedLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(number))) : DEFAULT_SEARCH_LIMIT;
}

/** @param {string | null | undefined} text @param {number} max */
function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** @param {Record<string, any> | undefined} typeMap */
function compactTypeMap(typeMap) {
  if (!typeMap || typeof typeMap !== "object") return {};
  const entries = Object.entries(typeMap).slice(0, 12);
  return Object.fromEntries(entries);
}
