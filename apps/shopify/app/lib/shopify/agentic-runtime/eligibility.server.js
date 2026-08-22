// @ts-check

/**
 * Generic structured eligibility for agentic semantic Actions.
 * Criteria describe which Shopify resources qualify. Write protections
 * describe what Jefe must not mutate. They are not the same thing.
 */

export const ELIGIBILITY_OPERATORS = Object.freeze([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "in",
  "not_in",
]);

/** Common symbols / phrases Luna emits instead of the canonical operator ids. */
const OPERATOR_ALIASES = Object.freeze({
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  "=": "eq",
  "==": "eq",
  "!=": "neq",
  "<>": "neq",
  greater_than: "gt",
  greaterthan: "gt",
  less_than: "lt",
  lessthan: "lt",
  greater_than_or_equal: "gte",
  greaterthanorequal: "gte",
  less_than_or_equal: "lte",
  lessthanorequal: "lte",
});

export const AGENTIC_ELIGIBILITY_CONSISTENCY_VERSION = "agentic-eligibility-consistency-v1";

export const WRITE_PROTECTION_TARGETS = Object.freeze([
  "inventory",
  "pricing",
  "status",
  "copy",
  "title",
  "custom",
]);

/** @type {Readonly<Record<string, { resourceType: string; field: string }>>} */
const FIELD_ALIASES = Object.freeze({
  status: { resourceType: "Product", field: "status" },
  "product.status": { resourceType: "Product", field: "status" },
  producttype: { resourceType: "Product", field: "productType" },
  product_type: { resourceType: "Product", field: "productType" },
  "product.producttype": { resourceType: "Product", field: "productType" },
  available: { resourceType: "Inventory", field: "available" },
  inventory: { resourceType: "Inventory", field: "available" },
  inventoryquantity: { resourceType: "Inventory", field: "available" },
  totalinventory: { resourceType: "Inventory", field: "available" },
  "inventory.available": { resourceType: "Inventory", field: "available" },
  price: { resourceType: "Variant", field: "price" },
  "variant.price": { resourceType: "Variant", field: "price" },
  tags: { resourceType: "Product", field: "tags" },
  "product.tags": { resourceType: "Product", field: "tags" },
  vendor: { resourceType: "Product", field: "vendor" },
  handle: { resourceType: "Product", field: "handle" },
  title: { resourceType: "Product", field: "title" },
  id: { resourceType: "Product", field: "id" },
  productid: { resourceType: "Product", field: "id" },
});

const QUALIFIER_DETECTORS = [
  {
    id: "inventory_available",
    field: "available",
    label: "current available inventory",
    pattern:
      /\b(in[-\s]?stock|stock-safe|out[-\s]?of[-\s]?stock|units available|available inventory|available units|at least \d+\s+units?)\b/i,
  },
  {
    id: "price_threshold",
    field: "price",
    label: "price or margin threshold",
    pattern: /\b(high[-\s]?margin|priced? (?:above|below|over|under|at least)|price threshold)\b/i,
  },
];

/**
 * @param {unknown} rows
 * @param {{ source?: string; derivedFrom?: string | null }} [options]
 */
export function normalizeEligibilityCriteria(rows, options = {}) {
  const source = options.source ?? "recommendation";
  const derivedFrom = options.derivedFrom ?? (source === "recommendation" ? "recommendation" : source);
  const seen = new Set();
  const criteria = [];
  for (const [index, raw] of (Array.isArray(rows) ? rows : []).entries()) {
    const criterion = normalizeCriterion(raw, { source, derivedFrom, index });
    if (!criterion) continue;
    if (seen.has(criterion.id)) {
      criterion.id = allocateCriterionId(criteria, index);
    }
    seen.add(criterion.id);
    criteria.push(criterion);
  }
  return criteria.slice(0, 20);
}

