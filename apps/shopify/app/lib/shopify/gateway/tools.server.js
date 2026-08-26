// @ts-check
//
// The Agentic Shopify Gateway's model-facing tool surface (docs/ops/agentic-shopify-gateway/).
// Four tools, matching the "handful of generic agent capabilities" the design calls for — never
// hundreds of operation-specific ones, and never a per-operation registry the model reads from:
//
//   shopify_schema           — targeted schema discovery (search / inspect a root field, enum,
//                               or input object). Never dumps the full schema into context.
//   shopify_query             — arbitrary agent-composed read-only GraphQL. Structurally cannot
//                               execute a mutation; see document.server.js GATEWAY_MODE.queryOnly.
//   shopify_prepare_mutation  — validates + classifies + previews an agent-composed mutation
//                               WITHOUT executing it (no network call, no ledger row). Tells the
//                               agent the risk tier and whether explicit confirmation will be
//                               required before shopify_execute_mutation can succeed.
//   shopify_execute_mutation  — actually executes a validated mutation through the same universal
//                               gateway (../api/gateway.server.js) the catalog surface uses:
//                               accepted-Action-revision authorization, blast-radius caps,
//                               explicit high-risk confirmation, idempotency, and the durable
//                               ShopifyOperationCall ledger all apply unchanged.
//
// Recommendation/verification mode only ever receives shopify_schema + shopify_query — the two
// mutation tools are omitted from the tool list entirely at each call site (recommendation-agent,
// verification-agent, action-chat), not merely instructed against. A model that emits a "mutation"
// GraphQL document to shopify_query still cannot succeed: analyzeGatewayDocument() rejects it
// structurally (SAFETY_OPERATION_KIND_MISMATCH) before any network call, regardless of which tools
// happen to be listed.
//
// This is the ONLY Shopify agent tool surface on this branch (docs/ops/agentic-shopify-gateway-full/)
// — the previous generated 810-operation catalog and its dispatcher (agentic-runtime/tools.server.js,
// api/catalog.server.js, api/retrieval.server.js, api/generation.server.js, agentic-runtime/
// tool-surface.server.js) have been removed entirely, not merely superseded.

import { Type } from "@google/genai";
import { executeShopifyOperation } from "../api/gateway.server.js";
import { computeShopifyBlastRadius, evaluateBlastRadiusCap } from "../api/blast-radius.server.js";
import { buildGenericShopifyOperationPreview } from "../api/preview.server.js";
import { analyzeGatewayDocument, normalizeGatewayProviderError, GATEWAY_MODE } from "./document.server.js";
import { buildSyntheticGatewayStub } from "./synthetic-stub.server.js";
import {
  loadGatewaySchemaIndex,
  searchGatewaySchema,
  inspectGatewayField,
  listGatewayRootFields,
  inspectGatewayEnum,
  inspectGatewayInputObject,
} from "./schema-index.server.js";

export const SHOPIFY_GATEWAY_TOOL = Object.freeze({
  schema: "shopify_schema",
  query: "shopify_query",
  prepareMutation: "shopify_prepare_mutation",
  executeMutation: "shopify_execute_mutation",
});

export const SHOPIFY_GATEWAY_TOOL_CALL_SCHEMA = {
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
          action: {
            type: Type.STRING,
            enum: ["search", "inspect_field", "list_fields", "inspect_enum", "inspect_input"],
            nullable: true,
          },
          query: { type: Type.STRING, nullable: true },
          fieldName: { type: Type.STRING, nullable: true },
          typeName: { type: Type.STRING, nullable: true },
          kind: { type: Type.STRING, enum: ["QUERY", "MUTATION"], nullable: true },
          prefix: { type: Type.STRING, nullable: true },
          limit: { type: Type.NUMBER, nullable: true },
          document: { type: Type.STRING, nullable: true },
          variables: { type: Type.OBJECT, nullable: true },
          purpose: { type: Type.STRING, nullable: true },
          expectedEffect: { type: Type.STRING, nullable: true },
          idempotencyKey: { type: Type.STRING, nullable: true },
        },
      },
    },
  },
};

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
 *   grantedScopes?: string[];
 *   apiVersion: string;
 *   recommendationMode?: boolean;
 *   preAcceptanceMode?: boolean;
 *   verificationMode?: boolean;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} ctx
 * @param {{ tool: string; arguments?: Record<string, any> | null }} call
 */
