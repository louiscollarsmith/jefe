// @ts-check

import { createHash } from "node:crypto";
import {
  getConfiguredShopifyApiVersion,
  getShopifyApiOperationStub,
  validateShopifyOperationVariables,
} from "./catalog.server.js";
import { logger as defaultLogger } from "../../observability/logger.server.js";

export const SHOPIFY_GATEWAY_STATUS = Object.freeze({
  ok: "OK",
  userErrors: "SHOPIFY_USER_ERRORS",
  deniedOperationUnknown: "DENIED_OPERATION_UNKNOWN",
  deniedApiVersion: "DENIED_API_VERSION",
  deniedInvalidVariables: "DENIED_INVALID_VARIABLES",
  needsAuthorization: "NEEDS_SHOPIFY_AUTHORIZATION",
  deniedActionNotAccepted: "DENIED_ACTION_NOT_ACCEPTED",
  deniedAcceptedRevisionStale: "DENIED_ACCEPTED_REVISION_STALE",
  deniedIntent: "DENIED_OUTSIDE_ACCEPTED_INTENT",
  deniedBlastRadius: "DENIED_BLAST_RADIUS",
  providerError: "PROVIDER_ERROR",
});

const DEFAULT_MAX_AFFECTED_RESOURCES = 50;
const DANGEROUS_OPERATION_TERMS = ["delete", "refund", "cancel", "void"];
const PRICE_TERMS = ["price", "discount", "markdown", "compareatprice"];

/**
 * @param {{
 *   prisma?: any;
 *   client: { request: (document: string, variables?: Record<string, unknown>) => Promise<unknown> };
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   actionId?: string | null;
 *   actionExecutionId?: string | null;
 *   acceptedActionRevision?: string | null;
 *   operation: string;
 *   variables?: Record<string, unknown>;
 *   purpose?: string;
 *   expectedEffect?: string;
 *   idempotencyKey?: string | null;
 *   grantedScopes?: string[];
 *   apiVersion?: string;
 *   catalog?: import("./catalog.server.js").ShopifyApiCatalog;
 *   maxAffectedResources?: number;
 *   logger?: Pick<import("../../observability/logger.server.js").Logger, "info" | "warn" | "error">;
 * }} input
 */