/** @param {unknown} rows */
export function validateEligibilityCriteria(rows) {
  if (rows == null) return { ok: true, criteria: [] };
  if (!Array.isArray(rows)) {
    return { ok: false, errorCode: "INVALID_ELIGIBILITY_CRITERIA", error: "eligibilityCriteria must be an array." };
  }
  const seen = new Set();
  const criteria = [];
  for (const [index, raw] of rows.entries()) {
    const criterion = normalizeCriterion(raw, { source: "recommendation", index });
    if (!criterion) {
      return {
        ok: false,
        errorCode: "INVALID_ELIGIBILITY_CRITERIA",
        field: "eligibilityCriteria",
        error: `eligibilityCriteria[${index}] needs a field, supported operator, and value.`,
        repairInstruction:
          "Fix that eligibility criterion: set resourceType, field, operator (eq/neq/gt/gte/lt/lte/contains/in) and value. For current availability use field \"available\" (aliases: inventory, Inventory.available, totalInventory) with operator gt/gte and valueNumber. Do not repeat Shopify investigation.",
      };
    }
    if (seen.has(criterion.id)) {
      return {
        ok: false,
        errorCode: "DUPLICATE_ELIGIBILITY_ID",
        field: "eligibilityCriteria",
        error: `eligibilityCriteria id "${criterion.id}" is duplicated.`,
        repairInstruction: "Give each eligibility criterion a unique id.",
      };
    }
    seen.add(criterion.id);
    criteria.push(criterion);
  }
  return { ok: true, criteria };
}

/**
 * @param {unknown} rows
 * @param {unknown} [constraints]
 */
export function normalizeWriteProtections(rows, constraints) {
  const fromRows = (Array.isArray(rows) ? rows : [])
    .map((row, index) => normalizeWriteProtection(row, index))
    .filter(Boolean);
  if (fromRows.length) return dedupeWriteProtections(fromRows);
  const inferred = [];
  for (const constraint of Array.isArray(constraints) ? constraints : []) {
    const label = String(constraint?.label ?? constraint ?? "");
    for (const target of writeProtectionTargetsFromLabel(label)) {
      inferred.push({
        id: `wp_${target}`,
        target,
        label: label.trim() || defaultWriteProtectionLabel(target),
        source: "recommendation",
      });
    }
  }
  return dedupeWriteProtections(inferred);
}

/**
 * Detect merchant-facing qualifiers in recommendation prose that must be
 * represented as structured eligibility. Rationale-only fields are not scanned.
 *
 * @param {{ title?: string; summary?: string; outcome?: string; scope?: unknown }} recommendation
 * @param {any[]} criteria
 */
export function validatePromiseConsistency(recommendation, criteria) {
  const prose = [recommendation?.title, recommendation?.summary, recommendation?.outcome, scopeText(recommendation?.scope)]
    .filter(Boolean)
    .join("\n");
  const normalized = Array.isArray(criteria) ? criteria : [];
  const missing = [];
  for (const detector of QUALIFIER_DETECTORS) {
    if (!detector.pattern.test(prose)) continue;
    if (normalized.some((row) => row.field === detector.field)) continue;
    missing.push(detector);
  }
  if (!missing.length) return { ok: true, missing: [] };
  const names = missing.map((row) => row.label).join("; ");
  return {
    ok: false,
    errorCode: "PROMISE_CRITERIA_MISMATCH",
    field: "eligibilityCriteria",
    missing,
    error: `The recommendation wording promises ${names}, but eligibilityCriteria does not encode ${names}.`,
    repairInstruction:
      `Add structured eligibilityCriteria for ${names}, or remove those qualifiers from title/summary/outcome/scope if they are not selection rules. Do not invent extra business rules. Do not repeat Shopify investigation.`,
  };
}

/**
 * @param {any} resource
 * @param {any} criterion
 */
export function evaluateCriterion(resource, criterion) {
  const actual = resourceValue(resource, criterion);
  const passed = compareValues(actual, criterion.operator, criterion.value);
  return {
    id: criterion.id,
    field: criterion.field,
    operator: criterion.operator,
    expected: criterion.value,
    actual,
    passed,
    label: criterion.label,
  };
}

/**
 * @param {any} resource
 * @param {any[]} criteria
 */