export async function runShopifyGatewayTool(ctx, call) {
  const args =
    call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
  const index = loadGatewaySchemaIndex();

  if (call.tool === SHOPIFY_GATEWAY_TOOL.schema) {
    return handleSchemaTool(call.tool, args, index);
  }

  if (call.tool === SHOPIFY_GATEWAY_TOOL.query) {
    return handleQueryTool(ctx, call.tool, args, index);
  }

  if (call.tool === SHOPIFY_GATEWAY_TOOL.prepareMutation) {
    if (ctx.recommendationMode || ctx.verificationMode) {
      return toolFail(call.tool, "MUTATION_TOOL_UNAVAILABLE", "Mutations are not available in this mode.");
    }
    return handlePrepareMutationTool(ctx, call.tool, args, index);
  }

  if (call.tool === SHOPIFY_GATEWAY_TOOL.executeMutation) {
    if (ctx.recommendationMode || ctx.verificationMode) {
      return toolFail(call.tool, "MUTATION_TOOL_UNAVAILABLE", "Mutations are not available in this mode.");
    }
    return handleExecuteMutationTool(ctx, call.tool, args, index);
  }

  return toolFail(call.tool, "UNKNOWN_TOOL", `${call.tool} is not available.`);
}

/** @param {string} tool @param {Record<string, any>} args @param {import("./schema-index.server.js").GatewaySchemaIndex} index */
function handleSchemaTool(tool, args, index) {
  const action = String(args.action ?? "search");
  if (action === "search") {
    const query = String(args.query ?? "").trim();
    if (!query) return toolFail(tool, "MISSING_QUERY", "query is required for action=search.");
    const kind = args.kind === "QUERY" || args.kind === "MUTATION" ? args.kind : undefined;
    const results = searchGatewaySchema(index, query, { kind, limit: args.limit });
    return toolOk(tool, `Found ${results.length} matching Shopify schema fields.`, { action, query, results });
  }
  if (action === "inspect_field") {
    const fieldName = String(args.fieldName ?? "").trim();
    if (!fieldName) return toolFail(tool, "MISSING_FIELD_NAME", "fieldName is required for action=inspect_field.");
    const field = inspectGatewayField(index, fieldName);
    if (!field) return toolFail(tool, "FIELD_NOT_FOUND", `No known Shopify root field named "${fieldName}".`);
    return toolOk(tool, `Inspected ${fieldName}.`, { action, field });
  }
  if (action === "list_fields") {
    const kind = args.kind === "MUTATION" ? "MUTATION" : "QUERY";
    const fields = listGatewayRootFields(index, kind, { prefix: args.prefix, limit: args.limit });
    return toolOk(tool, `Listed ${fields.length} ${kind.toLowerCase()} field names.`, { action, kind, fields });
  }
  if (action === "inspect_enum") {
    const typeName = String(args.typeName ?? "").trim();
    if (!typeName) return toolFail(tool, "MISSING_TYPE_NAME", "typeName is required for action=inspect_enum.");
    const result = inspectGatewayEnum(index, typeName);
    if (!result) return toolFail(tool, "TYPE_NOT_FOUND", `No known enum type "${typeName}".`);
    return toolOk(tool, `Inspected enum ${typeName}.`, { action, ...result });
  }
  if (action === "inspect_input") {
    const typeName = String(args.typeName ?? "").trim();
    if (!typeName) return toolFail(tool, "MISSING_TYPE_NAME", "typeName is required for action=inspect_input.");
    const result = inspectGatewayInputObject(index, typeName);
    if (!result) return toolFail(tool, "TYPE_NOT_FOUND", `No known input object type "${typeName}".`);
    return toolOk(tool, `Inspected input object ${typeName}.`, { action, ...result });
  }
  return toolFail(tool, "UNKNOWN_ACTION", `Unknown shopify_schema action "${action}".`);
}

/**
 * @param {any} ctx @param {string} tool @param {Record<string, any>} args
 * @param {import("./schema-index.server.js").GatewaySchemaIndex} index
 */
function handleQueryTool(ctx, tool, args, index) {
  const documentText = String(args.document ?? "").trim();
  if (!documentText) return toolFail(tool, "MISSING_DOCUMENT", "document is required.");
  const variables = asVariables(args.variables);
  const analysis = analyzeGatewayDocument({
    documentText,
    mode: GATEWAY_MODE.queryOnly,
    variables,
    schemaIndex: index,
  });
  if (!analysis.ok) {
    return toolFail(tool, analysis.code, analysis.message);
  }
  return runValidatedQuery(ctx, tool, analysis, variables);
}