export async function executeShopifyOperation(input) {
  const log = input.logger ?? defaultLogger;
  const variables = input.variables ?? {};
  const apiVersion = input.apiVersion ?? getConfiguredShopifyApiVersion();
  const stub = getShopifyApiOperationStub(input.operation, { catalog: input.catalog });
  if (!stub) {
    return deny(input, {
      apiVersion,
      status: SHOPIFY_GATEWAY_STATUS.deniedOperationUnknown,
      gatewayDecision: "operation_not_in_generated_catalog",
      error: `Unknown Shopify operation: ${input.operation}`,
    });
  }
  const baseLedger = {
    apiVersion,
    stub,
    variables,
    purpose: input.purpose ?? "",
    expectedEffect: input.expectedEffect ?? "",
  };
  if (stub.apiVersion && stub.apiVersion !== apiVersion) {
    return deny(input, {
      ...baseLedger,
      status: SHOPIFY_GATEWAY_STATUS.deniedApiVersion,
      gatewayDecision: "api_version_mismatch",
      error: `Operation ${stub.operation} belongs to ${stub.apiVersion}, not ${apiVersion}`,
    });
  }
  const variableValidation = validateShopifyOperationVariables(stub, variables);
  if (!variableValidation.ok) {
    return deny(input, {
      ...baseLedger,
      status: SHOPIFY_GATEWAY_STATUS.deniedInvalidVariables,
      gatewayDecision: "invalid_variables",
      error: variableValidation.errors.join("; "),
    });
  }
  const grantedScopes = input.grantedScopes ?? (await fetchGrantedShopifyScopes(input.client).catch(() => null));
  if (!grantedScopes) {
    return deny(input, {
      ...baseLedger,
      status: SHOPIFY_GATEWAY_STATUS.needsAuthorization,
      gatewayDecision: "actual_scope_probe_failed",
      error: "Could not verify Shopify granted scopes",
    });
  }
  const missingScopes = stub.requiredScopes.filter((scope) => !grantedScopes.includes(scope));
  if (missingScopes.length) {
    return deny(input, {
      ...baseLedger,
      status: SHOPIFY_GATEWAY_STATUS.needsAuthorization,
      gatewayDecision: "missing_shopify_scopes",
      error: `Missing Shopify scopes: ${missingScopes.join(", ")}`,
      responseSummary: { missingScopes },
    });
  }
  let action = null;
  if (stub.operationKind === "MUTATION") {
    const authorization = await verifyActionAuthorization(input);
    if (!authorization.ok) {
      return deny(input, {
        ...baseLedger,
        status: authorization.status,
        gatewayDecision: authorization.gatewayDecision,
        error: authorization.error,
      });
    }
    action = authorization.action;
    const intent = evaluateAcceptedIntent({
      action,
      stub,
      variables,
      purpose: input.purpose ?? "",
      expectedEffect: input.expectedEffect ?? "",
      maxAffectedResources: input.maxAffectedResources ?? DEFAULT_MAX_AFFECTED_RESOURCES,
    });
    if (!intent.ok) {
      return deny(input, {
        ...baseLedger,
        status: intent.status,
        gatewayDecision: intent.gatewayDecision,
        error: intent.error,
        responseSummary: intent.summary,
      });
    }
  }

  await recordShopifyOperationCall(input, {
    ...baseLedger,
    status: "CALLING_PROVIDER",
    gatewayDecision: "admitted",
  });
  log.info("Shopify operation admitted by universal gateway", {
    shopDomain: input.shopDomain,
    operationName: stub.operation,
    operationKind: stub.operationKind,
    actionId: input.actionId ?? null,
  });

  try {
    const response = await input.client.request(stub.document, variables);
    const userErrors = extractUserErrors(response);
    const resourceIds = extractResourceIds(response);
    const status = userErrors.length ? SHOPIFY_GATEWAY_STATUS.userErrors : SHOPIFY_GATEWAY_STATUS.ok;
    await recordShopifyOperationCall(input, {
      ...baseLedger,
      status,
      gatewayDecision: "provider_result",
      userErrors,
      resourceIds,
      responseSummary: summarizeResponse(response),
    });
    return {
      ok: !userErrors.length,
      status,
      operation: stub.operation,
      operationKind: stub.operationKind,
      data: response,
      userErrors,
      resourceIds,
      actionRevision: action ? getActionRevisionState(action).acceptedActionRevision : null,
    };
  } catch (error) {
    await recordShopifyOperationCall(input, {
      ...baseLedger,
      status: SHOPIFY_GATEWAY_STATUS.providerError,
      gatewayDecision: "provider_error",
      error: error instanceof Error ? error.message : String(error),
    });
    log.warn("Shopify operation provider error", {
      shopDomain: input.shopDomain,
      operationName: stub.operation,
      operationKind: stub.operationKind,
      err: error,
    });
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.providerError,
      operation: stub.operation,
      operationKind: stub.operationKind,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {{ request: Function }} client */
export async function fetchGrantedShopifyScopes(client) {
  const data = await client.request(
    "query JefeCurrentAppInstallation { currentAppInstallation { accessScopes { handle } } }",
    {},
  );
  return (data?.currentAppInstallation?.accessScopes ?? [])
    .map((scope) => scope?.handle)
    .filter(Boolean);
}

/**
 * @param {Parameters<typeof executeShopifyOperation>[0]} input
 * @param {Record<string, any>} details
 */
async function deny(input, details) {
  await recordShopifyOperationCall(input, details);
  return {
    ok: false,
    status: details.status,
    operation: details.stub?.operation ?? input.operation,
    operationKind: details.stub?.operationKind ?? null,
    gatewayDecision: details.gatewayDecision,
    error: details.error,
    responseSummary: details.responseSummary ?? {},
  };
}

/** @param {Parameters<typeof executeShopifyOperation>[0]} input */
async function verifyActionAuthorization(input) {
  if (!input.actionId || !input.acceptedActionRevision) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedActionNotAccepted,
      gatewayDecision: "mutation_without_accepted_action_revision",
      error: "Mutations require an accepted Action revision",
    };
  }
  const action = await input.prisma?.merchantAction?.findFirst?.({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
  });
  if (!action) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedActionNotAccepted,
      gatewayDecision: "action_not_found",
      error: "Action was not found for this merchant and shop",
    };
  }
  if (!["accepted", "active", "running", "in_progress"].includes(String(action.status))) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedActionNotAccepted,
      gatewayDecision: "action_not_active",
      error: `Action status ${action.status} is not accepted or active`,
    };
  }
  const revisionState = getActionRevisionState(action);
  if (!revisionState.acceptedActionRevision) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedActionNotAccepted,
      gatewayDecision: "action_has_no_accepted_revision",
      error: "Action does not have an accepted revision",
    };
  }
  if (
    revisionState.currentActionRevision &&
    revisionState.acceptedActionRevision !== revisionState.currentActionRevision
  ) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedAcceptedRevisionStale,
      gatewayDecision: "accepted_revision_not_current",
      error: "Accepted Action revision is stale",
    };
  }
  if (revisionState.acceptedActionRevision !== input.acceptedActionRevision) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedAcceptedRevisionStale,
      gatewayDecision: "request_revision_mismatch",
      error: "Requested accepted Action revision does not match the action",
    };
  }
  return { ok: true, action };
}