export function evaluateResourceEligibility(resource, criteria) {
  const rows = Array.isArray(criteria) ? criteria : [];
  if (!rows.length) {
    return {
      eligible: true,
      unstructured: true,
      passed: [],
      failed: [],
      evaluations: [],
    };
  }
  const evaluations = rows.map((criterion) => evaluateCriterion(resource, criterion));
  return {
    eligible: evaluations.every((row) => row.passed),
    unstructured: false,
    passed: evaluations.filter((row) => row.passed),
    failed: evaluations.filter((row) => !row.passed),
    evaluations,
  };
}

/**
 * @param {{ resources?: any[]; criteria?: any[]; excluded?: any[] }} input
 */
export function deriveCandidateScope(input) {
  const criteria = input.criteria ?? [];
  const excludedIds = new Set(
    (input.excluded ?? [])
      .map((row) => String(row?.productId ?? row?.id ?? row?.title ?? "").trim())
      .filter(Boolean),
  );
  const items = [];
  const rejected = [];
  for (const resource of input.resources ?? []) {
    const facts = normalizeResourceFacts(resource);
    const evaluation = evaluateResourceEligibility(facts, criteria);
    const identity = facts.productId ?? facts.id ?? facts.title ?? "";
    const excluded = Boolean(identity && excludedIds.has(String(identity)));
    const row = {
      ...facts,
      reason: evaluation.eligible
        ? evaluation.passed.map((item) => `${item.label}: pass`).join("; ") || "Matches eligibility criteria."
        : evaluation.failed.map((item) => `${item.label}: fail (${formatActual(item.actual)})`).join("; "),
      because: evaluation.eligible ? "Matches eligibility criteria." : "Failed one or more eligibility criteria.",
      eligibility: evaluation,
    };
    if (excluded || !evaluation.eligible) rejected.push({ ...row, excluded });
    else items.push(row);
  }
  return {
    status: "known_candidate_scope",
    summary: candidateSummary(items, criteria),
    items,
    excluded: rejected,
    candidateCount: items.length,
    eligibilityCriteria: criteria,
  };
}

/** @param {any[]} criteria */
export function merchantEligibilityLabels(criteria) {
  return (Array.isArray(criteria) ? criteria : []).map((row) => row.label).filter(Boolean);
}

/** Canonical field/operator encoding Luna must use in eligibilityCriteria. */
export function eligibilityEncodingForPrompt() {
  return {
    operators: [...ELIGIBILITY_OPERATORS],
    inventoryField: "available",
    inventoryFieldAliases: ["available", "inventory", "Inventory.available", "totalInventory", "inventoryQuantity"],
    numericComparisons: "Use operator gt/gte/lt/lte with valueNumber. Do not use symbols such as > in operator.",
    exampleCurrentAvailability: {
      resourceType: "Inventory",
      field: "available",
      operator: "gt",
      valueNumber: 0,
    },
    note: "Merchant-facing wording is an explanation of these structured rules, not a separate source of rules.",
  };
}

export function formatEligibilityForPrompt(criteria, writeProtections) {
  const eligibility = Array.isArray(criteria) ? criteria : [];
  const protections = Array.isArray(writeProtections) ? writeProtections : [];
  return {
    currentEligibilityCriteria: eligibility.length
      ? eligibility.map((row) => ({
          id: row.id,
          rule: `${row.resourceType}.${row.field} ${row.operator} ${formatActual(row.value)}`,
          merchantLabel: row.label,
          source: row.source,
        }))
      : "legacy_unstructured",
    writeProtections: protections.length
      ? protections.map((row) => ({ target: row.target, label: row.label }))
      : [],
  };
}

