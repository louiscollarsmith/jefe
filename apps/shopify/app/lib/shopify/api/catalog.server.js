// @ts-check

import { readFileSync } from "node:fs";

const DEFAULT_API_VERSION = "2026-07";
const DEFAULT_CATALOG_URL = new URL(
  "./catalogs/shopify-admin-api-2026-07.generated.json",
  import.meta.url,
);

export const SHOPIFY_OPERATION_KIND = Object.freeze({
  query: "QUERY",
  mutation: "MUTATION",
});

/**
 * @typedef {{
 *   schemaVersion: string;
 *   catalogId: string;
 *   provider: "SHOPIFY";
 *   apiSurface: "admin_graphql";
 *   apiVersion: string;
 *   generatedAt: string;
 *   generatedFrom: Record<string, unknown>;
 *   operations: ShopifyApiOperationStub[];
 * }} ShopifyApiCatalog
 *
 * @typedef {{
 *   id: string;
 *   apiVersion?: string;
 *   operation: string;
 *   operationKind: "QUERY" | "MUTATION";
 *   domain: string;
 *   description: string;
 *   requiredScopes: string[];
 *   scopeConfidence: "high" | "inferred" | "unknown";
 *   safety: { riskTier: string; reversibility: string; interaction: string };
 *   execution: { status: string; classificationSource?: string; reason: string };
 *   arguments: Array<{ name: string; type: string; required: boolean }>;
 *   inputObjects: Record<string, { fields: Array<{ name: string; type: string; required: boolean }> }>;
 *   enumTypes: Record<string, string[]>;
 *   returnType: string;
 *   deprecation: { deprecated: boolean; reason: string | null };
 *   document: string;
 *   tags: string[];
 * }} ShopifyApiOperationStub
 */

const KNOWN_SCOPE_CONFIDENCE = new Set(["high", "inferred", "unknown"]);
const KNOWN_EXECUTION_STATUS = new Set([
  "EXECUTABLE",
  "EXECUTABLE_WITH_CONFIRMATION",
  "UNSUPPORTED_SEMANTICS",
  "PROHIBITED",
]);
const EXECUTABLE_STATUSES = new Set(["EXECUTABLE", "EXECUTABLE_WITH_CONFIRMATION"]);
const KNOWN_CLASSIFICATION_SOURCES = new Set([
  "EXPLICIT_KNOWN_GOOD",
  "EXPLICIT_OPERATION_OVERRIDE",
  "REVIEWED_OPERATION_FAMILY_POLICY",
  "STRUCTURAL_NAME_INFERENCE",
]);

/**
 * @param {{ catalogPath?: string | URL }} [input]
 * @returns {ShopifyApiCatalog}
 */
export function loadShopifyApiCatalog(input = {}) {
  const catalog = JSON.parse(readFileSync(input.catalogPath ?? DEFAULT_CATALOG_URL, "utf8"));
  const validation = validateShopifyApiCatalog(catalog);
  if (!validation.ok) {
    throw new Error(`Invalid Shopify API catalog: ${validation.errors.join("; ")}`);
  }
  return /** @type {ShopifyApiCatalog} */ (catalog);
}