/** @param {any} action */
export function getActionRevisionState(action) {
  const progress = asRecord(action.progress) ?? {};
  const plan = asRecord(action.plan) ?? {};
  const agentic = asRecord(progress.agentic) ?? asRecord(plan.agentic) ?? {};
  const semanticAction = asRecord(progress.semanticAction) ?? asRecord(plan.semanticAction) ?? {};
  return {
    currentActionRevision:
      stringOrNull(agentic.currentActionRevision) ??
      stringOrNull(semanticAction.revision) ??
      stringOrNull(progress.currentActionRevision) ??
      stringOrNull(plan.currentActionRevision),
    acceptedActionRevision:
      stringOrNull(agentic.acceptedActionRevision) ??
      stringOrNull(semanticAction.acceptedActionRevision) ??
      stringOrNull(progress.acceptedActionRevision) ??
      stringOrNull(plan.acceptedActionRevision),
    semanticContract: {
      title: action.title,
      summary: action.summary,
      ...semanticAction,
      ...agentic,
    },
  };
}

/**
 * @param {{
 *   action: any;
 *   stub: import("./catalog.server.js").ShopifyApiOperationStub;
 *   variables: Record<string, unknown>;
 *   purpose: string;
 *   expectedEffect: string;
 *   maxAffectedResources: number;
 * }} input
 */
export function evaluateAcceptedIntent(input) {
  const revision = getActionRevisionState(input.action);
  const acceptedText = normalizeIntentText(revision.semanticContract);
  const requestedText = normalizeIntentText({
    operation: input.stub.operation,
    purpose: input.purpose,
    expectedEffect: input.expectedEffect,
    variables: Object.keys(input.variables),
  });
  const affectedResources = countAffectedResources(input.variables);
  if (affectedResources > input.maxAffectedResources) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedBlastRadius,
      gatewayDecision: "affected_resource_cap_exceeded",
      error: `Operation touches ${affectedResources} resources; cap is ${input.maxAffectedResources}`,
      summary: { affectedResources, maxAffectedResources: input.maxAffectedResources },
    };
  }
  for (const term of DANGEROUS_OPERATION_TERMS) {
    if (requestedText.includes(term) && !acceptedText.includes(term)) {
      return {
        ok: false,
        status: SHOPIFY_GATEWAY_STATUS.deniedIntent,
        gatewayDecision: "destructive_operation_not_in_accepted_intent",
        error: `${input.stub.operation} appears destructive and is not in the accepted Action intent`,
        summary: { term },
      };
    }
  }
  const noPricing = /do not (alter|change|modify|reduce|discount).*pric|no pric|without changing pric/.test(acceptedText);
  const requestedPricing = PRICE_TERMS.some((term) => requestedText.includes(term));
  const acceptedPricing = PRICE_TERMS.some((term) => acceptedText.includes(term));
  if (requestedPricing && (noPricing || !acceptedPricing)) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedIntent,
      gatewayDecision: "pricing_effect_outside_accepted_intent",
      error: "Pricing-related Shopify write is outside the accepted Action intent",
      summary: { requestedPricing, acceptedPricing, noPricing },
    };
  }
  if (input.stub.operation.toLowerCase().includes("inventory") && !/inventory|stock|quantity|location/.test(acceptedText)) {
    return {
      ok: false,
      status: SHOPIFY_GATEWAY_STATUS.deniedIntent,
      gatewayDecision: "inventory_effect_outside_accepted_intent",
      error: "Inventory write is outside the accepted Action intent",
      summary: {},
    };
  }
  return { ok: true };
}