/** @param {any} resource @param {any[]} criteria */
export function explainWhyResourceQualifies(resource, criteria) {
  const evaluation = evaluateResourceEligibility(normalizeResourceFacts(resource), criteria);
  if (evaluation.unstructured) {
    return {
      eligible: true,
      unstructured: true,
      explanation: "This Action has no structured eligibility criteria.",
      evaluations: [],
    };
  }
  const lines = evaluation.evaluations.map(
    (row) =>
      `${row.label}: ${row.passed ? "PASS" : "FAIL"} (observed ${formatActual(row.actual)}, required ${row.operator} ${formatActual(row.expected)})`,
  );
  return {
    eligible: evaluation.eligible,
    unstructured: false,
    explanation: lines.join("\n"),
    evaluations: evaluation.evaluations,
  };
}

/** @param {unknown} value */
export function collectResourceFacts(value) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  walkForResources(value, byId);
  return [...byId.values()];
}

/**
 * @param {string} operation
 * @param {Record<string, unknown>} variables
 */
export function productIdsFromWriteVariables(operation, variables) {
  /** @type {string[]} */
  const ids = [];
  collectProductIds(variables, ids);
  if (!/product|collection|metafield/i.test(String(operation ?? ""))) return uniqueStrings(ids);
  return uniqueStrings(ids);
}

/**
 * @param {{ operation?: string; variables?: Record<string, unknown>; resources?: any[]; criteria?: any[] }} input
 */
export function revalidateWriteTargets(input) {
  const criteria = input.criteria ?? [];
  if (!criteria.length) return { ok: true, unstructured: true, ineligible: [], eligibleIds: [] };
  const resources = new Map(
    (input.resources ?? []).map((row) => {
      const facts = normalizeResourceFacts(row);
      return [String(facts.productId ?? facts.id ?? ""), facts];
    }),
  );
  const ids = productIdsFromWriteVariables(input.operation ?? "", input.variables ?? {});
  const ineligible = [];
  const eligibleIds = [];
  for (const id of ids) {
    const resource = resources.get(id);
    if (!resource) {
      ineligible.push({ id, title: null, failed: [{ label: "No current Shopify evidence for eligibility revalidation" }] });
      continue;
    }
    const evaluation = evaluateResourceEligibility(resource, criteria);
    if (evaluation.eligible) eligibleIds.push(id);
    else ineligible.push({ id, title: resource.title, failed: evaluation.failed });
  }
  return {
    ok: ineligible.length === 0,
    unstructured: false,
    ineligible,
    eligibleIds,
  };
}

/**
 * @param {{ members?: any[]; criteria?: any[]; excluded?: any[] }} input
 */
export function verifyMembersAgainstCriteria(input) {
  const criteria = input.criteria ?? [];
  if (!criteria.length) return { ok: true, unstructured: true, violations: [] };
  const excluded = new Set(
    (input.excluded ?? [])
      .map((row) => String(row?.productId ?? row?.id ?? "").trim())
      .filter(Boolean),
  );
  const violations = [];
  for (const member of input.members ?? []) {
    const facts = normalizeResourceFacts(member);
    const id = String(facts.productId ?? facts.id ?? "");
    if (id && excluded.has(id)) {
      violations.push({ id, title: facts.title, reason: "explicitly excluded" });
      continue;
    }
    const evaluation = evaluateResourceEligibility(facts, criteria);
    if (!evaluation.eligible) {
      violations.push({
        id,
        title: facts.title,
        reason: evaluation.failed.map((row) => row.label).join("; "),
        failed: evaluation.failed,
      });
    }
  }
  return { ok: violations.length === 0, unstructured: false, violations };
}

/** @param {any} resource */
export function normalizeResourceFacts(resource) {
  const object = asRecord(resource) ?? {};
  const variants = flattenVariants(object);
  const available = firstNumber([
    object.available,
    object.inventory,
    object.totalInventory,
    object.inventoryQuantity,
    object.totalAvailable,
    sumNumbers(variants.map((/** @type {any} */ row) => row.inventoryQuantity ?? row.available)),
  ]);
  const price = firstNumber([
    object.price,
    variants[0]?.price,
  ]);
  const id = stringOrNull(object.productId ?? object.id ?? object.admin_graphql_api_id);
  return {
    id,
    productId: id,
    title: stringOrNull(object.title ?? object.productTitle ?? object.name),
    status: stringOrNull(object.status ?? object.productStatus),
    productType: stringOrNull(object.productType ?? object.product_type ?? object.type),
    tags: normalizeTags(object.tags),
    vendor: stringOrNull(object.vendor),
    handle: stringOrNull(object.handle),
    available,
    inventory: available,
    price,
    variantId: stringOrNull(object.variantId ?? variants[0]?.id),
  };
}

