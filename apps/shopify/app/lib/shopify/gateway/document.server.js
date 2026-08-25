// @ts-check
//
// Deterministic GraphQL document validation for the Agentic Shopify Gateway. This is the layer
// that must never rely on the model voluntarily obeying instructions (docs/ops/
// agentic-shopify-gateway/03-security-model.md). Every check here is structural: parsed AST shape,
// never operation-name string matching, never "did the model say this was read-only."
//
// Pipeline (Part 3 of the design doc):
//   parse document -> reject fragments/unknown definitions -> exactly one operation ->
//   operation kind matches the calling tool's mode -> no hidden multi-mutation smuggling ->
//   structural size/depth/pagination limits -> best-effort argument validation against the
//   schema index -> mutation payloads must select userErrors -> normalized, repairable error
//   OR a validated, printable document ready for execution.

import { Kind, parse, print } from "graphql";
import { classifyShopifyOperationDomain } from "../api/domain-taxonomy.server.js";
import { classifyShopifyOperationSafety } from "../api/mutation-safety.server.js";
import { inferShopifyOperationScopes } from "../api/domain-taxonomy.server.js";

export const GATEWAY_MODE = Object.freeze({
  queryOnly: "QUERY_ONLY",
  mutationOnly: "MUTATION_ONLY",
});

const MAX_SELECTION_DEPTH = 12;
const MAX_SELECTION_NODES = 400;
const MAX_PAGE_SIZE = 250;
const ALLOWED_DIRECTIVES = new Set(["include", "skip"]);

/**
 * @param {{
 *   documentText: string;
 *   mode: "QUERY_ONLY" | "MUTATION_ONLY";
 *   variables?: Record<string, unknown>;
 *   schemaIndex?: import("./schema-index.server.js").GatewaySchemaIndex;
 * }} input
 */
export function analyzeGatewayDocument(input) {
  const variables = input.variables ?? {};

  let ast;
  try {
    ast = parse(input.documentText);
  } catch (error) {
    return fail("GRAPHQL_SYNTAX_ERROR", `GraphQL document does not parse: ${errorMessage(error)}`);
  }

  for (const definition of ast.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      return fail(
        "FRAGMENTS_NOT_SUPPORTED",
        "Named fragments are not supported by the gateway document surface. Inline every selection directly in the operation.",
      );
    }
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      return fail("UNSUPPORTED_DEFINITION", `Only a single operation definition is supported; found "${definition.kind}".`);
    }
  }

  const operations = ast.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length !== 1) {
    return fail(
      "MULTIPLE_OPERATIONS_IN_DOCUMENT",
      `Exactly one operation is allowed per document; found ${operations.length}.`,
    );
  }
  const operation = /** @type {import("graphql").OperationDefinitionNode} */ (operations[0]);

  if (operation.operation === "subscription") {
    return fail("SUBSCRIPTIONS_NOT_SUPPORTED", "Subscriptions are not part of the Shopify Admin GraphQL surface the gateway executes.");
  }

  const expectedOperation = input.mode === GATEWAY_MODE.queryOnly ? "query" : "mutation";
  if (operation.operation !== expectedOperation) {
    return fail(
      "SAFETY_OPERATION_KIND_MISMATCH",
      `This tool only accepts "${expectedOperation}" documents; the document is a "${operation.operation}". ` +
        (expectedOperation === "query"
          ? "Use shopify_prepare_mutation / shopify_execute_mutation for writes."
          : "Use shopify_query for reads."),
    );
  }

  const directiveError = findDisallowedDirective(operation);
  if (directiveError) return directiveError;

  const topLevelSelections = operation.selectionSet.selections;
  for (const selection of topLevelSelections) {
    if (selection.kind !== Kind.FIELD) {
      return fail(
        "INLINE_FRAGMENT_NOT_SUPPORTED",
        "Top-level selections must be plain fields; inline fragments and fragment spreads are not supported.",
      );
    }
  }

  if (input.mode === GATEWAY_MODE.mutationOnly && topLevelSelections.length !== 1) {
    return fail(
      "MULTIPLE_ROOT_MUTATION_FIELDS",
      `A mutation document may select exactly one root mutation field so it always maps to a single classified, confirmable operation; found ${topLevelSelections.length}.`,
    );
  }

  const sizeCheck = checkStructuralLimits(operation.selectionSet);
  if (!sizeCheck.ok) return sizeCheck;

  const paginationCheck = checkPaginationBounds(operation.selectionSet, variables);
  if (!paginationCheck.ok) return paginationCheck;

  const rootFieldNodes = /** @type {import("graphql").FieldNode[]} */ (topLevelSelections);
  const rootFields = rootFieldNodes.map((field) => field.name.value);

  if (input.mode === GATEWAY_MODE.mutationOnly) {
    const rootField = rootFieldNodes[0];
    if (!selectsUserErrors(rootField)) {
      return fail(
        "MUTATION_MUST_SELECT_USER_ERRORS",
        `The mutation payload must select "userErrors { field message }" (or equivalent) so the gateway can distinguish an HTTP-200 response from a real business success. Add a userErrors selection to ${rootField.name.value}.`,
      );
    }
  }

  const rootField = rootFields[0];
  const domain = classifyShopifyOperationDomain(rootField);
  const operationKind = input.mode === GATEWAY_MODE.mutationOnly ? "MUTATION" : "QUERY";
  const known = input.schemaIndex?.byOperation.get(rootField);

  const { requiredScopes, scopeConfidence } = known
    ? { requiredScopes: known.requiredScopes, scopeConfidence: known.scopeConfidence }
    : inferShopifyOperationScopes(rootField, domain, operationKind);

  if (known) {
    const argumentCheck = checkKnownArguments(rootFieldNodes[0], known, variables);
    if (!argumentCheck.ok) return argumentCheck;
  }

  const { safety, execution } = classifyShopifyOperationSafety({
    operation: rootField,
    operationKind,
    domain,
    scopeConfidence,
  });

  return {
    ok: true,
    operationKind,
    rootFields,
    rootField,
    domain,
    requiredScopes,
    scopeConfidence,
    safety,
    execution,
    knownInSchemaIndex: Boolean(known),
    normalizedDocument: print(ast),
    variableDefinitionNames: (operation.variableDefinitions ?? []).map((def) => def.variable.name.value),
  };
}

