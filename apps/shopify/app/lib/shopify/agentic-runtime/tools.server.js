// @ts-check

import { Type } from "@google/genai";
import { executeShopifyOperation } from "../api/gateway.server.js";
import { retrieveShopifyApiOperations } from "../api/retrieval.server.js";

export const SHOPIFY_AGENT_TOOL = Object.freeze({
  retrieveOperations: "retrieve_shopify_operations",
  callOperation: "call_shopify_operation",
});

export const SHOPIFY_AGENT_TOOL_CALL_SCHEMA = {
  type: Type.ARRAY,
  nullable: true,
  items: {
    type: Type.OBJECT,
    required: ["tool"],
    properties: {
      tool: { type: Type.STRING },
      arguments: {
        type: Type.OBJECT,
        nullable: true,
        properties: {
          query: { type: Type.STRING, nullable: true },
          operationKind: {
            type: Type.STRING,
            enum: ["QUERY", "MUTATION"],
            nullable: true,
          },
          limit: { type: Type.NUMBER, nullable: true },
          operation: { type: Type.STRING, nullable: true },
          variables: { type: Type.OBJECT, nullable: true },
          purpose: { type: Type.STRING, nullable: true },
          expectedEffect: { type: Type.STRING, nullable: true },
          whyRequiredForAction: { type: Type.STRING, nullable: true },
          idempotencyKey: { type: Type.STRING, nullable: true },
        },
      },
    },
  },
};

/**
 * @typedef {{
 *   tool: string;
 *   ok: boolean;
 *   message: string;
 *   facts: Record<string, any>;
 *   error: { code: string; message: string } | null;
 * }} ShopifyAgentToolResult
 */

/**
 * @param {{
 *   prisma?: any;
 *   client: { request: Function };
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   actionId?: string | null;
 *   actionExecutionId?: string | null;
 *   acceptedActionRevision?: string | null;
 *   grantedScopes?: string[];
 *   catalog?: import("../api/catalog.server.js").ShopifyApiCatalog;
 *   recommendationMode?: boolean;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} ctx
 * @param {{ tool: string; arguments?: Record<string, any> | null }} call
 * @returns {Promise<ShopifyAgentToolResult>}
 */
export async function runShopifyAgentTool(ctx, call) {
  const args =
    call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
      ? call.arguments
      : {};
  if (call.tool === SHOPIFY_AGENT_TOOL.retrieveOperations) {
    const query = String(args.query ?? "").trim();
    if (!query) return toolFail(call.tool, "MISSING_QUERY", "query is required.");
    const results = retrieveShopifyApiOperations(query, {
      catalog: ctx.catalog,
      operationKind:
        args.operationKind === "QUERY" || args.operationKind === "MUTATION"
          ? args.operationKind
          : undefined,
      limit: boundedLimit(args.limit),
    });
    return {
      tool: call.tool,
      ok: true,
      message: `Retrieved ${results.length} Shopify operation stubs.`,
      facts: { query, results },
      error: null,
    };
  }
  if (call.tool === SHOPIFY_AGENT_TOOL.callOperation) {
    const operation = String(args.operation ?? "").trim();
    if (!operation) return toolFail(call.tool, "MISSING_OPERATION", "operation is required.");
    if (ctx.recommendationMode && !operationLooksRead(operation)) {
      return toolFail(
        call.tool,
        "RECOMMENDATION_WRITE_DENIED",
        "Recommendation investigation may run Shopify reads only. Mutations require Action acceptance.",
      );
    }
    if (!ctx.recommendationMode && !operationLooksRead(operation) && typeof args.idempotencyKey !== "string") {
      return toolFail(
        call.tool,
        "MISSING_IDEMPOTENCY_KEY",
        "Shopify writes during execution require a stable idempotencyKey.",
      );
    }
    const result = await executeShopifyOperation({
      prisma: ctx.prisma,
      client: ctx.client,
      merchantId: ctx.merchantId,
      shopId: ctx.shopId,
      shopDomain: ctx.shopDomain,
      actionId: ctx.actionId ?? null,
      actionExecutionId: ctx.actionExecutionId ?? null,
      acceptedActionRevision: ctx.acceptedActionRevision ?? null,
      operation,
      variables: asVariables(args.variables),
      purpose: String(args.purpose ?? args.whyRequiredForAction ?? ""),
      expectedEffect: String(args.expectedEffect ?? ""),
      idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : null,
      grantedScopes: ctx.grantedScopes,
      catalog: ctx.catalog,
      logger: ctx.logger,
    });
    return {
      tool: call.tool,
      ok: result.ok,
      message: result.ok
        ? `${operation} completed through the Shopify gateway.`
        : `${operation} did not complete: ${result.status}.`,
      facts: {
        operation,
        variables: asVariables(args.variables),
        status: result.status,
        gatewayDecision: result.gatewayDecision ?? null,
        userErrors: result.userErrors ?? [],
        resourceIds: result.resourceIds ?? [],
        responseSummary: result.responseSummary ?? {},
        data: summarizeProviderData(result.data),
      },
      error: result.ok
        ? null
        : {
            code: String(result.status ?? "SHOPIFY_OPERATION_FAILED"),
            message: String(result.error ?? result.gatewayDecision ?? "Shopify operation failed."),
          },
    };
  }
  return toolFail(call.tool, "UNKNOWN_TOOL", `${call.tool} is not available.`);
}

/** @param {any[] | undefined} values */
export function publicShopifyToolResults(values) {
  return (values ?? []).map((row) => ({
    tool: row.tool,
    ok: row.ok,
    message: row.message,
    facts: row.facts,
    error: row.error,
  }));
}

/** @param {unknown} value */
function boundedLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(12, Math.floor(number))) : 8;
}

/** @param {unknown} value */
function asVariables(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} data */
function summarizeProviderData(data) {
  if (!data || typeof data !== "object") return data ?? null;
  return {
    topLevelKeys: Object.keys(data).slice(0, 12),
    ...data,
  };
}

/**
 * Recommendation mode only has an operation string before catalogue lookup.
 * Treat known mutating verbs as writes; the gateway remains the authoritative
 * check after action acceptance.
 * @param {string} operation
 */
function operationLooksRead(operation) {
  return !/(create|update|delete|set|add|remove|adjust|refund|cancel|bulk)/i.test(operation);
}

/** @returns {ShopifyAgentToolResult} */
function toolFail(tool, code, message) {
  return {
    tool,
    ok: false,
    message,
    facts: {},
    error: { code, message },
  };
}