/**
 * @param {any} raw
 * @param {{ source?: string; derivedFrom?: string | null; index?: number }} [options]
 */
function normalizeCriterion(raw, { source, derivedFrom, index } = {}) {
  const object = asRecord(raw);
  if (!object) return null;
  const operator = canonicalizeOperator(object.operator);
  if (!operator) return null;
  const aliased = aliasField(object.resourceType, object.field);
  const field = aliased.field;
  if (!field) return null;
  const value = coerceCriterionValue(object, operator);
  if (value == null || (Array.isArray(value) && value.length === 0 && operator !== "in" && operator !== "not_in")) {
    return null;
  }
  const resourceType = aliased.resourceType || String(object.resourceType ?? "Product");
  const id = String(object.id ?? "").trim() || allocateCriterionId([], index);
  return {
    id,
    resourceType,
    field,
    operator,
    value,
    source: String(object.source ?? source ?? "recommendation"),
    derivedFrom: object.derivedFrom ?? derivedFrom ?? null,
    evidenceRefs: uniqueStrings(object.evidenceRefs).slice(0, 12),
    label: String(object.label ?? "").trim() || merchantLabelForCriterion({ resourceType, field, operator, value }),
  };
}

/** @param {any[]} existing @param {number} [index] */
function allocateCriterionId(existing, index = 0) {
  const used = new Set(existing.map((/** @type {any} */ row) => row.id));
  let candidate = `ec_${index + 1}`;
  let n = index + 1;
  while (used.has(candidate)) {
    n += 1;
    candidate = `ec_${n}`;
  }
  return candidate;
}

/** @param {unknown} operator */
function canonicalizeOperator(operator) {
  const raw = String(operator ?? "eq").trim().toLowerCase();
  const aliased = OPERATOR_ALIASES[raw] ?? raw;
  return ELIGIBILITY_OPERATORS.includes(aliased) ? aliased : null;
}

/** @param {unknown} resourceType @param {unknown} field */
function aliasField(resourceType, field) {
  const rawField = String(field ?? "").trim();
  const key = `${String(resourceType ?? "").trim()}.${rawField}`.replace(/^\./, "").toLowerCase().replace(/\s+/g, "");
  const aliased = FIELD_ALIASES[key] ?? FIELD_ALIASES[rawField.toLowerCase().replace(/\s+/g, "")];
  if (aliased) {
    return {
      resourceType: String(resourceType ?? aliased.resourceType),
      field: aliased.field,
    };
  }
  return {
    resourceType: String(resourceType ?? "Product").trim() || "Product",
    field: rawField,
  };
}

/** @param {any} object @param {string} operator */
function coerceCriterionValue(object, operator) {
  if (object.valueNumber != null && Number.isFinite(Number(object.valueNumber))) return Number(object.valueNumber);
  if (Array.isArray(object.values)) {
    return object.values.map((/** @type {any} */ row) => coerceScalar(row)).filter((/** @type {any} */ row) => row != null);
  }
  if (Array.isArray(object.value)) {
    return object.value.map((/** @type {any} */ row) => coerceScalar(row)).filter((/** @type {any} */ row) => row != null);
  }
  if (operator === "in" || operator === "not_in") {
    if (typeof object.value === "string" && object.value.includes(",")) {
      return object.value.split(",").map((/** @type {string} */ row) => coerceScalar(row.trim())).filter((/** @type {any} */ row) => row != null);
    }
  }
  return coerceScalar(object.value);
}

/** @param {any} value */
function coerceScalar(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  const text = String(value).trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  return text;
}