/**
 * @param {Parameters<typeof executeShopifyOperation>[0]} input
 * @param {Record<string, any>} details
 */
async function recordShopifyOperationCall(input, details) {
  if (!input.prisma?.shopifyOperationCall?.create) return null;
  const stub = details.stub;
  return input.prisma.shopifyOperationCall.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId ?? null,
      actionExecutionId: input.actionExecutionId ?? null,
      acceptedActionRevision: input.acceptedActionRevision ?? null,
      shopDomain: input.shopDomain,
      apiVersion: details.apiVersion ?? input.apiVersion ?? getConfiguredShopifyApiVersion(),
      operationId: stub?.id ?? input.operation,
      operationName: stub?.operation ?? input.operation,
      operationKind: stub?.operationKind ?? "UNKNOWN",
      purpose: details.purpose ?? input.purpose ?? "",
      expectedEffect: details.expectedEffect ?? input.expectedEffect ?? "",
      idempotencyKey: input.idempotencyKey ?? null,
      variables: details.variables ?? input.variables ?? {},
      variablesHash: hashJson(details.variables ?? input.variables ?? {}),
      gatewayDecision: details.gatewayDecision,
      status: details.status,
      userErrors: details.userErrors ?? [],
      resourceIds: details.resourceIds ?? [],
      responseSummary: details.responseSummary ?? {},
      error: details.error ?? null,
    },
  });
}

/** @param {unknown} response */
function extractUserErrors(response) {
  const found = [];
  visit(response, (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item?.message && (item.field || item.code || Object.hasOwn(item, "message"))) {
          found.push({
            field: Array.isArray(item.field) ? item.field.join(".") : item.field ?? null,
            message: String(item.message),
            code: item.code ?? null,
          });
        }
      }
    }
  }, "userErrors");
  return found;
}

/** @param {unknown} response */
function extractResourceIds(response) {
  const ids = new Set();
  visit(response, (value, key) => {
    if (key === "id" && typeof value === "string" && value.startsWith("gid://shopify/")) {
      ids.add(value);
    }
  });
  return [...ids].sort();
}

/** @param {unknown} response */
function summarizeResponse(response) {
  return {
    topLevelKeys: response && typeof response === "object" ? Object.keys(response).slice(0, 10) : [],
    resourceIds: extractResourceIds(response).slice(0, 25),
    userErrorCount: extractUserErrors(response).length,
  };
}

/** @param {unknown} value */
function countAffectedResources(value) {
  let count = 0;
  visit(value, (entry) => {
    if (typeof entry === "string" && entry.startsWith("gid://shopify/")) count += 1;
  });
  return count;
}

/**
 * @param {unknown} value
 * @param {(value: unknown, key?: string) => void} visitor
 * @param {string} [onlyKey]
 */
function visit(value, visitor, onlyKey) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor, onlyKey);
    return;
  }
  if (!value || typeof value !== "object") {
    visitor(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!onlyKey || key === onlyKey) visitor(child, key);
    visit(child, visitor, onlyKey);
  }
}

/** @param {unknown} value */
function normalizeIntentText(value) {
  return JSON.stringify(value ?? {})
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

/** @param {unknown} value */
function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} value */
function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
