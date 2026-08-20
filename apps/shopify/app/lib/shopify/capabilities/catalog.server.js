// @ts-check

import { readFileSync } from "node:fs";

export const SHOPIFY_CAPABILITY_ADMISSION = Object.freeze({
  safeToSupport: "SAFE_TO_SUPPORT",
  requiresApproval: "REQUIRES_APPROVAL",
  highRisk: "HIGH_RISK",
  notSupported: "NOT_SUPPORTED",
  preview: "PREVIEW",
  deprecated: "DEPRECATED",
});

export const SHOPIFY_CAPABILITY_AVAILABILITY = Object.freeze({
  available: "AVAILABLE",
  needsAuthorization: "NEEDS_AUTHORIZATION",
  needsDeclaredScope: "NEEDS_DECLARED_SCOPE",
  needsExecutor: "NEEDS_EXECUTOR",
  needsInput: "NEEDS_INPUT",
  apiVersionMismatch: "API_VERSION_MISMATCH",
  unsupportedByProvider: "UNSUPPORTED_BY_PROVIDER",
  unsupportedByJefe: "UNSUPPORTED_BY_JEFE",
  highRiskBlocked: "HIGH_RISK_BLOCKED",
});

const DEFAULT_CATALOG_URL = new URL(
  "./catalogs/shopify-capabilities-2026-07.json",
  import.meta.url,
);

/**
 * @typedef {{
 *   schemaVersion: string;
 *   catalogId: string;
 *   provider: "SHOPIFY";
 *   apiSurface: string;
 *   apiVersion: string;
 *   generatedAt: string;
 *   semanticPromptVersion: string;
 *   sources: Array<Record<string, string>>;
 *   operations: ShopifyCapabilityManifest[];
 * }} ShopifyCapabilityCatalog
 */

/**
 * @typedef {{
 *   id: string;
 *   providerRef: string;
 *   provider: "SHOPIFY";
 *   apiVersion: string;
 *   apiSurface: string;
 *   operation: string;
 *   operationKind: "MUTATION" | "QUERY";
 *   domain: string;
 *   description: string;
 *   officialDocsUrl: string;
 *   requiredScopes: string[];
 *   technical: {
 *     inputType: string;
 *     outputType: string;
 *     arguments: Array<{ name: string; type: string; required: boolean }>;
 *     returnsUserErrors: boolean;
 *     deprecated: boolean;
 *   };
 *   semantic: {
 *     provenance: { kind: string; promptVersion: string; source: string };
 *     semanticEffects: string[];
 *     affectedEntities: string[];
 *     requiredEntities: string[];
 *     qualificationRequirements: Array<{
 *       id: string;
 *       evidenceKey: string;
 *       operator: "equals_true" | "equals_false" | "positive_number" | "all_present" | "present" | "differs";
 *       reason: string;
 *     }>;
 *     autoResolvableInputs: string[];
 *     merchantDecisionInputs: string[];
 *     outcomes: string[];
 *     tags: string[];
 *   };
 *   admission: {
 *     sideEffect: boolean;
 *     status: string;
 *     approvalRisk: "LOW" | "MEDIUM" | "HIGH";
 *     reversible: boolean;
 *     idempotency: { required: boolean; strategy: string };
 *     jefeSupport: string;
 *     jefeExecutor: string | null;
 *     genericExecutorSupported: boolean;
 *   };
 * }} ShopifyCapabilityManifest
 */

/**
 * @param {{ catalogPath?: string | URL }} [input]
 * @returns {ShopifyCapabilityCatalog}
 */
export function loadShopifyCapabilityCatalog(input = {}) {
  const url = input.catalogPath ?? DEFAULT_CATALOG_URL;
  const catalog = JSON.parse(readFileSync(url, "utf8"));
  const validation = validateShopifyCapabilityCatalog(catalog);
  if (!validation.ok) {
    throw new Error(`Invalid Shopify capability catalog: ${validation.errors.join("; ")}`);
  }
  return /** @type {ShopifyCapabilityCatalog} */ (catalog);
}

/**
 * @param {unknown} value
 * @returns {{ ok: true; errors: [] } | { ok: false; errors: string[] }}
 */