/** @param {unknown} value */
export function validateShopifyApiCatalog(value) {
  /** @type {string[]} */
  const errors = [];
  const catalog = asRecord(value);
  if (!catalog) return { ok: false, errors: ["catalog must be an object"] };
  for (const key of ["schemaVersion", "catalogId", "provider", "apiSurface", "apiVersion", "generatedAt"]) {
    if (typeof catalog[key] !== "string" || !catalog[key]) errors.push(`${key} is required`);
  }
  if (!Array.isArray(catalog.operations) || catalog.operations.length === 0) {
    errors.push("operations must be a non-empty array");
  }
  const ids = new Set();
  const operationKeys = new Set();
  for (const operation of Array.isArray(catalog.operations) ? catalog.operations : []) {
    const op = asRecord(operation);
    if (!op) {
      errors.push("operation must be an object");
      continue;
    }
    if (typeof op.id !== "string" || !op.id) errors.push("operation.id is required");
    if (ids.has(op.id)) errors.push(`duplicate operation id: ${op.id}`);
    ids.add(op.id);
    const operationKey = `${op.operationKind}:${op.operation}`;
    if (operationKeys.has(operationKey)) errors.push(`duplicate operation: ${operationKey}`);
    operationKeys.add(operationKey);
    if (!["QUERY", "MUTATION"].includes(String(op.operationKind))) {
      errors.push(`${op.id} has unsupported operationKind`);
    }
    for (const key of ["operation", "domain", "description", "returnType", "document"]) {
      if (typeof op[key] !== "string" || !op[key]) errors.push(`${op.id} ${key} is required`);
    }
    for (const key of ["requiredScopes", "arguments", "tags"]) {
      if (!Array.isArray(op[key])) errors.push(`${op.id} ${key} must be an array`);
    }
    if (!asRecord(op.inputObjects)) errors.push(`${op.id} inputObjects must be an object`);
    if (!asRecord(op.enumTypes)) errors.push(`${op.id} enumTypes must be an object`);
    const deprecation = asRecord(op.deprecation);
    if (!deprecation || typeof deprecation.deprecated !== "boolean") {
      errors.push(`${op.id} deprecation is required`);
    }
    if (!KNOWN_SCOPE_CONFIDENCE.has(op.scopeConfidence)) {
      errors.push(`${op.id} scopeConfidence must be one of ${[...KNOWN_SCOPE_CONFIDENCE].join(", ")}`);
    }
    const safety = asRecord(op.safety);
    if (!safety || typeof safety.riskTier !== "string" || typeof safety.reversibility !== "string" || typeof safety.interaction !== "string") {
      errors.push(`${op.id} safety (riskTier, reversibility, interaction) is required`);
    }
    const execution = asRecord(op.execution);
    if (!execution || !KNOWN_EXECUTION_STATUS.has(execution.status)) {
      errors.push(`${op.id} execution.status must be one of ${[...KNOWN_EXECUTION_STATUS].join(", ")}`);
    }
    // "Never let unknown mean safe" applies to writes: a mutation must have scopeConfidence
    // "high" — not merely "inferred", and never "unknown" — to be EXECUTABLE or
    // EXECUTABLE_WITH_CONFIRMATION (task Part 2.3: "inferred" powers discovery/reasoning/
    // evaluation, never production write authority on its own). Reads are exempt — a query
    // cannot mutate merchant state, and the gateway separately re-verifies real granted scopes
    // live for every operation, read or write, before admitting it.
    if (execution && op.operationKind === "MUTATION" && op.scopeConfidence !== "high" && EXECUTABLE_STATUSES.has(execution.status)) {
      errors.push(`${op.id} is a mutation with scopeConfidence "${op.scopeConfidence}" (not "high") but execution.status is ${execution.status}`);
    }
    // Task Part 1.3: operation-name similarity alone must never grant production write
    // authority. STRUCTURAL_NAME_INFERENCE may only ever appear on non-executable results.
    if (execution && EXECUTABLE_STATUSES.has(execution.status)) {
      if (!KNOWN_CLASSIFICATION_SOURCES.has(execution.classificationSource)) {
        errors.push(`${op.id} is ${execution.status} but has no valid execution.classificationSource`);
      } else if (execution.classificationSource === "STRUCTURAL_NAME_INFERENCE") {
        errors.push(`${op.id} is ${execution.status} sourced from STRUCTURAL_NAME_INFERENCE — name pattern alone must never grant execution authority`);
      }
    }
    for (const argument of Array.isArray(op.arguments) ? op.arguments : []) {
      if (!argument?.name || !argument?.type || typeof argument.required !== "boolean") {
        errors.push(`${op.id} has invalid argument metadata`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * @param {string} idOrOperation
 * @param {{ catalog?: ShopifyApiCatalog; operationKind?: "QUERY" | "MUTATION" }} [input]
 */
export function getShopifyApiOperationStub(idOrOperation, input = {}) {
  const key = String(idOrOperation ?? "").trim();
  if (!key) return null;
  const catalog = input.catalog ?? loadShopifyApiCatalog();
  const found = catalog.operations.find((operation) => {
    if (input.operationKind && operation.operationKind !== input.operationKind) return false;
    return operation.id === key || operation.operation === key;
  });
  return found ? withCatalogVersion(found, catalog.apiVersion) : null;
}

/** @param {{ catalog?: ShopifyApiCatalog; operationKind?: "QUERY" | "MUTATION" }} [input] */
export function listShopifyApiOperationStubs(input = {}) {
  const catalog = input.catalog ?? loadShopifyApiCatalog();
  return catalog.operations
    .filter((operation) => !input.operationKind || operation.operationKind === input.operationKind)
    .map((operation) => withCatalogVersion(operation, catalog.apiVersion));
}

/**
 * @param {ShopifyApiOperationStub} stub
 * @param {Record<string, unknown>} variables
 */
export function validateShopifyOperationVariables(stub, variables) {
  /** @type {string[]} */
  const errors = [];
  const bag = asRecord(variables);
  if (!bag) return { ok: false, errors: ["variables must be an object"] };
  for (const argument of stub.arguments) {
    const value = bag[argument.name];
    if (argument.required && value === undefined) {
      errors.push(`${argument.name} is required`);
      continue;
    }
    if (value !== undefined) {
      validateValue({
        path: argument.name,
        type: argument.type,
        value,
        inputObjects: stub.inputObjects,
        enumTypes: stub.enumTypes,
        errors,
      });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * @param {ShopifyApiCatalog} previous
 * @param {ShopifyApiCatalog} next
 */
export function diffShopifyApiCatalogs(previous, next) {
  const oldById = new Map(previous.operations.map((operation) => [operation.id, operation]));
  const newById = new Map(next.operations.map((operation) => [operation.id, operation]));
  const added = [...newById.keys()].filter((id) => !oldById.has(id)).sort();
  const removed = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
  const changed = [];
  for (const [id, oldOperation] of oldById) {
    const nextOperation = newById.get(id);
    if (!nextOperation) continue;
    const changes = [];
    /** @type {Array<keyof ShopifyApiOperationStub>} */
    const comparableKeys = [
      "operationKind",
      "description",
      "requiredScopes",
      "arguments",
      "inputObjects",
      "enumTypes",
      "returnType",
      "deprecation",
    ];
    for (const key of comparableKeys) {
      if (JSON.stringify(oldOperation[key]) !== JSON.stringify(nextOperation[key])) changes.push(key);
    }
    if (changes.length) changed.push({ id, operation: oldOperation.operation, changes });
  }
  return { added, removed, changed };
}

/** @param {string} value */
export function parseScopeList(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((/** @type {string} */ scope) => scope.trim())
    .filter(Boolean);
}

export function getConfiguredShopifyApiVersion(env = process.env) {
  return env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
}

/**
 * @param {{
 *   path: string;
 *   type: string;
 *   value: unknown;
 *   inputObjects: ShopifyApiOperationStub["inputObjects"];
 *   enumTypes: ShopifyApiOperationStub["enumTypes"];
 *   errors: string[];
 * }} input
 */
function validateValue(input) {
  const required = input.type.endsWith("!");
  const nullableType = required ? input.type.slice(0, -1) : input.type;
  if (input.value === null || input.value === undefined) {
    if (required) input.errors.push(`${input.path} is required`);
    return;
  }
  const listMatch = nullableType.match(/^\[(.+)\]$/);
  if (listMatch) {
    if (!Array.isArray(input.value)) {
      input.errors.push(`${input.path} must be an array`);
      return;
    }
    input.value.forEach((item, index) =>
      validateValue({
        ...input,
        path: `${input.path}[${index}]`,
        type: listMatch[1],
        value: item,
      }),
    );
    return;
  }
  if (input.enumTypes[nullableType] && !input.enumTypes[nullableType].includes(String(input.value))) {
    input.errors.push(`${input.path} must be one of ${input.enumTypes[nullableType].join(", ")}`);
    return;
  }
  const scalarError = validateScalar(nullableType, input.value);
  if (scalarError) {
    input.errors.push(`${input.path} ${scalarError}`);
    return;
  }
  const inputObject = input.inputObjects[nullableType];
  if (!inputObject) return;
  const objectValue = asRecord(input.value);
  if (!objectValue) {
    input.errors.push(`${input.path} must be an object`);
    return;
  }
  for (const field of inputObject.fields) {
    validateValue({
      path: `${input.path}.${field.name}`,
      type: field.type,
      value: objectValue[field.name],
      inputObjects: input.inputObjects,
      enumTypes: input.enumTypes,
      errors: input.errors,
    });
  }
}

/** @param {string} type @param {unknown} value */
function validateScalar(type, value) {
  if (["ID", "String", "DateTime", "Money"].includes(type)) {
    return typeof value === "string" ? null : "must be a string";
  }
  if (type === "Int") return Number.isInteger(value) ? null : "must be an integer";
  if (type === "Float") return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
  if (type === "Boolean") return typeof value === "boolean" ? null : "must be a boolean";
  return null;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return structuredClone(value);
}

/**
 * @param {ShopifyApiOperationStub} operation
 * @param {string} apiVersion
 */
function withCatalogVersion(operation, apiVersion) {
  return { ...clone(operation), apiVersion };
}