/**
 * Normalizes Shopify's three distinct failure shapes (HTTP error, top-level GraphQL error,
 * userErrors) plus outright parse failures into one compact, repair-oriented error the agent can
 * act on directly (Part 3: "return a compact error that allows the LLM to repair its query").
 * @param {unknown} error
 */
export function normalizeGatewayProviderError(error) {
  const raw = /** @type {any} */ (error);
  const graphqlErrors = Array.isArray(raw?.errors) ? raw.errors : null;
  if (graphqlErrors) {
    return {
      code: "SHOPIFY_GRAPHQL_ERROR",
      message: graphqlErrors
        .map((entry) => entry?.message)
        .filter(Boolean)
        .slice(0, 5)
        .join("; ") || "Shopify rejected the document.",
      details: graphqlErrors.slice(0, 5).map((entry) => ({
        message: entry?.message ?? null,
        path: entry?.path ?? null,
        code: entry?.extensions?.code ?? null,
      })),
    };
  }
  return {
    code: "SHOPIFY_PROVIDER_ERROR",
    message: error instanceof Error ? error.message : String(error ?? "Unknown provider error"),
    details: [],
  };
}

/** @param {import("graphql").OperationDefinitionNode} operation */
function findDisallowedDirective(operation) {
  let found = null;
  walkSelections(operation.selectionSet, (node) => {
    if (found) return;
    for (const directive of node.directives ?? []) {
      if (!ALLOWED_DIRECTIVES.has(directive.name.value)) {
        found = fail(
          "DIRECTIVE_NOT_SUPPORTED",
          `Directive "@${directive.name.value}" is not supported by the gateway document surface (only @include/@skip are).`,
        );
        return;
      }
    }
  });
  return found;
}