/** @param {any} criterion */
function merchantLabelForCriterion(criterion) {
  const name = fieldDisplayName(criterion.field);
  if (criterion.field === "available") {
    if (criterion.operator === "gt" && Number(criterion.value) === 0) return "Currently in stock";
    if (criterion.operator === "gte") return `At least ${criterion.value} units currently available`;
    if (criterion.operator === "gt") return `More than ${criterion.value} units currently available`;
  }
  if (criterion.field === "status" && String(criterion.value).toUpperCase() === "ACTIVE") {
    return "Active products";
  }
  if (criterion.field === "productType") return `Product type is ${criterion.value}`;
  if (criterion.operator === "eq") return `${name} is ${criterion.value}`;
  if (criterion.operator === "contains") return `${name} contains ${criterion.value}`;
  return `${name} ${criterion.operator} ${formatActual(criterion.value)}`;
}

/** @param {unknown} field */
function fieldDisplayName(field) {
  if (field === "productType") return "Product type";
  if (field === "available") return "Available inventory";
  if (field === "status") return "Status";
  return String(field ?? "Field");
}

/** @param {any} raw @param {number} index */
function normalizeWriteProtection(raw, index) {
  const object = typeof raw === "string" ? { label: raw } : asRecord(raw);
  if (!object) return null;
  const label = String(object.label ?? object.description ?? object.target ?? "").trim();
  const target = WRITE_PROTECTION_TARGETS.includes(String(object.target ?? ""))
    ? String(object.target)
    : writeProtectionTargetsFromLabel(label)[0];
  if (!target && !label) return null;
  return {
    id: String(object.id ?? `wp_${target ?? index + 1}`),
    target: target ?? "custom",
    label: label || defaultWriteProtectionLabel(target ?? "custom"),
    source: String(object.source ?? "recommendation"),
  };
}

