// @ts-check
//
// Loads the pinned Shopify Admin GraphQL schema data the Agentic Shopify Gateway's schema index
// (schema-index.server.js) is built from — a cached, disposable snapshot of real Shopify
// introspection (per-root-field name/kind/domain/args/inputObjects/enumTypes/description), not a
// hand-maintained "catalogue." Regeneration is a follow-up (see docs/ops/agentic-shopify-gateway-full/
// 16-known-limitations.md): fetch a fresh introspection for the pinned SHOPIFY_API_VERSION, run it
// through the same field-shape extraction, and overwrite the JSON file this loads.

import { readFileSync } from "node:fs";

const DEFAULT_SCHEMA_CACHE_URL = new URL("./schema-cache/shopify-admin-schema-2026-07.json", import.meta.url);

/**
 * @typedef {{
 *   schemaVersion: string;
 *   catalogId: string;
 *   apiVersion: string;
 *   generatedAt: string;
 *   generatedFrom: Record<string, unknown>;
 *   operations: PinnedSchemaField[];
 * }} PinnedSchemaCache
 *
 * @typedef {{
 *   id: string;
 *   operation: string;
 *   operationKind: "QUERY" | "MUTATION";
 *   domain: string;
 *   description: string;
 *   requiredScopes: string[];
 *   scopeConfidence: "high" | "inferred" | "unknown";
 *   arguments: Array<{ name: string; type: string; required: boolean }>;
 *   inputObjects: Record<string, { fields: Array<{ name: string; type: string; required: boolean }> }>;
 *   enumTypes: Record<string, string[]>;
 *   returnType: string;
 *   deprecation: { deprecated: boolean; reason: string | null };
 * }} PinnedSchemaField
 */

/**
 * @param {{ cachePath?: string | URL }} [input]
 * @returns {PinnedSchemaCache}
 */
export function loadPinnedShopifySchemaCache(input = {}) {
  const raw = JSON.parse(readFileSync(input.cachePath ?? DEFAULT_SCHEMA_CACHE_URL, "utf8"));
  const validation = validatePinnedShopifySchemaCache(raw);
  if (!validation.ok) {
    throw new Error(`Invalid pinned Shopify schema cache: ${validation.errors.join("; ")}`);
  }
  return /** @type {PinnedSchemaCache} */ (raw);
}

/** @param {unknown} value */
export function validatePinnedShopifySchemaCache(value) {
  /** @type {string[]} */
  const errors = [];
  const cache = asRecord(value);
  if (!cache) return { ok: false, errors: ["schema cache must be an object"] };
  for (const key of ["apiVersion", "generatedAt"]) {
    if (typeof cache[key] !== "string" || !cache[key]) errors.push(`${key} is required`);
  }
  if (!Array.isArray(cache.operations) || cache.operations.length === 0) {
    errors.push("operations must be a non-empty array");
  }
  for (const field of Array.isArray(cache.operations) ? cache.operations : []) {
    const f = asRecord(field);
    if (!f || typeof f.operation !== "string" || !f.operation) {
      errors.push("each entry requires an operation name");
      break;
    }
    if (!["QUERY", "MUTATION"].includes(String(f.operationKind))) {
      errors.push(`${f.operation} has an unsupported operationKind`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : null;
}