/** @param {import("graphql").SelectionSetNode} selectionSet */
function checkStructuralLimits(selectionSet) {
  let nodeCount = 0;
  let maxDepth = 0;
  let exceeded = null;
  const visit = (/** @type {import("graphql").SelectionSetNode} */ node, /** @type {number} */ depth) => {
    if (exceeded) return;
    maxDepth = Math.max(maxDepth, depth);
    if (depth > MAX_SELECTION_DEPTH) {
      exceeded = fail("STRUCTURAL_LIMIT_EXCEEDED", `Selection depth ${depth} exceeds the gateway limit of ${MAX_SELECTION_DEPTH}.`);
      return;
    }
    for (const selection of node.selections) {
      nodeCount += 1;
      if (nodeCount > MAX_SELECTION_NODES) {
        exceeded = fail(
          "STRUCTURAL_LIMIT_EXCEEDED",
          `Document selects ${nodeCount}+ fields, exceeding the gateway limit of ${MAX_SELECTION_NODES}. Narrow the query.`,
        );
        return;
      }
      if (selection.kind === Kind.FIELD && selection.selectionSet) {
        visit(selection.selectionSet, depth + 1);
      }
    }
  };
  visit(selectionSet, 1);
  return exceeded ?? { ok: true };
}

/**
 * @param {import("graphql").SelectionSetNode} selectionSet
 * @param {Record<string, unknown>} variables
 */
function checkPaginationBounds(selectionSet, variables) {
  let exceeded = null;
  walkSelections(selectionSet, (node) => {
    if (exceeded) return;
    for (const argName of ["first", "last"]) {
      const arg = node.arguments?.find((a) => a.name.value === argName);
      if (!arg) continue;
      const value = literalOrVariableValue(arg.value, variables);
      if (typeof value === "number" && value > MAX_PAGE_SIZE) {
        exceeded = fail(
          "STRUCTURAL_LIMIT_EXCEEDED",
          `${node.name.value}(${argName}: ${value}) exceeds the gateway pagination cap of ${MAX_PAGE_SIZE}.`,
        );
        return;
      }
    }
  });
  return exceeded ?? { ok: true };
}

/**
 * @param {import("graphql").FieldNode} rootField
 * @param {any} known
 * @param {Record<string, unknown>} variables
 */
function checkKnownArguments(rootField, known, variables) {
  const knownArgNames = new Set((known.arguments ?? []).map((a) => a.name));
  for (const arg of rootField.arguments ?? []) {
    if (!knownArgNames.has(arg.name.value)) {
      return fail(
        "UNKNOWN_ARGUMENT",
        `${known.operation} has no known argument "${arg.name.value}". Known arguments: ${[...knownArgNames].join(", ") || "(none)"}.`,
      );
    }
  }
  const providedArgNames = new Set((rootField.arguments ?? []).map((a) => a.name.value));
  for (const argument of known.arguments ?? []) {
    if (argument.required && !providedArgNames.has(argument.name)) {
      return fail("MISSING_REQUIRED_ARGUMENT", `${known.operation} requires argument "${argument.name}" (${argument.type}).`);
    }
  }
  return { ok: true };
}

/** @param {import("graphql").FieldNode} field */
function selectsUserErrors(field) {
  let found = false;
  walkSelections(field.selectionSet ?? { kind: Kind.SELECTION_SET, selections: [] }, (node) => {
    if (node.name.value === "userErrors") found = true;
  });
  return found;
}

/**
 * @param {import("graphql").SelectionSetNode} selectionSet
 * @param {(node: import("graphql").FieldNode) => void} visitor
 */
function walkSelections(selectionSet, visitor) {
  for (const selection of selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) continue;
    visitor(selection);
    if (selection.selectionSet) walkSelections(selection.selectionSet, visitor);
  }
}

/**
 * @param {import("graphql").ValueNode} valueNode
 * @param {Record<string, unknown>} variables
 */
function literalOrVariableValue(valueNode, variables) {
  if (valueNode.kind === Kind.INT) return Number(valueNode.value);
  if (valueNode.kind === Kind.VARIABLE) {
    const value = variables[valueNode.name.value];
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

/** @param {string} code @param {string} message */
function fail(code, message) {
  return { ok: false, code, message, repairable: true };
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