/**
 * Part 12 (docs/ops/agentic-shopify-gateway-full/): a field-level ACCESS_DENIED or similar partial
 * GraphQL error must not discard `data` the response usefully returned alongside it. Uses
 * `client.requestWithClassification()` when the client supports it (the real
 * ShopifyAdminGraphqlClient does); falls back to plain `client.request()` — treated as
 * FULL_SUCCESS/GRAPHQL_FAILURE only — for simpler client shapes (test fixtures, older callers).
 * @param {any} ctx @param {string} tool @param {any} analysis @param {Record<string, unknown>} variables
 */
async function runValidatedQuery(ctx, tool, analysis, variables) {
  try {
    const result =
      typeof ctx.client.requestWithClassification === "function"
        ? await ctx.client.requestWithClassification(analysis.normalizedDocument, variables)
        : { classification: "FULL_SUCCESS", data: await ctx.client.request(analysis.normalizedDocument, variables), errors: [] };

    if (result.classification === "GRAPHQL_FAILURE") {
      const message = result.errors.map((e) => e.message).slice(0, 5).join("; ") || "Shopify rejected the document.";
      return {
        tool,
        ok: false,
        message: `${analysis.rootField} query failed: ${message}`,
        facts: {
          operation: analysis.rootField,
          document: analysis.normalizedDocument,
          variables,
          classification: result.classification,
          providerError: { code: "SHOPIFY_GRAPHQL_ERROR", message, details: result.errors.slice(0, 5) },
        },
        error: { code: "SHOPIFY_GRAPHQL_ERROR", message },
      };
    }

    const partial = result.classification !== "FULL_SUCCESS";
    return toolOk(
      tool,
      partial
        ? `${analysis.rootField} query returned partial data (${result.classification}): ${result.errors.map((e) => e.message).slice(0, 3).join("; ")}`
        : `${analysis.rootField} query executed.`,
      {
        operation: analysis.rootField,
        domain: analysis.domain,
        document: analysis.normalizedDocument,
        variables,
        classification: result.classification,
        partialErrors: partial ? result.errors : [],
        resourceIds: extractGatewayResourceIds(result.data),
        data: compactJson(result.data),
      },
    );
  } catch (error) {
    const normalized = normalizeGatewayProviderError(error);
    return {
      tool,
      ok: false,
      message: `${analysis.rootField} query failed: ${normalized.message}`,
      facts: { operation: analysis.rootField, document: analysis.normalizedDocument, variables, providerError: normalized },
      error: { code: normalized.code, message: normalized.message },
    };
  }
}

/**
 * @param {any} ctx @param {string} tool @param {Record<string, any>} args
 * @param {import("./schema-index.server.js").GatewaySchemaIndex} index
 */
function handlePrepareMutationTool(ctx, tool, args, index) {
  const documentText = String(args.document ?? "").trim();
  if (!documentText) return toolFail(tool, "MISSING_DOCUMENT", "document is required.");
  const variables = asVariables(args.variables);
  const analysis = analyzeGatewayDocument({
    documentText,
    mode: GATEWAY_MODE.mutationOnly,
    variables,
    schemaIndex: index,
  });
  if (!analysis.ok) return toolFail(tool, analysis.code, analysis.message);

  const stub = buildSyntheticGatewayStub({ analysis, apiVersion: ctx.apiVersion });
  const blastRadius = computeShopifyBlastRadius({ stub, variables });
  const preview = buildGenericShopifyOperationPreview({ stub, variables });
  const blastRadiusCap = evaluateBlastRadiusCap(blastRadius, stub.safety?.riskTier);

  return toolOk(tool, `${analysis.rootField} mutation validated and classified; not executed.`, {
    operation: analysis.rootField,
    domain: analysis.domain,
    safety: analysis.safety,
    execution: analysis.execution,
    knownInSchemaIndex: analysis.knownInSchemaIndex,
    blastRadius,
    blastRadiusWithinCap: blastRadiusCap.ok,
    preview,
    requiresExplicitConfirmation: analysis.safety.interaction === "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED",
    normalizedDocument: analysis.normalizedDocument,
  });
}

/**
 * @param {any} ctx @param {string} tool @param {Record<string, any>} args
 * @param {import("./schema-index.server.js").GatewaySchemaIndex} index
 */