export function validateShopifyCapabilityCatalog(value) {
  /** @type {string[]} */
  const errors = [];
  const catalog = asRecord(value);
  if (!catalog) return { ok: false, errors: ["catalog must be an object"] };
  for (const key of ["schemaVersion", "catalogId", "provider", "apiVersion"]) {
    if (typeof catalog[key] !== "string" || !catalog[key]) {
      errors.push(`${key} is required`);
    }
  }
  if (!Array.isArray(catalog.operations) || catalog.operations.length === 0) {
    errors.push("operations must be a non-empty array");
  }
  const ids = new Set();
  for (const operation of Array.isArray(catalog.operations) ? catalog.operations : []) {
    const op = asRecord(operation);
    if (!op) {
      errors.push("operation must be an object");
      continue;
    }
    if (typeof op.id !== "string" || !op.id) errors.push("operation.id is required");
    if (ids.has(op.id)) errors.push(`duplicate operation id: ${op.id}`);
    ids.add(op.id);
    if (!["MUTATION", "QUERY"].includes(String(op.operationKind))) {
      errors.push(`${op.id} has unsupported operationKind`);
    }
    if (!Array.isArray(op.requiredScopes)) {
      errors.push(`${op.id} requiredScopes must be an array`);
    }
    const technical = asRecord(op.technical);
    if (!technical) errors.push(`${op.id} technical facts are required`);
    if (technical && !Array.isArray(technical.arguments)) {
      errors.push(`${op.id} technical.arguments must be an array`);
    }
    const semantic = asRecord(op.semantic);
    if (!semantic) errors.push(`${op.id} semantic metadata is required`);
    if (semantic) {
      for (const key of ["semanticEffects", "affectedEntities", "requiredEntities", "qualificationRequirements", "tags"]) {
        if (!Array.isArray(semantic[key])) errors.push(`${op.id} semantic.${key} must be an array`);
      }
      const provenance = asRecord(semantic.provenance);
      if (!provenance?.kind || !provenance?.source) {
        errors.push(`${op.id} semantic provenance is required`);
      }
    }
    const admission = asRecord(op.admission);
    if (!admission) {
      errors.push(`${op.id} admission is required`);
      continue;
    }
    if (op.operationKind === "MUTATION" && admission.sideEffect !== true) {
      errors.push(`${op.id} mutation must be marked sideEffect=true`);
    }
    if (admission.sideEffect && !admission.idempotency?.required) {
      errors.push(`${op.id} side-effecting capabilities need idempotency`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * @param {{ catalog?: ShopifyCapabilityCatalog; writeOnly?: boolean }} [input]
 */
export function listShopifyCapabilityManifests(input = {}) {
  const catalog = input.catalog ?? loadShopifyCapabilityCatalog();
  return catalog.operations
    .filter((operation) => !input.writeOnly || operation.operationKind === "MUTATION")
    .map(cloneManifest);
}

/**
 * @param {string} idOrOperation
 * @param {{ catalog?: ShopifyCapabilityCatalog }} [input]
 */
export function getShopifyCapabilityManifest(idOrOperation, input = {}) {
  const key = String(idOrOperation ?? "").trim();
  if (!key) return null;
  const catalog = input.catalog ?? loadShopifyCapabilityCatalog();
  const found = catalog.operations.find(
    (operation) =>
      operation.id === key ||
      operation.providerRef === key ||
      operation.operation === key,
  );
  return found ? cloneManifest(found) : null;
}

/**
 * @param {ShopifyCapabilityManifest} manifest
 * @param {{
 *   apiVersion?: string | null;
 *   declaredScopes?: string[];
 *   grantedScopes?: string[];
 *   executorRefs?: string[];
 *   requiredInputsKnown?: boolean;
 * }} [context]
 */
export function resolveShopifyCapabilityAvailability(manifest, context = {}) {
  const declaredScopes = new Set(context.declaredScopes ?? []);
  const grantedScopes = new Set(context.grantedScopes ?? []);
  const executorRefs = new Set(context.executorRefs ?? []);
  const missingDeclaredScopes = manifest.requiredScopes.filter((scope) => !declaredScopes.has(scope));
  const missingGrantedScopes = manifest.requiredScopes.filter((scope) => !grantedScopes.has(scope));
  const executor = manifest.admission.jefeExecutor;
  const hasExecutor =
    manifest.operationKind === "QUERY" ||
    manifest.admission.genericExecutorSupported ||
    Boolean(executor && executorRefs.has(executor));
  const apiVersionMatches = !context.apiVersion || context.apiVersion === manifest.apiVersion;
  const providerSupported =
    !manifest.technical.deprecated &&
    manifest.admission.status !== SHOPIFY_CAPABILITY_ADMISSION.notSupported;
  /** @type {string} */
  let executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.available;
  if (!providerSupported) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.unsupportedByProvider;
  } else if (!apiVersionMatches) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.apiVersionMismatch;
  } else if (manifest.admission.status === SHOPIFY_CAPABILITY_ADMISSION.highRisk) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.highRiskBlocked;
  } else if (missingDeclaredScopes.length) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.needsDeclaredScope;
  } else if (missingGrantedScopes.length) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.needsAuthorization;
  } else if (!hasExecutor) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.needsExecutor;
  } else if (context.requiredInputsKnown === false) {
    executionStatus = SHOPIFY_CAPABILITY_AVAILABILITY.needsInput;
  }
  return {
    providerSupported,
    apiVersionMatches,
    requiredScopes: [...manifest.requiredScopes],
    missingDeclaredScopes,
    missingGrantedScopes,
    hasExecutor,
    admissionStatus: manifest.admission.status,
    executionStatus,
  };
}

/**
 * @param {ShopifyCapabilityCatalog} previous
 * @param {ShopifyCapabilityCatalog} next
 */
export function diffShopifyCapabilityCatalogs(previous, next) {
  const oldById = new Map(previous.operations.map((operation) => [operation.id, operation]));
  const newById = new Map(next.operations.map((operation) => [operation.id, operation]));
  const added = [...newById.keys()].filter((id) => !oldById.has(id)).sort();
  const removed = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
  const changed = [];
  for (const [id, nextOp] of newById) {
    const oldOp = oldById.get(id);
    if (!oldOp) continue;
    const changes = [];
    if (oldOp.description !== nextOp.description) changes.push("description");
    if (oldOp.technical.inputType !== nextOp.technical.inputType) changes.push("inputType");
    if (oldOp.technical.outputType !== nextOp.technical.outputType) changes.push("outputType");
    if (JSON.stringify(oldOp.technical.arguments) !== JSON.stringify(nextOp.technical.arguments)) {
      changes.push("arguments");
    }
    if (JSON.stringify(oldOp.requiredScopes) !== JSON.stringify(nextOp.requiredScopes)) {
      changes.push("requiredScopes");
    }
    if (oldOp.technical.deprecated !== nextOp.technical.deprecated) changes.push("deprecated");
    if (changes.length) changed.push({ id, changes });
  }
  return { added, removed, changed };
}

/** @param {string | undefined | null} value */
export function parseScopeList(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))].sort();
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {ShopifyCapabilityManifest} manifest */
function cloneManifest(manifest) {
  return /** @type {ShopifyCapabilityManifest} */ (JSON.parse(JSON.stringify(manifest)));
}
