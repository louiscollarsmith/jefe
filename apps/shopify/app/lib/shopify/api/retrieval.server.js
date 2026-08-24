// @ts-check

import { listShopifyApiOperationStubs, loadShopifyApiCatalog } from "./catalog.server.js";
import { expandShopifyQueryTerms } from "./query-expansions.server.js";

// High-frequency English function words that appear in nearly every operation description
// (itself derived from Shopify's own docs prose) and would otherwise inflate the score of
// operations that share no real signal with the query.
const STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "into", "your", "you",
  "are", "was", "were", "will", "can", "use", "used", "using", "not", "any",
]);

/**
 * @param {string} query
 * @param {{
 *   catalog?: import("./catalog.server.js").ShopifyApiCatalog;
 *   operationKind?: "QUERY" | "MUTATION";
 *   limit?: number;
 *   domains?: string[];
 * }} [options]
 */
export function retrieveShopifyApiOperations(query, options = {}) {
  const catalog = options.catalog ?? loadShopifyApiCatalog();
  const expansions = [...expandShopifyQueryTerms(query)].join(" ");
  const tokens = new Set([...tokenize(query), ...tokenize(expansions)]);
  const domains = new Set(options.domains ?? []);
  return listShopifyApiOperationStubs({ catalog, operationKind: options.operationKind })
    .filter((operation) => !domains.size || domains.has(operation.domain))
    .map((operation) => ({
      operation,
      score: scoreOperation(operation, tokens),
      matchedTerms: matchedTerms(operation, tokens),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.operation.operation.localeCompare(b.operation.operation))
    .slice(0, options.limit ?? 8)
    .map((row) => ({
      id: row.operation.id,
      operation: row.operation.operation,
      operationKind: row.operation.operationKind,
      domain: row.operation.domain,
      description: row.operation.description,
      requiredScopes: row.operation.requiredScopes,
      arguments: row.operation.arguments,
      tags: row.operation.tags,
      matchedTerms: row.matchedTerms,
      score: row.score,
    }));
}

/**
 * @param {import("./catalog.server.js").ShopifyApiCatalog} [catalog]
 */
export function getShopifyApiCatalogHealth(catalog = loadShopifyApiCatalog()) {
  const byKind = countBy(catalog.operations, (operation) => operation.operationKind);
  const byDomain = countBy(catalog.operations, (operation) => operation.domain);
  return {
    status: catalog.operations.length ? "ok" : "unavailable",
    catalogId: catalog.catalogId,
    apiVersion: catalog.apiVersion,
    operations: catalog.operations.length,
    queries: byKind.QUERY ?? 0,
    mutations: byKind.MUTATION ?? 0,
    domains: byDomain,
    generatedAt: catalog.generatedAt,
  };
}

/** @param {string} value */
function tokenize(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
      .map(singularize),
  );
}

// Light, internal-matching-only singularization (not linguistically complete) so "collection"
// (query/operation-name form) and "collections" (a plural domain id) score as the same term.
// Applied uniformly to both the query and every haystack field, so it only ever helps recall.
/** @param {string} token */
function singularize(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/**
 * @param {import("./catalog.server.js").ShopifyApiOperationStub} operation
 * @param {Set<string>} tokens
 */
function scoreOperation(operation, tokens) {
  const haystack = {
    operation: tokenize(operation.operation),
    domain: tokenize(operation.domain),
    tags: tokenize(operation.tags.join(" ")),
    description: tokenize(operation.description),
  };
  let score = 0;
  for (const token of tokens) {
    if (haystack.operation.has(token)) score += 8;
    if (haystack.domain.has(token)) score += 5;
    if (haystack.tags.has(token)) score += 4;
    if (haystack.description.has(token)) score += 2;
  }
  return score;
}

/**
 * @param {import("./catalog.server.js").ShopifyApiOperationStub} operation
 * @param {Set<string>} tokens
 */
function matchedTerms(operation, tokens) {
  const text = tokenize(
    [
      operation.operation,
      operation.domain,
      operation.description,
      operation.tags.join(" "),
    ].join(" "),
  );
  return [...tokens].filter((token) => text.has(token)).sort();
}

/**
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyFor
 */
function countBy(rows, keyFor) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) {
    const key = keyFor(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