async function handleExecuteMutationTool(ctx, tool, args, index) {
  const documentText = String(args.document ?? "").trim();
  if (!documentText) return toolFail(tool, "MISSING_DOCUMENT", "document is required.");
  if (typeof args.idempotencyKey !== "string" || !args.idempotencyKey.trim()) {
    return toolFail(tool, "MISSING_IDEMPOTENCY_KEY", "Shopify mutations require a stable idempotencyKey.");
  }
  const variables = asVariables(args.variables);
  const analysis = analyzeGatewayDocument({
    documentText,
    mode: GATEWAY_MODE.mutationOnly,
    variables,
    schemaIndex: index,
  });
  if (!analysis.ok) return toolFail(tool, analysis.code, analysis.message);

  const stub = buildSyntheticGatewayStub({ analysis, apiVersion: ctx.apiVersion });
  const result = /** @type {any} */ (
    await executeShopifyOperation({
      prisma: ctx.prisma,
      client: ctx.client,
      merchantId: ctx.merchantId,
      shopId: ctx.shopId,
      shopDomain: ctx.shopDomain,
      actionId: ctx.actionId ?? null,
      actionExecutionId: ctx.actionExecutionId ?? null,
      acceptedActionRevision: ctx.acceptedActionRevision ?? null,
      operation: stub.operation,
      stubOverride: stub,
      variables,
      purpose: String(args.purpose ?? ""),
      expectedEffect: String(args.expectedEffect ?? ""),
      idempotencyKey: args.idempotencyKey,
      grantedScopes: ctx.grantedScopes,
      apiVersion: ctx.apiVersion,
      logger: ctx.logger,
    })
  );

  return {
    tool,
    ok: result.ok,
    message: result.ok
      ? `${stub.operation} completed through the Shopify gateway.`
      : `${stub.operation} did not complete: ${result.status}.`,
    facts: {
      operation: stub.operation,
      domain: analysis.domain,
      status: result.status,
      gatewayDecision: result.gatewayDecision ?? null,
      userErrors: result.userErrors ?? [],
      resourceIds: result.resourceIds ?? [],
      responseSummary: result.responseSummary ?? {},
      data: compactJson(result.data),
    },
    error: result.ok
      ? null
      : { code: String(result.status ?? "SHOPIFY_OPERATION_FAILED"), message: String(result.error ?? result.gatewayDecision ?? "Shopify mutation failed.") },
  };
}

/** @param {unknown} value */
function asVariables(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {string} tool @param {string} message @param {Record<string, any>} facts */
function toolOk(tool, message, facts) {
  return { tool, ok: true, message, facts, error: null };
}

/** @param {string} tool @param {string} code @param {string} message */
function toolFail(tool, code, message) {
  return { tool, ok: false, message, facts: {}, error: { code, message } };
}

/**
 * Scans raw (pre-compaction) GraphQL response data for Shopify GIDs — used for the
 * execution/verification agents' repeated-empty-read loop guard and for observability, mirroring
 * gateway.server.js's extractResourceIds for the catalog path. Not a safety property; purely
 * informational.
 * @param {unknown} data
 */
function extractGatewayResourceIds(data) {
  const ids = new Set();
  const visit = (/** @type {unknown} */ value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "id" && typeof child === "string" && child.startsWith("gid://shopify/")) ids.add(child);
      visit(child);
    }
  };
  visit(data);
  return [...ids].sort();
}

/** @param {any[] | undefined} values */
export function publicShopifyToolResults(values) {
  return (values ?? []).slice(-16).map((row) => ({
    tool: row.tool,
    ok: row.ok,
    message: row.message,
    facts: row.facts,
    error: row.error,
    // Observability (docs/ops/recommendation-repair-loop-fairness/): preserved so a persisted
    // trace can be attributed back to the candidate/turn that produced each row without guessing
    // from array position, which the `.slice(-16)` above already makes unreliable.
    candidateId: row.candidateId ?? null,
    iteration: typeof row.iteration === "number" ? row.iteration : null,
  }));
}

/** @param {unknown} data */
function compactJson(data) {
  if (!data || typeof data !== "object") return data ?? null;
  return compactJsonInner(data, 0);
}

/** @param {unknown} value @param {number} depth @returns {unknown} */
function compactJsonInner(value, depth) {
  if (value == null) return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const limit = depth >= 3 ? 4 : 50;
    const items = value.slice(0, limit).map((item) => compactJsonInner(item, depth + 1));
    return value.length > items.length ? [...items, { omittedItems: value.length - items.length }] : items;
  }
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).slice(0, depth >= 3 ? 8 : 16);
  return Object.fromEntries(entries.map(([key, item]) => [key, compactJsonInner(item, depth + 1)]));
}
