// @ts-check
//
// Generic, deterministic preview generation for any Shopify mutation — task §7. Built purely
// from the operation stub, the validated request variables, and (optionally) a caller-supplied
// map of currently-known field values for the affected resource(s). Never depends on an LLM
// paraphrasing its own write — this is a pure function over structured data, the same
// determinism discipline mutation-safety.server.js's classification and blast-radius.server.js's
// measurement already hold to.
//
// Honest limitation, documented rather than hidden: this module cannot itself go read Shopify —
// there is no generic mapping from an arbitrary mutation to "the query that reads its current
// state" (that mapping is real domain knowledge, operation by operation, which is exactly what
// the whole architecture change was built to avoid requiring). Callers that already have current
// state (execution-agent.server.js's system prompt already tells the LLM to read before
// mutating; the 4 typed adapters read current state before writing) can pass it in via
// `currentState` to get real "current → new" diffs; without it, the preview still deterministically
// describes what the mutation WILL set, just without a "was" value to compare against.

/**
 * @param {{
 *   stub: import("./catalog.server.js").ShopifyApiOperationStub;
 *   variables: Record<string, unknown>;
 *   currentState?: Record<string, unknown>;
 * }} input
 * @returns {{
 *   kind: "create" | "update" | "delete" | "action";
 *   operation: string;
 *   resource: string | null;
 *   fields: Array<{ field: string; currentValue: unknown; newValue: unknown }>;
 *   money: Array<{ field: string; amount: unknown }>;
 *   consequence: string | null;
 *   recoverability: string;
 * }}
 */
export function buildGenericShopifyOperationPreview(input) {
  const { stub, variables, currentState = {} } = input;
  const kind = classifyOperationKind(stub.operation);
  const resource = extractPrimaryResourceId(variables) ?? extractPrimaryResourceId(currentState);
  const fields = extractFields(stub, variables, currentState);
  const money = extractMoneyFields(stub, variables);

  let consequence = null;
  if (kind === "delete") {
    consequence = `${resource ?? "the target resource"} will be removed from Shopify.`;
  } else if (kind === "action" && /cancel|revoke|close|disable/i.test(stub.operation)) {
    consequence = `${resource ?? "the target resource"} will be ${actionVerbPastTense(stub.operation)}.`;
  }

  return {
    kind,
    operation: stub.operation,
    resource,
    fields,
    money,
    consequence,
    recoverability: describeRecoverability(stub.safety?.reversibility),
  };
}

/** @param {string} operation */
function classifyOperationKind(operation) {
  if (/(delete|erase|remove)$/i.test(operation) || /^delete/i.test(operation)) return "delete";
  if (/create$/i.test(operation)) return "create";
  if (/update$|set$|upsert$/i.test(operation)) return "update";
  return "action"; // cancel/close/approve/publish/activate/etc — a state-transition, not a plain CRUD verb
}

/** @param {string} operation */
function actionVerbPastTense(operation) {
  if (/cancel/i.test(operation)) return "cancelled";
  if (/revoke/i.test(operation)) return "revoked";
  if (/close/i.test(operation)) return "closed";
  if (/disable/i.test(operation)) return "disabled";
  return "changed";
}

/** @param {string | undefined} reversibility */
function describeRecoverability(reversibility) {
  switch (reversibility) {
    case "REVERSIBLE":
      return "Reversible: this can be changed again or undone directly.";
    case "COMPENSATABLE":
      return "Compensatable: not undoable directly, but correctable with a follow-up transaction (e.g. a counter-entry).";
    case "IRREVERSIBLE":
      return "Irreversible: Shopify provides no direct undo for this operation.";
    default:
      return "Recoverability unknown — treat as irreversible until confirmed otherwise.";
  }
}