/** @param {unknown} label */
function writeProtectionTargetsFromLabel(label) {
  const text = String(label ?? "").toLowerCase();
  if (
    !/\b(do not|don't|without|no )\b/.test(text) &&
    !/\bnot (change|alter|modify|update)\b/.test(text) &&
    !/\b(forbidden|must not|leave .* unchanged)\b/.test(text)
  ) {
    return [];
  }
  /** @type {string[]} */
  const targets = [];
  if (/\binventor|stock|quantity\b/.test(text)) targets.push("inventory");
  if (/\bpric|discount|markdown\b/.test(text)) targets.push("pricing");
  if (/\bstatus|archiv|unpublish\b/.test(text)) targets.push("status");
  if (/\bcopy|description\b/.test(text)) targets.push("copy");
  else if (/\btitle\b/.test(text)) targets.push("title");
  return targets;
}

/** @param {string} target */
function defaultWriteProtectionLabel(target) {
  if (target === "inventory") return "Do not change inventory";
  if (target === "pricing") return "Do not change prices";
  if (target === "status") return "Do not change product status";
  if (target === "copy") return "Do not change product copy";
  if (target === "title") return "Do not change titles";
  return "Do not make unrelated changes";
}

/** @param {any[]} rows */
function dedupeWriteProtections(rows) {
  const seen = new Set();
  return rows.filter((/** @type {any} */ row) => {
    const key = `${row.target}:${row.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {any} resource @param {any} criterion */
function resourceValue(resource, criterion) {
  const facts = /** @type {Record<string, any>} */ (normalizeResourceFacts(resource));
  if (criterion.field === "available") return facts.available;
  if (criterion.field === "status") return facts.status;
  if (criterion.field === "productType") return facts.productType;
  if (criterion.field === "price") return facts.price;
  if (criterion.field === "tags") return facts.tags;
  if (criterion.field === "vendor") return facts.vendor;
  if (criterion.field === "handle") return facts.handle;
  if (criterion.field === "title") return facts.title;
  if (criterion.field === "id") return facts.productId ?? facts.id;
  return facts[criterion.field] ?? resource?.[criterion.field] ?? null;
}

/** @param {any} actual @param {string} operator @param {any} expected */
function compareValues(actual, operator, expected) {
  if (operator === "in" || operator === "not_in") {
    const haystack = Array.isArray(expected) ? expected.map(normalizeComparable) : [normalizeComparable(expected)];
    const actuals = Array.isArray(actual) ? actual.map(normalizeComparable) : [normalizeComparable(actual)];
    const hit = actuals.some((item) => haystack.includes(item));
    return operator === "in" ? hit : !hit;
  }
  if (operator === "contains" || operator === "not_contains") {
    const haystack = Array.isArray(actual)
      ? actual.map((item) => normalizeComparable(item))
      : [normalizeComparable(actual)];
    const needle = normalizeComparable(expected);
    const hit = haystack.some((item) => item.includes(needle));
    return operator === "contains" ? hit : !hit;
  }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === "gt") return left > right;
    if (operator === "gte") return left >= right;
    if (operator === "lt") return left < right;
    return left <= right;
  }
  const left = normalizeComparable(actual);
  const right = normalizeComparable(expected);
  if (operator === "neq") return left !== right;
  return left === right;
}

/** @param {any} value */
function normalizeComparable(value) {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value).trim().toLowerCase();
}

/** @param {any} value @param {Map<string, any>} byId @param {number} [depth] */
function walkForResources(value, byId, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) walkForResources(item, byId, depth + 1);
    return;
  }
  const object = /** @type {Record<string, any>} */ (value);
  const id = object.id ?? object.productId;
  const looksLikeProduct =
    typeof id === "string" &&
    (id.includes("Product") || object.productType != null || object.product_type != null || object.status != null) &&
    !String(id).includes("ProductVariant") &&
    !String(id).includes("InventoryItem");
  if (looksLikeProduct) {
    const facts = normalizeResourceFacts(object);
    const key = String(facts.productId ?? facts.id ?? facts.title ?? `anon_${byId.size}`);
    if (!byId.has(key)) byId.set(key, facts);
  }
  for (const nested of Object.values(object)) {
    if (nested && typeof nested === "object") walkForResources(nested, byId, depth + 1);
  }
}

/** @param {any} value @param {string[]} ids @param {number} [depth] */
function collectProductIds(value, ids, depth = 0) {
  if (value == null || depth > 6) return;
  if (typeof value === "string" && value.includes("gid://shopify/Product/") && !value.includes("ProductVariant")) {
    ids.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProductIds(item, ids, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) collectProductIds(nested, ids, depth + 1);
  }
}

/** @param {any} object */
function flattenVariants(object) {
  if (Array.isArray(object.variants)) return object.variants.map((/** @type {any} */ row) => asRecord(row) ?? {}).filter(Boolean);
  const nested = asRecord(object.variants);
  if (Array.isArray(nested?.edges)) {
    return nested.edges.map((edge) => asRecord(edge?.node) ?? {}).filter(Boolean);
  }
  if (Array.isArray(nested?.nodes)) return nested.nodes.map((row) => asRecord(row) ?? {}).filter(Boolean);
  return [];
}

/** @param {any} value */
function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((row) => String(row ?? "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((row) => row.trim()).filter(Boolean);
  return [];
}

/** @param {any[]} values */
function firstNumber(values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/** @param {any[]} values */
function sumNumbers(values) {
  const numbers = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

/** @param {any[]} items @param {any[]} criteria */
function candidateSummary(items, criteria) {
  const labels = merchantEligibilityLabels(criteria);
  if (!labels.length) return items.length ? `${items.length} candidate resource${items.length === 1 ? "" : "s"}.` : "No structured eligibility criteria.";
  return `Resources that match: ${labels.join("; ")}.`;
}

/** @param {any} scope */
function scopeText(scope) {
  if (typeof scope === "string") return scope;
  const object = asRecord(scope);
  return [object?.summary, object?.description, object?.candidateScope].filter(Boolean).join(" ");
}

/** @param {any} value */
function formatActual(value) {
  if (value == null) return "unknown";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** @param {any} value */
function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((row) => String(row ?? "").trim()).filter(Boolean))];
}

/** @param {unknown} value */
function stringOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}