/** @param {Record<string, unknown>} variables */
function extractPrimaryResourceId(variables) {
  /** @type {string | null} */
  let found = null;
  walk(variables, (value, path) => {
    if (found) return;
    if (typeof value === "string" && value.startsWith("gid://shopify/") && /(^|\.)id$/i.test(path)) {
      found = value;
    }
  });
  if (found) return found;
  // Fall back to the first gid anywhere (e.g. a differently-named target field).
  walk(variables, (value) => {
    if (!found && typeof value === "string" && value.startsWith("gid://shopify/")) found = value;
  });
  return found;
}

/**
 * @param {import("./catalog.server.js").ShopifyApiOperationStub} stub
 * @param {Record<string, unknown>} variables
 * @param {Record<string, unknown>} currentState
 */
function extractFields(stub, variables, currentState) {
  /** @type {Array<{ field: string; currentValue: unknown; newValue: unknown }>} */
  const fields = [];
  walk(variables, (value, path) => {
    if (value === null || (typeof value === "object" && !Array.isArray(value))) return; // only leaves
    if (typeof value === "string" && value.startsWith("gid://shopify/")) return; // identifiers, not field changes
    const leafName = path.split(".").pop() ?? path;
    fields.push({
      field: path,
      currentValue: Object.hasOwn(currentState, leafName) ? currentState[leafName] : Object.hasOwn(currentState, path) ? currentState[path] : "unknown — not read",
      newValue: value,
    });
  });
  return fields;
}

const MONEY_TYPE_PATTERN = /^Money$|MoneyInput|MoneyV2/;

/**
 * @param {import("./catalog.server.js").ShopifyApiOperationStub} stub
 * @param {Record<string, unknown>} variables
 */
function extractMoneyFields(stub, variables) {
  /** @type {Array<{ field: string; amount: unknown }>} */
  const money = [];
  // "Money" itself is a GraphQL scalar, not an entry in stub.inputObjects (that map only holds
  // input OBJECT types) — match the declared type name directly during the walk rather than
  // pre-filtering inputObjects keys, or a plain-scalar Money field (e.g. OrderTransactionInput.
  // amount: Money!) would never be found.
  walkTyped(stub, variables, (value, path, typeName) => {
    if (typeName && MONEY_TYPE_PATTERN.test(typeName)) money.push({ field: path, amount: value });
  });
  return money;
}

/**
 * @param {unknown} value
 * @param {(value: unknown, path: string) => void} visitor
 * @param {string} [path]
 */
function walk(value, visitor, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, path ? `${path}[${index}]` : `[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, visitor, path ? `${path}.${key}` : key);
    return;
  }
  visitor(value, path);
}

/**
 * Schema-type-aware walk (needed to identify Money-typed nested objects, which a plain
 * name-based walk can't reliably distinguish from any other input object).
 * @param {import("./catalog.server.js").ShopifyApiOperationStub} stub
 * @param {Record<string, unknown>} variables
 * @param {(value: unknown, path: string, typeName: string | null) => void} visitor
 */
function walkTyped(stub, variables, visitor) {
  for (const argument of stub.arguments) {
    walkTypedValue(argument.type, variables[argument.name], argument.name, stub.inputObjects, visitor);
  }
}

/**
 * @param {string} type
 * @param {unknown} value
 * @param {string} path
 * @param {import("./catalog.server.js").ShopifyApiOperationStub["inputObjects"]} inputObjects
 * @param {(value: unknown, path: string, typeName: string | null) => void} visitor
 */
function walkTypedValue(type, value, path, inputObjects, visitor) {
  if (value === null || value === undefined) return;
  const nullableType = type.endsWith("!") ? type.slice(0, -1) : type;
  const listMatch = nullableType.match(/^\[(.+)\]$/);
  if (listMatch) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkTypedValue(listMatch[1], item, `${path}[${index}]`, inputObjects, visitor));
    }
    return;
  }
  visitor(value, path, nullableType);
  const inputObject = inputObjects[nullableType];
  if (!inputObject || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of inputObject.fields) {
    walkTypedValue(field.type, /** @type {any} */ (value)[field.name], `${path}.${field.name}`, inputObjects, visitor);
  }
}
