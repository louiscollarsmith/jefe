// @ts-check

import { Type } from "@google/genai";
import { logger as baseLogger } from "../observability/logger.server.js";
import { redact } from "../observability/redact.server.js";
import {
  calculationScopeFromActionContext,
  commerceCalculationCatalogForPrompt,
  executeCommerceCalculations,
  heuristicCommerceCalculationRequests,
  shouldPlanCommerceCalculations,
} from "./commerce-calculations.server.js";

export const COMMERCE_ANALYST_CATALOG_VERSION = "commerce_analyst_v1";

const MAX_TOOL_CALLS = 6;
const MAX_ROWS_PER_CALL = 50;
const MAX_TOTAL_ROWS = 150;
const DEFAULT_TARGET_COVER_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_PROMPT_MESSAGE = 900;
const MAX_PROMPT_THREAD_MESSAGE = 600;

const ANALYST_PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    toolCalls: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, nullable: true },
          kind: { type: Type.STRING },
          entity: { type: Type.STRING, nullable: true },
          operation: { type: Type.STRING, nullable: true },
          sourceResultId: { type: Type.STRING, nullable: true },
          formula: { type: Type.STRING, nullable: true },
          outputField: { type: Type.STRING, nullable: true },
          field: { type: Type.STRING, nullable: true },
          groupBy: { type: Type.STRING, nullable: true },
          limit: { type: Type.NUMBER, nullable: true },
          request: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              id: { type: Type.STRING, nullable: true },
              kind: { type: Type.STRING, nullable: true },
              measure: { type: Type.STRING, nullable: true },
              dimensions: {
                type: Type.ARRAY,
                nullable: true,
                items: { type: Type.STRING },
              },
              filters: { type: Type.OBJECT, nullable: true },
              window: { type: Type.OBJECT, nullable: true },
              comparison: { type: Type.OBJECT, nullable: true },
              topN: { type: Type.NUMBER, nullable: true },
              horizonDays: { type: Type.NUMBER, nullable: true },
            },
          },
          filters: { type: Type.OBJECT, nullable: true },
          window: { type: Type.OBJECT, nullable: true },
          fields: {
            type: Type.ARRAY,
            nullable: true,
            items: { type: Type.STRING },
          },
          assumptions: { type: Type.OBJECT, nullable: true },
        },
      },
    },
    requests: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.OBJECT },
    },
  },
};

const ANALYST_REPLY_SCHEMA = {
  type: Type.OBJECT,
  required: ["reply"],
  properties: {
    reply: { type: Type.STRING },
    confidence: { type: Type.NUMBER, nullable: true },
  },
};

const CALCULATION_KINDS = new Set([
  "aggregate",
  "comparison",
  "breakdown",
  "ranking",
  "timeseries",
  "ratio",
  "impact_estimate",
]);

const DERIVE_OPERATIONS = new Set([
  "row_formula",
  "formula",
  "sum",
  "avg",
  "min",
  "max",
  "ceil",
  "floor",
  "round",
  "recommended_purchase_units",
  "replenishment_units",
]);

/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {{ ok: boolean; call?: AnyRecord; id?: string; error?: string }} NormalizedToolCall */

/** @type {Readonly<Record<string, { model: string; sourceTable: string; fields: string[]; defaultFields: string[]; dateField?: string }>>} */
const ENTITY_CONFIG = Object.freeze({
  products: {
    model: "product",
    sourceTable: "products",
    fields: ["id", "title", "handle", "status", "vendor", "productType", "sourceCreatedAt", "sourceUpdatedAt"],
    defaultFields: ["id", "title", "status", "vendor", "productType"],
  },
  variants: {
    model: "variant",
    sourceTable: "variants",
    fields: ["id", "productId", "sku", "title", "price", "currency", "unitCost", "sourceCreatedAt", "sourceUpdatedAt", "productTitle", "vendor", "productType"],
    defaultFields: ["id", "productId", "sku", "title", "price", "currency", "unitCost", "productTitle"],
  },
  inventory_levels: {
    model: "inventoryLevel",
    sourceTable: "inventory_levels",
    fields: ["id", "variantId", "productId", "productTitle", "sku", "variantTitle", "available", "committed", "incoming", "observedAt", "sourceUpdatedAt"],
    defaultFields: ["variantId", "productId", "productTitle", "sku", "available", "committed", "incoming", "observedAt"],
    dateField: "observedAt",
  },
  orders: {
    model: "order",
    sourceTable: "orders",
    fields: ["id", "orderName", "financialStatus", "fulfillmentStatus", "sourceName", "shippingCountry", "currency", "subtotalPrice", "totalPrice", "totalDiscount", "totalTax", "totalShipping", "processedAt"],
    defaultFields: ["id", "orderName", "financialStatus", "sourceName", "shippingCountry", "currency", "totalPrice", "totalDiscount", "processedAt"],
    dateField: "processedAt",
  },
  order_line_items: {
    model: "orderLineItem",
    sourceTable: "order_line_items",
    fields: ["id", "orderId", "productId", "variantId", "sku", "title", "quantity", "unitPrice", "totalPrice", "discount", "orderProcessedAt", "currency", "sourceName", "shippingCountry", "financialStatus"],
    defaultFields: ["orderId", "productId", "variantId", "sku", "title", "quantity", "unitPrice", "totalPrice", "discount", "orderProcessedAt", "currency"],
    dateField: "order.processedAt",
  },
  refunds: {
    model: "refund",
    sourceTable: "refunds",
    fields: ["id", "orderId", "amount", "currency", "reason", "processedAt", "sourceName", "shippingCountry"],
    defaultFields: ["id", "orderId", "amount", "currency", "reason", "processedAt"],
    dateField: "processedAt",
  },
});

/** @type {Readonly<Record<string, string>>} */
const ENTITY_ALIASES = Object.freeze({
  product: "products",
  products: "products",
  variant: "variants",
  variants: "variants",
  inventory: "inventory_levels",
  inventory_level: "inventory_levels",
  inventory_levels: "inventory_levels",
  stock: "inventory_levels",
  order: "orders",
  orders: "orders",
  line_item: "order_line_items",
  line_items: "order_line_items",
  order_line_item: "order_line_items",
  order_line_items: "order_line_items",
  refund: "refunds",
  refunds: "refunds",
});

/**
 * Answer a merchant's commerce question through a governed read-only analyst loop.
 * The LLM may plan analysis, but every read and calculation is validated and
 * executed by the app with tenant scope, row caps and redaction.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId?: string | null; shopId?: string | null; message: string; actionContext?: any; recentMessages?: Array<{ role: string; content: string }>; provider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error">; now?: Date }} input
 */
export async function answerCommerceQuestion(prisma, input) {
  if (!input.merchantId || !shouldAttemptCommerceAnalysis(input.message, input.actionContext)) {
    return { source: "commerce_analyst", reply: null, analysisPacket: null };
  }

  const log = input.logger ?? baseLogger.child({ component: "commerce-analyst" });
  const now = input.now ?? new Date();
  const toolCalls = await planCommerceAnalystToolCalls({
    message: input.message,
    actionContext: input.actionContext,
    recentMessages: input.recentMessages ?? [],
    provider: input.provider,
    logger: log,
    now,
  });

  const analysisPacket = await executeCommerceAnalystToolCalls(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionContext: input.actionContext,
    toolCalls,
    logger: log,
    now,
  });
  const fallbackReply = buildCommerceAnalystFallbackReply(input.message, analysisPacket);
  const provider = input.provider;
  if (!provider?.enabled || !provider.generateStructuredJson) {
    return { source: "fallback", reply: fallbackReply, analysisPacket };
  }

  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: buildCommerceAnalystReplySystemPrompt(),
      prompt: buildCommerceAnalystReplyPrompt({
        message: input.message,
        actionContext: input.actionContext,
        recentMessages: input.recentMessages ?? [],
        analysisPacket,
      }),
      schema: ANALYST_REPLY_SCHEMA,
      maxOutputTokens: 800,
    });
    const reply = parseReply(result.json);
    if (!reply) return { source: "fallback", reply: fallbackReply, analysisPacket };
    if (!replySatisfiesQuantitativeContract(input.message, reply, analysisPacket)) {
      return { source: "fallback", reply: fallbackReply, analysisPacket };
    }
    return { source: "llm", reply, analysisPacket };
  } catch (error) {
    log.warn("commerce analyst reply unavailable; using fallback", {
      provider: provider.provider,
      model: provider.model,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { source: "fallback", reply: fallbackReply, analysisPacket };
  }
}

/**
 * @param {string} message
 * @param {any} actionContext
 */
export function shouldAttemptCommerceAnalysis(message, actionContext = null) {
  const value = String(message ?? "");
  if (!value.trim()) return false;
  if (shouldPlanCommerceCalculations(value)) return true;
  if (/\b(how much|how many|quantity|quantit|purchase|buy|order|reorder|restock|replenish|stockout|stockouts?|velocity|run rate|forecast|estimate|calculate|should i)\b/i.test(value)) {
    return true;
  }
  if (/\b(supplier|lead time|lead times|moq|case pack|incoming|available)\b/i.test(value)) {
    return true;
  }
  return Boolean(actionContext?.actionRunId && /\b(next|do|doing|done)\b/i.test(value) && /stock|replenish|inventory/i.test(JSON.stringify(actionContext)));
}

export function commerceAnalystToolCatalogForPrompt() {
  return {
    version: COMMERCE_ANALYST_CATALOG_VERSION,
    limits: {
      maxToolCalls: MAX_TOOL_CALLS,
      maxRowsPerCall: MAX_ROWS_PER_CALL,
      maxTotalRows: MAX_TOTAL_ROWS,
    },
    tools: [
      {
        kind: "commerce_calculation",
        description: "Run tenant-scoped aggregate, ranking, timeseries, comparison, ratio or impact calculations.",
        commerceCalculationCatalog: commerceCalculationCatalogForPrompt(),
      },
      {
        kind: "fetch_rows",
        description: "Fetch bounded redacted non-PII commerce rows.",
        entities: Object.fromEntries(
          Object.entries(ENTITY_CONFIG).map(([entity, config]) => [
            entity,
            { fields: config.fields, defaultFields: config.defaultFields },
          ]),
        ),
      },
      {
        kind: "derive",
        description: "Create derived metrics from prior tool results.",
        operations: [...DERIVE_OPERATIONS],
        supportedFormulaFunctions: ["sum", "avg", "min", "max", "ceil", "floor", "round"],
      },
    ],
    defaults: {
      replenishmentTargetCoverDays: DEFAULT_TARGET_COVER_DAYS,
      replenishmentFormula: "ceil(max(0, dailyUnits * targetCoverDays - availableUnits))",
    },
    prohibited: [
      "SQL or arbitrary database access",
      "customer identities, addresses, emails, phone numbers or raw payloads",
      "credentials, tokens, sessions or secrets",
      "external writes or approval/execution claims",
    ],
  };
}

/**
 * @param {{ message: string; actionContext?: any; recentMessages?: Array<{ role: string; content: string }>; provider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error">; now?: Date }} input
 */
async function planCommerceAnalystToolCalls(input) {
  const fallback = heuristicCommerceAnalystToolCalls(input);
  const provider = input.provider;
  if (!provider?.enabled || !provider.generateStructuredJson) return fallback;
  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: buildCommerceAnalystPlannerSystemPrompt(),
      prompt: buildCommerceAnalystPlannerPrompt(input),
      schema: ANALYST_PLAN_SCHEMA,
      maxOutputTokens: 900,
    });
    const planned = parseAnalystPlan(result.json);
    return planned.length ? planned : fallback;
  } catch (error) {
    input.logger?.warn?.("commerce analyst planner unavailable; using heuristic plan", {
      provider: provider.provider,
      model: provider.model,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return fallback;
  }
}

/**
 * Execute analyst tool calls with tenant scope, row caps and redaction.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; actionContext?: any; toolCalls: AnyRecord[]; logger?: Pick<Console, "info" | "warn" | "error">; now?: Date }} input
 */
export async function executeCommerceAnalystToolCalls(prisma, input) {
  const log = input.logger ?? baseLogger.child({ component: "commerce-analyst" });
  const now = input.now ?? new Date();
  const scope = calculationScopeFromActionContext(input.actionContext);
  const assumptions = {
    targetCoverDays: DEFAULT_TARGET_COVER_DAYS,
    targetCoverDaysSource: "default_30_day_cover",
  };
  /** @type {AnyRecord[]} */
  const results = [];
  /** @type {AnyRecord[]} */
  const toolCalls = [];
  let rowsReturned = 0;

  const rawCalls = Array.isArray(input.toolCalls) ? input.toolCalls.slice(0, MAX_TOOL_CALLS) : [];
  if (!safeText(input.shopId, 120)) {
    for (const rawCall of rawCalls) {
      const id = safeId(rawCall?.id) || `tool_${toolCalls.length + 1}`;
      toolCalls.push({ id, kind: safeKind(rawCall?.kind), status: "rejected", error: "shopId is required for tenant-scoped commerce analysis." });
      results.push(rejectedResult(id, "shopId is required for tenant-scoped commerce analysis."));
    }
    log.warn("commerce analyst rejected without shop scope", {
      merchantId: input.merchantId,
      requestCount: rawCalls.length,
    });
    return analysisPacket({ now, assumptions, toolCalls, results, rowsReturned });
  }

  for (const rawCall of rawCalls) {
    const normalized = normalizeToolCall(rawCall, { scope, now, message: "", assumptions });
    if (!normalized.ok || !normalized.call) {
      const id = normalized.id || safeId(rawCall?.id) || `tool_${toolCalls.length + 1}`;
      const error = normalized.error ?? "Unsupported analyst tool request.";
      toolCalls.push({ id, kind: safeKind(rawCall?.kind), status: "rejected", error });
      results.push(rejectedResult(id, error));
      continue;
    }

    const call = normalized.call;
    if (call.kind === "commerce_calculation") {
      const packet = await executeCommerceCalculations(prisma, {
        merchantId: input.merchantId,
        shopId: safeText(input.shopId, 120),
        requests: [call.request],
        actionContext: input.actionContext,
        now,
        source: "commerce_analyst",
        logger: log,
      });
      const result = packet.results[0] ?? rejectedResult(call.id, "Calculation did not return a result.");
      results.push(sanitizeAnalystResult({ ...result, toolKind: "commerce_calculation" }));
      rowsReturned += Array.isArray(result.rows) ? result.rows.length : 0;
      toolCalls.push({
        id: call.id,
        kind: "commerce_calculation",
        status: result.ok ? "ok" : "rejected",
        measure: result.measure,
        resultId: result.id,
        rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
        sourceTables: result.sourceTables ?? [],
      });
      continue;
    }

    if (call.kind === "fetch_rows") {
      const remainingRows = Math.max(0, MAX_TOTAL_ROWS - rowsReturned);
      if (!remainingRows) {
        const error = "Total analyst row budget is exhausted.";
        toolCalls.push({ id: call.id, kind: "fetch_rows", entity: call.entity, status: "rejected", error });
        results.push(rejectedResult(call.id, error));
        continue;
      }
      const result = await executeFetchRows(prisma, {
        merchantId: input.merchantId,
        shopId: safeText(input.shopId, 120),
        call: { ...call, limit: Math.min(call.limit, remainingRows) },
        scope,
        now,
      });
      results.push(result);
      rowsReturned += result.rows.length;
      toolCalls.push({
        id: call.id,
        kind: "fetch_rows",
        entity: call.entity,
        status: result.ok ? "ok" : "rejected",
        rowCount: result.rows.length,
        sourceTables: result.sourceTables,
        fields: call.fields,
      });
      continue;
    }

    if (call.kind === "derive") {
      const result = executeDerive(call, {
        results,
        assumptions: { ...assumptions, ...(call.assumptions ?? {}) },
      });
      results.push(result);
      rowsReturned += result.rows.length;
      if (Number.isFinite(Number(call.assumptions?.targetCoverDays))) {
        assumptions.targetCoverDays = Number(call.assumptions.targetCoverDays);
        assumptions.targetCoverDaysSource = safeText(call.assumptions.targetCoverDaysSource, 120) || assumptions.targetCoverDaysSource;
      }
      toolCalls.push({
        id: call.id,
        kind: "derive",
        operation: call.operation,
        status: result.ok ? "ok" : "rejected",
        rowCount: result.rows.length,
        formula: result.formula,
        sourceResultIds: call.inputIds,
      });
    }
  }

  const packet = analysisPacket({ now, assumptions, toolCalls, results, rowsReturned });
  log.info("commerce analyst tools executed", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    toolCallCount: toolCalls.length,
    resultCount: results.length,
    okCount: results.filter((result) => result.ok).length,
    rowsReturned,
    toolKinds: uniqueStrings(toolCalls.map((call) => call.kind)),
  });
  return packet;
}

/**
 * @param {{ now: Date; assumptions: AnyRecord; toolCalls: AnyRecord[]; results: AnyRecord[]; rowsReturned: number }} input
 */
function analysisPacket(input) {
  return sanitizeRecord({
    generatedAt: input.now.toISOString(),
    source: "commerce_analyst",
    catalogVersion: COMMERCE_ANALYST_CATALOG_VERSION,
    limits: {
      maxToolCalls: MAX_TOOL_CALLS,
      maxRowsPerCall: MAX_ROWS_PER_CALL,
      maxTotalRows: MAX_TOTAL_ROWS,
    },
    assumptions: input.assumptions,
    toolCalls: input.toolCalls,
    results: input.results.filter((result) => result.ok),
    rejectedResults: input.results.filter((result) => !result.ok),
    dataQuality: {
      rowsReturned: input.rowsReturned,
      okResultCount: input.results.filter((result) => result.ok).length,
      rejectedResultCount: input.results.filter((result) => !result.ok).length,
    },
    caveats: [
      "Read-only analysis over available synced commerce data.",
      "No customer identity fields, raw payloads, credentials or external writes are available to the analyst.",
    ],
  });
}

/** @param {{ message: string; actionContext?: any; now?: Date }} input */
function heuristicCommerceAnalystToolCalls(input) {
  const targetCover = targetCoverDaysFromMessage(input.message, input.now ?? new Date());
  if (isReplenishmentQuantityQuestion(input.message)) {
    return [
      {
        id: "current_move_stock_cover",
        kind: "commerce_calculation",
        request: {
          id: "current_move_stock_cover",
          kind: "ranking",
          measure: "stock_cover_days",
          dimensions: ["product"],
          filters: { scope: "current_move" },
          window: { days: DEFAULT_WINDOW_DAYS, label: `trailing_${DEFAULT_WINDOW_DAYS}d` },
          topN: 12,
        },
      },
      {
        id: "recommended_purchase_units",
        kind: "derive",
        operation: "recommended_purchase_units",
        sourceResultId: "current_move_stock_cover",
        outputField: "recommendedUnits",
        formula: "ceil(max(0, dailyUnits * targetCoverDays - availableUnits))",
        assumptions: {
          targetCoverDays: targetCover.days,
          targetCoverDaysSource: targetCover.source,
        },
      },
    ];
  }

  const requests = heuristicCommerceCalculationRequests({
    message: input.message,
    actionContext: input.actionContext,
  });
  return requests.map((request) => ({
    id: safeId(request.id) || `${request.kind}_${request.measure}`,
    kind: "commerce_calculation",
    request,
  }));
}

function buildCommerceAnalystPlannerSystemPrompt() {
  return [
    "You plan read-only commerce analysis for Jefe action chat.",
    "Return at most 6 toolCalls. Use only the supplied commerceAnalystToolCatalog.",
    "The app executes every request; never request SQL, arbitrary database access, customer data, credentials, raw payloads or external writes.",
    "Prefer aggregated calculations first. Fetch rows only when bounded non-PII commerce rows are needed to answer the merchant.",
    "Use filters.scope=current_move when the question is about this recommendation/action.",
    "For purchase, order, reorder, restock or replenishment quantities, request stock_cover_days by product for scope=current_move, then derive recommended_purchase_units with formula ceil(max(0, dailyUnits * targetCoverDays - availableUnits)).",
    "If data is enough for a quantitative recommendation, plan the calculation instead of saying the recommendation is unavailable.",
  ].join("\n");
}

/** @param {{ message: string; actionContext?: any; recentMessages?: Array<{ role: string; content: string }>; now?: Date }} input */
function buildCommerceAnalystPlannerPrompt(input) {
  return JSON.stringify({
    latestMerchantMessage: safePromptText(input.message, MAX_PROMPT_MESSAGE),
    recentThread: safeRecentThread(input.recentMessages ?? []),
    currentMoveScope: calculationScopeFromActionContext(input.actionContext),
    contextSummary: compactContextForPlanner(input.actionContext),
    commerceAnalystToolCatalog: commerceAnalystToolCatalogForPrompt(),
    responseContract: {
      toolCalls: "Array of allowed analyst tool calls. Empty array only when no commerce data or calculation can help.",
    },
  });
}

function buildCommerceAnalystReplySystemPrompt() {
  return [
    "You are Jefe, an AI eCommerce manager, answering inside a chat scoped to one proposed action.",
    "Use only the supplied action context, recent thread and commerce analyst packet.",
    "When the packet contains enough data for a quantitative recommendation, give the recommendation and the numbers behind it. Do not say you lack a recommendation in that case.",
    "If assumptions were needed, state them plainly and keep the answer opinionated.",
    "Do not invent supplier facts, case packs, MOQs, customer data, product names, dates, external writes or standing business rules.",
    "Keep replies concise, natural and specific. No markdown tables.",
  ].join("\n");
}

/**
 * @param {{ message: string; actionContext?: any; recentMessages?: Array<{ role: string; content: string }>; analysisPacket: AnyRecord }} input
 */
function buildCommerceAnalystReplyPrompt(input) {
  return JSON.stringify({
    latestMerchantMessage: safePromptText(input.message, MAX_PROMPT_MESSAGE),
    planEvidenceAtRecommendationTime: input.actionContext?.planEvidenceAtRecommendationTime ?? null,
    currentSystemContext: input.actionContext?.currentSystemContext ?? null,
    retrieval: input.actionContext?.retrieval ?? null,
    recentThread: safeRecentThread(input.recentMessages ?? []),
    analysisPacket: input.analysisPacket,
    responseContract: {
      reply: "Merchant-facing answer. Include quantitative recommendation when analysisPacket supports one. No markdown tables.",
    },
  });
}

/** @param {unknown} raw */
function parseAnalystPlan(raw) {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  const record = asRecord(value) ?? {};
  const calls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const legacyRequests = Array.isArray(record.requests)
    ? record.requests.map((request) => ({
        id: safeId(request?.id) || `${safeText(request?.kind, 80)}_${safeText(request?.measure, 80)}`,
        kind: "commerce_calculation",
        request,
      }))
    : [];
  return [...calls, ...legacyRequests]
    .filter((call) => call && typeof call === "object")
    .slice(0, MAX_TOOL_CALLS);
}

/**
 * @param {unknown} raw
 * @param {{ scope: ReturnType<typeof calculationScopeFromActionContext>; now: Date; message: string; assumptions: AnyRecord }} context
 * @returns {NormalizedToolCall}
 */
function normalizeToolCall(raw, context) {
  const record = asRecord(raw) ?? {};
  const rawKind = safeText(record.kind, 80);
  const id = safeId(record.id) || `tool_${Math.random().toString(36).slice(2, 8)}`;
  if (containsUnsafeRequest(record)) {
    return { ok: false, id, error: "Unsupported analyst tool request." };
  }
  if (CALCULATION_KINDS.has(rawKind)) {
    return normalizeCommerceCalculationCall({ id, kind: "commerce_calculation", request: record });
  }
  if (rawKind === "commerce_calculation" || rawKind === "calculation") {
    return normalizeCommerceCalculationCall(record);
  }
  if (rawKind === "fetch_rows" || rawKind === "row_fetch" || rawKind === "rows") {
    return normalizeFetchRowsCall(record, context);
  }
  if (rawKind === "derive" || rawKind === "derived_calculation") {
    return normalizeDeriveCall(record, context);
  }
  return { ok: false, id, error: "Unsupported analyst tool kind." };
}

/** @param {AnyRecord} record */
function containsUnsafeRequest(record) {
  const text = JSON.stringify(record).slice(0, 5000);
  if (/"?(customer|customers|customerIdentity|customer_identities|session|sessions|rawPayload|raw_payload|token|secret|email|phone|address)"?\s*:/i.test(text)) {
    return true;
  }
  if (/\b(select|insert|update|delete|drop|alter|truncate)\s+.+\b(from|into|table|where)\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * @param {AnyRecord} record
 * @returns {NormalizedToolCall}
 */
function normalizeCommerceCalculationCall(record) {
  const request = asRecord(record.request ?? record.calculation ?? record.commerceCalculation) ?? record;
  const id = safeId(record.id ?? request.id) || `${safeText(request.kind, 80)}_${safeText(request.measure, 80)}`;
  return {
    ok: true,
    call: {
      id,
      kind: "commerce_calculation",
      request: {
        ...request,
        id,
      },
    },
  };
}

/**
 * @param {AnyRecord} record
 * @param {{ scope: ReturnType<typeof calculationScopeFromActionContext>; now: Date }} context
 * @returns {NormalizedToolCall}
 */
function normalizeFetchRowsCall(record, context) {
  const entity = normalizeEntity(record.entity ?? record.table ?? record.model);
  const id = safeId(record.id) || `fetch_${entity || "rows"}`;
  if (!entity || !ENTITY_CONFIG[entity]) {
    return { ok: false, id, error: "Unsupported row entity." };
  }
  const config = ENTITY_CONFIG[entity];
  const requestedFields = Array.isArray(record.fields) ? record.fields.map((field) => safeText(field, 80)) : [];
  const fields = uniqueStrings(
    (requestedFields.length ? requestedFields : config.defaultFields)
      .filter((field) => config.fields.includes(field)),
  );
  if (!fields.length && requestedFields.length) {
    return { ok: false, id, error: "No supported row fields were requested." };
  }
  return {
    ok: true,
    call: {
      id,
      kind: "fetch_rows",
      entity,
      fields: fields.length ? fields : config.defaultFields,
      filters: normalizeAnalystFilters(record.filters, context.scope),
      window: normalizeWindow(record.window, context.now),
      limit: clampInteger(record.limit, 1, MAX_ROWS_PER_CALL, MAX_ROWS_PER_CALL),
    },
  };
}

/**
 * @param {AnyRecord} record
 * @param {{ assumptions: AnyRecord }} context
 * @returns {NormalizedToolCall}
 */
function normalizeDeriveCall(record, context) {
  const operation = normalizeDeriveOperation(record.operation);
  const id = safeId(record.id) || operation;
  if (!DERIVE_OPERATIONS.has(operation)) {
    return { ok: false, id, error: "Unsupported derived calculation." };
  }
  const assumptions = sanitizeRecord({
    ...(asRecord(record.assumptions) ?? {}),
  });
  if (
    operation === "recommended_purchase_units" ||
    operation === "replenishment_units"
  ) {
    assumptions.targetCoverDays = clampInteger(
      assumptions.targetCoverDays ?? context.assumptions.targetCoverDays,
      1,
      365,
      DEFAULT_TARGET_COVER_DAYS,
    );
    assumptions.targetCoverDaysSource =
      safeText(assumptions.targetCoverDaysSource, 120) ||
      context.assumptions.targetCoverDaysSource ||
      "default_30_day_cover";
  }
  return {
    ok: true,
    call: {
      id,
      kind: "derive",
      operation,
      sourceResultId: safeId(record.sourceResultId ?? record.inputId),
      inputIds: uniqueStrings([
        ...(Array.isArray(record.inputIds) ? record.inputIds.map(safeId) : []),
        safeId(record.sourceResultId ?? record.inputId),
      ]).filter(Boolean),
      formula: safeFormula(record.formula) || formulaForDeriveOperation(operation),
      outputField: safeId(record.outputField) || outputFieldForDeriveOperation(operation),
      field: safeId(record.field) || "value",
      groupBy: safeId(record.groupBy),
      assumptions,
    },
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; call: AnyRecord; scope: ReturnType<typeof calculationScopeFromActionContext>; now: Date }} input
 */
async function executeFetchRows(prisma, input) {
  const config = ENTITY_CONFIG[input.call.entity];
  const client = /** @type {AnyRecord} */ (prisma);
  const model = client?.[config.model];
  if (!model?.findMany) return rejectedResult(input.call.id, "Commerce row source is unavailable.");
  const rows = await model.findMany({
    where: whereForEntity(input.call.entity, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      filters: input.call.filters,
      window: input.call.window,
    }),
    select: selectForEntity(input.call.entity),
    orderBy: orderByForEntity(input.call.entity),
    take: input.call.limit,
  });
  const shapedRows = /** @type {AnyRecord[]} */ (rows)
    .map((/** @type {AnyRecord} */ row) => shapeEntityRow(input.call.entity, row, input.call.fields))
    .map((/** @type {AnyRecord} */ row) => sanitizeRow(row))
    .slice(0, input.call.limit);
  return {
    id: input.call.id,
    ok: true,
    toolKind: "fetch_rows",
    entity: input.call.entity,
    rows: shapedRows,
    totals: { rowCount: shapedRows.length },
    formula: `bounded redacted ${input.call.entity} row fetch`,
    sourceTables: [config.sourceTable],
    dataQuality: {
      rowCount: shapedRows.length,
      requestedLimit: input.call.limit,
      fields: input.call.fields,
    },
    caveats: shapedRows.length === input.call.limit ? ["Rows were capped by the analyst row limit."] : [],
    catalogVersion: COMMERCE_ANALYST_CATALOG_VERSION,
  };
}

/**
 * @param {string} entity
 * @param {{ merchantId: string; shopId: string; filters: AnyRecord; window: AnyRecord }} input
 */
function whereForEntity(entity, input) {
  /** @type {AnyRecord} */
  const where = { merchantId: input.merchantId, shopId: input.shopId };
  const productIds = input.filters.productIds ?? [];
  const variantIds = input.filters.variantIds ?? [];
  const processedAt = dateWhere(input.window);
  if (entity === "products") {
    if (productIds.length) where.id = { in: productIds };
    if (input.filters.vendor) where.vendor = input.filters.vendor;
    if (input.filters.productType) where.productType = input.filters.productType;
    if (input.filters.statuses?.length) where.status = { in: input.filters.statuses };
    return where;
  }
  if (entity === "variants") {
    if (variantIds.length) where.id = { in: variantIds };
    if (productIds.length) where.productId = { in: productIds };
    if (input.filters.sku) where.sku = input.filters.sku;
    if (input.filters.vendor || input.filters.productType) {
      where.product = {};
      if (input.filters.vendor) where.product.vendor = input.filters.vendor;
      if (input.filters.productType) where.product.productType = input.filters.productType;
    }
    return where;
  }
  if (entity === "inventory_levels") {
    if (variantIds.length) where.variantId = { in: variantIds };
    if (productIds.length || input.filters.sku || input.filters.vendor || input.filters.productType) {
      where.variant = {};
      if (productIds.length) where.variant.productId = { in: productIds };
      if (input.filters.sku) where.variant.sku = input.filters.sku;
      if (input.filters.vendor || input.filters.productType) {
        where.variant.product = {};
        if (input.filters.vendor) where.variant.product.vendor = input.filters.vendor;
        if (input.filters.productType) where.variant.product.productType = input.filters.productType;
      }
    }
    if (processedAt) where.observedAt = processedAt;
    return where;
  }
  if (entity === "orders") {
    if (processedAt) where.processedAt = processedAt;
    applyOrderFilters(where, input.filters);
    return where;
  }
  if (entity === "order_line_items") {
    if (productIds.length) where.productId = { in: productIds };
    if (variantIds.length) where.variantId = { in: variantIds };
    if (input.filters.sku) where.sku = input.filters.sku;
    /** @type {AnyRecord} */
    const order = {};
    if (processedAt) order.processedAt = processedAt;
    applyOrderFilters(order, input.filters);
    if (Object.keys(order).length) where.order = order;
    return where;
  }
  if (entity === "refunds") {
    if (processedAt) where.processedAt = processedAt;
    /** @type {AnyRecord} */
    const order = {};
    applyOrderFilters(order, input.filters);
    if (Object.keys(order).length) where.order = order;
    return where;
  }
  return where;
}

/** @param {AnyRecord} where @param {AnyRecord} filters */
function applyOrderFilters(where, filters) {
  if (filters.channel) where.sourceName = filters.channel;
  if (filters.country) where.shippingCountry = filters.country;
  if (filters.statuses?.length) where.financialStatus = { in: filters.statuses };
}

/** @param {string} entity */
function selectForEntity(entity) {
  if (entity === "products") {
    return { id: true, title: true, handle: true, status: true, vendor: true, productType: true, sourceCreatedAt: true, sourceUpdatedAt: true };
  }
  if (entity === "variants") {
    return {
      id: true,
      productId: true,
      sku: true,
      title: true,
      price: true,
      currency: true,
      unitCost: true,
      sourceCreatedAt: true,
      sourceUpdatedAt: true,
      product: { select: { title: true, vendor: true, productType: true } },
    };
  }
  if (entity === "inventory_levels") {
    return {
      id: true,
      variantId: true,
      available: true,
      committed: true,
      incoming: true,
      observedAt: true,
      sourceUpdatedAt: true,
      variant: {
        select: {
          id: true,
          productId: true,
          sku: true,
          title: true,
          product: { select: { id: true, title: true, vendor: true, productType: true } },
        },
      },
    };
  }
  if (entity === "orders") {
    return {
      id: true,
      orderName: true,
      financialStatus: true,
      fulfillmentStatus: true,
      sourceName: true,
      shippingCountry: true,
      currency: true,
      subtotalPrice: true,
      totalPrice: true,
      totalDiscount: true,
      totalTax: true,
      totalShipping: true,
      processedAt: true,
    };
  }
  if (entity === "order_line_items") {
    return {
      id: true,
      orderId: true,
      productId: true,
      variantId: true,
      sku: true,
      title: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      discount: true,
      order: {
        select: {
          processedAt: true,
          currency: true,
          sourceName: true,
          shippingCountry: true,
          financialStatus: true,
        },
      },
    };
  }
  return {
    id: true,
    orderId: true,
    amount: true,
    currency: true,
    reason: true,
    processedAt: true,
    order: { select: { sourceName: true, shippingCountry: true } },
  };
}

/** @param {string} entity */
function orderByForEntity(entity) {
  if (entity === "products" || entity === "variants") return { updatedAt: "desc" };
  if (entity === "inventory_levels") return { observedAt: "desc" };
  return { processedAt: "desc" };
}

/**
 * @param {string} entity
 * @param {AnyRecord} row
 * @param {string[]} fields
 */
function shapeEntityRow(entity, row, fields) {
  const full = flattenEntityRow(entity, row);
  return Object.fromEntries(fields.map((field) => [field, full[field]]).filter(([, value]) => value !== undefined));
}

/** @param {string} entity @param {AnyRecord} row */
function flattenEntityRow(entity, row) {
  if (entity === "variants") {
    return {
      ...row,
      productTitle: row.product?.title,
      vendor: row.product?.vendor,
      productType: row.product?.productType,
      product: undefined,
    };
  }
  if (entity === "inventory_levels") {
    return {
      ...row,
      productId: row.variant?.productId,
      productTitle: row.variant?.product?.title,
      sku: row.variant?.sku,
      variantTitle: row.variant?.title,
      variant: undefined,
    };
  }
  if (entity === "order_line_items") {
    return {
      ...row,
      orderProcessedAt: row.order?.processedAt,
      currency: row.order?.currency,
      sourceName: row.order?.sourceName,
      shippingCountry: row.order?.shippingCountry,
      financialStatus: row.order?.financialStatus,
      order: undefined,
    };
  }
  if (entity === "refunds") {
    return {
      ...row,
      sourceName: row.order?.sourceName,
      shippingCountry: row.order?.shippingCountry,
      order: undefined,
    };
  }
  return row;
}

/**
 * @param {AnyRecord} call
 * @param {{ results: AnyRecord[]; assumptions: AnyRecord }} context
 */
function executeDerive(call, context) {
  const inputIds = call.inputIds.length ? call.inputIds : [call.sourceResultId].filter(Boolean);
  const sourceResults = inputIds
    .map((/** @type {string} */ id) => context.results.find((/** @type {AnyRecord} */ result) => result.id === id))
    .filter(Boolean);
  const source = sourceResults[0];
  if (!source) return rejectedResult(call.id, "Derived calculation source result was not available.");
  const sourceRows = Array.isArray(source.rows) ? source.rows : [];
  const operation = call.operation === "recommended_purchase_units" || call.operation === "replenishment_units"
    ? "row_formula"
    : call.operation;
  if (operation === "row_formula" || operation === "formula") {
    return executeRowFormula(call, source, sourceRows, context.assumptions);
  }
  if (["sum", "avg", "min", "max", "ceil", "floor", "round"].includes(operation)) {
    return executeAggregateDerive(call, source, sourceRows, operation);
  }
  return rejectedResult(call.id, "Unsupported derived calculation.");
}

/**
 * @param {AnyRecord} call
 * @param {AnyRecord} source
 * @param {AnyRecord[]} rows
 * @param {AnyRecord} assumptions
 */
function executeRowFormula(call, source, rows, assumptions) {
  const formula = call.formula || "value";
  const outputField = call.outputField || "value";
  /** @type {AnyRecord[]} */
  const outputRows = [];
  /** @type {string[]} */
  const caveats = [];
  for (const row of rows) {
    try {
      const variables = numericVariables(row, assumptions);
      const value = Math.max(0, evaluateNumericExpression(formula, variables));
      const label = safeText(row.title ?? row.label ?? Object.values(row.dimensions ?? {}).join(" / "), 180);
      outputRows.push(sanitizeRow({
        productId: row.productId ?? row.dimensions?.product ?? null,
        title: row.title ?? label,
        label,
        [outputField]: round(value, 0),
        value: round(value, 0),
        dailyUnits: nullableNumber(row.dailyUnits),
        availableUnits: nullableNumber(row.availableUnits),
        targetCoverDays: nullableNumber(assumptions.targetCoverDays),
      }));
    } catch {
      caveats.push("One row could not be evaluated by the derived formula.");
    }
  }
  return {
    id: call.id,
    ok: true,
    toolKind: "derive",
    operation: call.operation,
    inputResultIds: [source.id],
    rows: outputRows,
    totals: {
      value: round(sum(outputRows.map((row) => number(row.value))), 0),
      rowCount: outputRows.length,
    },
    formula,
    sourceTables: source.sourceTables ?? [],
    assumptions: sanitizeRecord(assumptions),
    dataQuality: {
      sourceRowCount: rows.length,
      rowCount: outputRows.length,
    },
    caveats: [
      ...caveats,
      ...(isRecommendedPurchaseOperation(call.operation)
        ? ["MOQ, case pack, supplier lead time and confirmed incoming quantity were not available unless separately stated by the merchant."]
        : []),
    ],
    catalogVersion: COMMERCE_ANALYST_CATALOG_VERSION,
  };
}

/**
 * @param {AnyRecord} call
 * @param {AnyRecord} source
 * @param {AnyRecord[]} rows
 * @param {string} operation
 */
function executeAggregateDerive(call, source, rows, operation) {
  const field = call.field || "value";
  const groups = groupRows(rows, call.groupBy);
  const outputRows = [...groups.entries()].map(([label, groupRowsValue]) => {
    const values = groupRowsValue.map((/** @type {AnyRecord} */ row) => number(row[field]));
    const value = aggregateValues(values, operation);
    return sanitizeRow({
      label,
      [field]: round(value),
      value: round(value),
      rowCount: groupRowsValue.length,
    });
  });
  return {
    id: call.id,
    ok: true,
    toolKind: "derive",
    operation,
    inputResultIds: [source.id],
    rows: outputRows,
    totals: {
      value: round(aggregateValues(outputRows.map((row) => number(row.value)), operation)),
      rowCount: outputRows.length,
    },
    formula: `${operation}(${field})${call.groupBy ? ` grouped by ${call.groupBy}` : ""}`,
    sourceTables: source.sourceTables ?? [],
    dataQuality: { sourceRowCount: rows.length, rowCount: outputRows.length },
    caveats: [],
    catalogVersion: COMMERCE_ANALYST_CATALOG_VERSION,
  };
}

/** @param {AnyRecord[]} rows @param {string} groupBy */
function groupRows(rows, groupBy) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupBy
      ? safeText(row[groupBy] ?? row.dimensions?.[groupBy] ?? row.label, 160) || "unknown"
      : "all";
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return groups;
}

/** @param {number[]} values @param {string} operation */
function aggregateValues(values, operation) {
  if (!values.length) return 0;
  if (operation === "avg") return sum(values) / values.length;
  if (operation === "min") return Math.min(...values);
  if (operation === "max") return Math.max(...values);
  if (operation === "ceil") return Math.ceil(values[0]);
  if (operation === "floor") return Math.floor(values[0]);
  if (operation === "round") return Math.round(values[0]);
  return sum(values);
}

/** @param {string} operation */
function isRecommendedPurchaseOperation(operation) {
  return operation === "recommended_purchase_units" || operation === "replenishment_units";
}

/** @param {string} operation */
function formulaForDeriveOperation(operation) {
  if (isRecommendedPurchaseOperation(operation)) {
    return "ceil(max(0, dailyUnits * targetCoverDays - availableUnits))";
  }
  return "value";
}

/** @param {string} operation */
function outputFieldForDeriveOperation(operation) {
  if (isRecommendedPurchaseOperation(operation)) return "recommendedUnits";
  return "value";
}

/** @param {unknown} operation */
function normalizeDeriveOperation(operation) {
  const value = safeText(operation, 80);
  if (value === "average") return "avg";
  if (value === "recommended_order_units") return "recommended_purchase_units";
  return value;
}

/** @param {string} message */
function isReplenishmentQuantityQuestion(message) {
  return /\b(how much|how many|quantity|quantities|units?|purchase|buy|order|reorder|restock|replenish)\b/i.test(String(message ?? ""));
}

/** @param {string} message @param {Date} now */
function targetCoverDaysFromMessage(message, now) {
  const value = String(message ?? "");
  const explicitDays = value.match(/\b(\d{1,3})\s*(day|days|d)\b/i);
  if (explicitDays) return { days: clampInteger(explicitDays[1], 1, 365, DEFAULT_TARGET_COVER_DAYS), source: "merchant_requested_days" };
  const explicitWeeks = value.match(/\b(\d{1,2})\s*(week|weeks|w)\b/i);
  if (explicitWeeks) return { days: clampInteger(Number(explicitWeeks[1]) * 7, 1, 365, DEFAULT_TARGET_COVER_DAYS), source: "merchant_requested_weeks" };
  const relative = daysUntilNamedDate(value, now);
  if (relative !== null && /\b(until|by|before|through|bridge)\b/i.test(value)) {
    return { days: relative, source: "merchant_requested_named_date" };
  }
  return { days: DEFAULT_TARGET_COVER_DAYS, source: "default_30_day_cover" };
}

/** @param {string} message @param {Date} now */
function daysUntilNamedDate(message, now) {
  const normalized = message.toLowerCase();
  if (/\btomorrow\b/.test(normalized)) return 1;
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const targetIndex = weekdays.findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(message));
  if (targetIndex < 0) return null;
  const current = now.getDay();
  const delta = (targetIndex - current + 7) % 7;
  return Math.max(delta || 7, 1);
}

/** @param {string} message @param {AnyRecord} packet */
function buildCommerceAnalystFallbackReply(message, packet) {
  const purchase = recommendedPurchaseResult(packet);
  if (purchase) return replenishmentReply(purchase);
  const lines = calculationLines(packet);
  if (lines.length) {
    return `Here is what I can calculate from Jefe's current commerce data:\n\n${lines.map((line) => `- ${line}`).join("\n")}`;
  }
  if (packet.rejectedResults?.length && shouldAttemptCommerceAnalysis(message)) {
    return "I could not run a safe commerce calculation for that exact question yet. I can still use the action context above, but I will not guess missing numbers.";
  }
  return null;
}

/** @param {AnyRecord} packet */
function recommendedPurchaseResult(packet) {
  return packet?.results?.find((/** @type {AnyRecord} */ result) =>
    result.toolKind === "derive" &&
    (result.operation === "recommended_purchase_units" || result.operation === "replenishment_units") &&
    Array.isArray(result.rows) &&
    result.rows.length,
  );
}

/** @param {AnyRecord} result */
function replenishmentReply(result) {
  const rows = result.rows.filter((/** @type {AnyRecord} */ row) => Number.isFinite(Number(row.recommendedUnits ?? row.value)));
  if (!rows.length) return null;
  const unitLines = rows.map((/** @type {AnyRecord} */ row) => {
    const label = safeText(row.title ?? row.label, 160) || "the product";
    const units = Math.max(0, Math.ceil(number(row.recommendedUnits ?? row.value)));
    return `${units} unit${units === 1 ? "" : "s"} of ${label}`;
  });
  const targetCoverDays = number(result.assumptions?.targetCoverDays) || DEFAULT_TARGET_COVER_DAYS;
  const caveat = "I cannot see MOQ, case pack, supplier lead time or confirmed incoming quantity yet, so adjust upward if your supplier requires pack multiples.";
  return [
    `I would purchase ${formatList(unitLines)}.`,
    `That uses a ${targetCoverDays}-day cover target: ceil(max(0, daily units x ${targetCoverDays} - available units)).`,
    caveat,
  ].join("\n\n");
}


/** @param {AnyRecord} packet */
function calculationLines(packet) {
  const lines = [];
  for (const result of Array.isArray(packet?.results) ? packet.results.slice(0, 3) : []) {
    const value = result.totals?.atRiskRevenue ?? result.totals?.value;
    const currency = result.currency ? `${result.currency} ` : "";
    if (Number.isFinite(Number(value))) {
      lines.push(`${labelForResult(result)}: ${currency}${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    }
    for (const row of Array.isArray(result.rows) ? result.rows.slice(0, 5) : []) {
      if (!Number.isFinite(Number(row.value))) continue;
      const label = row.title || row.label || Object.values(row.dimensions ?? {}).join(" / ");
      if (label) lines.push(`${label}: ${currency}${Number(row.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    }
  }
  return uniqueStrings(lines).slice(0, 8);
}

/** @param {AnyRecord} result */
function labelForResult(result) {
  if (result.measure === "stock_cover_days") return "Stock cover";
  if (result.measure === "line_revenue" || result.measure === "revenue") return "Revenue";
  if (result.measure === "units_sold") return "Units sold";
  if (result.measure === "gross_margin") return "Gross margin";
  if (result.measure === "average_order_value") return "Average order value";
  return safeText(result.measure ?? result.operation, 120) || "Calculation";
}

/** @param {string} message @param {string} reply @param {AnyRecord} packet */
function replySatisfiesQuantitativeContract(message, reply, packet) {
  if (!isReplenishmentQuantityQuestion(message) || !recommendedPurchaseResult(packet)) return true;
  if (!/\d/.test(reply)) return false;
  return !/\b(do not have|don't have|cannot recommend|can't recommend|no specific|not available|missing)\b/i.test(reply);
}

/**
 * @param {AnyRecord} row
 * @param {AnyRecord} assumptions
 */
function numericVariables(row, assumptions) {
  /** @type {AnyRecord} */
  const variables = {};
  for (const [key, value] of Object.entries({
    ...(asRecord(row.dimensions) ?? {}),
    ...row,
    ...(asRecord(assumptions) ?? {}),
  })) {
    const parsed = nullableNumber(value);
    if (parsed !== null) variables[key] = parsed;
  }
  return variables;
}

/** @param {string} expression @param {AnyRecord} variables */
function evaluateNumericExpression(expression, variables) {
  const tokens = tokenizeExpression(expression);
  let index = 0;

  /** @returns {{ type: string; value: string } | null} */
  function peek() {
    return tokens[index] ?? null;
  }

  /**
   * @param {string | null} [expected]
   * @returns {{ type: string; value: string }}
   */
  function consume(expected = null) {
    const token = tokens[index];
    if (!token || (expected && token.value !== expected)) throw new Error("Invalid formula.");
    index += 1;
    return token;
  }

  /** @returns {number} */
  function parseExpression() {
    let value = parseTerm();
    while (peek()?.value === "+" || peek()?.value === "-") {
      const operator = consume().value;
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  /** @returns {number} */
  function parseTerm() {
    let value = parseUnary();
    while (peek()?.value === "*" || peek()?.value === "/") {
      const operator = consume().value;
      const right = parseUnary();
      value = operator === "*" ? value * right : right === 0 ? 0 : value / right;
    }
    return value;
  }

  /** @returns {number} */
  function parseUnary() {
    if (peek()?.value === "-") {
      consume("-");
      return -parseUnary();
    }
    return parsePrimary();
  }

  /** @returns {number} */
  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error("Invalid formula.");
    if (token.type === "number") {
      consume();
      return Number(token.value);
    }
    if (token.type === "identifier") {
      const name = consume().value;
      if (peek()?.value === "(") {
        consume("(");
        /** @type {number[]} */
        const args = [];
        if (peek()?.value !== ")") {
          let readingArgs = true;
          while (readingArgs) {
            args.push(parseExpression());
            if (peek()?.value !== ",") {
              readingArgs = false;
              continue;
            }
            consume(",");
          }
        }
        consume(")");
        return evaluateFunction(name, args);
      }
      return number(variables[name]);
    }
    if (token.value === "(") {
      consume("(");
      const value = parseExpression();
      consume(")");
      return value;
    }
    throw new Error("Invalid formula.");
  }

  const value = parseExpression();
  if (index !== tokens.length) throw new Error("Invalid formula.");
  return Number.isFinite(value) ? value : 0;
}

/** @param {string} name @param {number[]} args */
function evaluateFunction(name, args) {
  if (name === "max") return Math.max(...args);
  if (name === "min") return Math.min(...args);
  if (name === "ceil") return Math.ceil(args[0] ?? 0);
  if (name === "floor") return Math.floor(args[0] ?? 0);
  if (name === "round") return Math.round(args[0] ?? 0);
  if (name === "sum") return sum(args);
  if (name === "avg") return args.length ? sum(args) / args.length : 0;
  throw new Error("Unsupported formula function.");
}

/** @param {string} expression */
function tokenizeExpression(expression) {
  const source = safeFormula(expression);
  const tokens = [];
  const pattern = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/,])\s*/g;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match || match.index !== index) throw new Error("Invalid formula.");
    const value = match[1];
    tokens.push({
      type: /^\d/.test(value) ? "number" : /^[A-Za-z_]/.test(value) ? "identifier" : "operator",
      value,
    });
    index = pattern.lastIndex;
  }
  return tokens;
}

/**
 * @param {unknown} raw
 * @param {ReturnType<typeof calculationScopeFromActionContext>} scope
 */
function normalizeAnalystFilters(raw, scope) {
  const record = asRecord(raw) ?? {};
  const useScope = record.scope === "current_move" || record.useActionScope === true;
  const scopedProductIds = useScope ? scope.productIds : [];
  const scopedVariantIds = useScope ? scope.variantIds : [];
  return {
    scope: useScope ? "current_move" : null,
    productIds: uniqueStrings([
      ...scopedProductIds,
      ...safeIdsFromModel(record.productIds, scopedProductIds),
    ]).slice(0, MAX_ROWS_PER_CALL),
    variantIds: uniqueStrings([
      ...scopedVariantIds,
      ...safeIdsFromModel(record.variantIds, scopedVariantIds),
    ]).slice(0, MAX_ROWS_PER_CALL),
    vendor: safeText(record.vendor, 120),
    productType: safeText(record.productType ?? record.product_type, 120),
    sku: safeText(record.sku, 120),
    channel: safeText(record.channel ?? record.sourceName, 120),
    country: safeText(record.country ?? record.shippingCountry, 120),
    statuses: uniqueStrings(Array.isArray(record.statuses) ? record.statuses.map((status) => safeText(status, 80)) : []).slice(0, 8),
  };
}

/**
 * @param {unknown} value
 * @param {string[]} scopedIds
 */
function safeIdsFromModel(value, scopedIds) {
  if (!Array.isArray(value)) return [];
  const scoped = new Set(scopedIds);
  return value
    .map((item) => safeText(item, 120))
    .filter((item) => item && (isUuid(item) || scoped.has(item)));
}

/** @param {unknown} value */
function normalizeEntity(value) {
  const key = safeText(value, 80);
  return ENTITY_ALIASES[key] ?? "";
}

/** @param {unknown} window @param {Date} now */
function normalizeWindow(window, now) {
  const record = asRecord(window) ?? {};
  const days = clampInteger(record.days, 1, 365, DEFAULT_WINDOW_DAYS);
  const from = parseDate(record.from) ?? new Date(now.getTime() - days * 86400000);
  const to = parseDate(record.to) ?? now;
  return {
    from,
    to,
    days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000)),
    label: safeText(record.label, 80) || `trailing_${days}d`,
  };
}

/** @param {AnyRecord} window */
function dateWhere(window) {
  const output = {};
  if (window?.from) output.gte = window.from;
  if (window?.to) output.lte = window.to;
  return Object.keys(output).length ? output : null;
}

/** @param {AnyRecord} actionContext */
function compactContextForPlanner(actionContext) {
  return allContextBlocks(actionContext).slice(0, 12).map((block) => ({
    kind: block?.kind,
    source: block?.source,
    key: block?.data?.key ?? null,
    title: block?.data?.title ?? null,
    summary: block?.data?.summary ?? null,
    itemCount: Array.isArray(block?.data?.items) ? block.data.items.length : null,
  }));
}

/** @param {AnyRecord} actionContext */
function allContextBlocks(actionContext) {
  return [
    ...(Array.isArray(actionContext?.planEvidenceAtRecommendationTime?.blocks)
      ? actionContext.planEvidenceAtRecommendationTime.blocks
      : []),
    ...(Array.isArray(actionContext?.currentSystemContext?.blocks)
      ? actionContext.currentSystemContext.blocks
      : []),
  ];
}

/** @param {Array<{ role: string; content: string }>} messages */
function safeRecentThread(messages) {
  return messages.slice(-8).map((message) => ({
    role: ["merchant", "assistant", "system"].includes(message.role) ? message.role : "message",
    content: safePromptText(message.content, MAX_PROMPT_THREAD_MESSAGE),
  }));
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function safePromptText(value, max) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const redacted = redact(raw, { maxString: max });
  const text = typeof redacted === "string" ? redacted : raw.slice(0, max);
  return text
    .replace(/\b(customer|client|buyer|recipient)\s+(?:name\s*)?[:#-]?\s+[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3}/gi, "$1 [redacted-name]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted-phone]",
    )
    .slice(0, max);
}

/** @param {AnyRecord} result */
function sanitizeAnalystResult(result) {
  const rejected = result.ok === false;
  return sanitizeRecord({
    ...result,
    kind: rejected ? safeKind(result.kind) : result.kind,
    error: rejected ? "Unsupported analyst tool request." : result.error,
    rows: Array.isArray(result.rows) ? result.rows.map(sanitizeRow) : [],
    totals: sanitizeRecord(result.totals ?? {}),
    dataQuality: sanitizeRecord(result.dataQuality ?? {}),
    caveats: Array.isArray(result.caveats) ? result.caveats.map((item) => safeText(item, 240)).filter(Boolean) : [],
  });
}

/** @param {AnyRecord} row */
function sanitizeRow(row) {
  const redacted = redact(row, { maxDepth: 5, maxString: 320 });
  const record = asRecord(redacted) ?? {};
  return sanitizeRecord(record);
}

/**
 * @param {AnyRecord | AnyRecord[]} record
 * @returns {any}
 */
function sanitizeRecord(record) {
  if (Array.isArray(record)) {
    return record.map((/** @type {unknown} */ item) => sanitizeRecord(asRecord(item) ?? { value: item }));
  }
  /** @type {AnyRecord} */
  const output = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (value === undefined) continue;
    if (/raw|payload|customer|email|phone|address|token|secret|credential|session/i.test(key)) continue;
    if (value instanceof Date) {
      output[key] = value.toISOString();
    } else if (value && typeof value === "object" && typeof value.toNumber === "function") {
      output[key] = Number(value);
    } else if (Array.isArray(value)) {
      output[key] = value.map((/** @type {unknown} */ item) => item && typeof item === "object" ? sanitizeRecord(asRecord(item) ?? { value: item }) : normalizeScalar(item));
    } else if (value && typeof value === "object") {
      output[key] = sanitizeRecord(value);
    } else {
      output[key] = normalizeScalar(value);
    }
  }
  return output;
}

/** @param {unknown} value */
function normalizeScalar(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return safeDataText(value, 320);
  if (typeof value === "object" && typeof value.toString === "function") {
    const textValue = value.toString();
    const numeric = Number(textValue);
    return Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(textValue) ? numeric : safeDataText(textValue, 320);
  }
  return String(value);
}

/** @param {unknown} value @param {number} max */
function safeDataText(value, max) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const redacted = redact(raw, { maxString: max });
  const text = typeof redacted === "string" ? redacted : raw;
  return text
    .replace(/\b(customer|client|buyer|recipient)\s+(?:name\s*)?[:#-]?\s+[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3}/gi, "$1 [redacted-name]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted-phone]",
    )
    .slice(0, max);
}

/** @param {string} id @param {string} error */
function rejectedResult(id, error) {
  return {
    id: safeId(id) || "rejected",
    ok: false,
    rows: [],
    totals: {},
    formula: "",
    sourceTables: [],
    dataQuality: {},
    caveats: [],
    error: safeText(error, 240),
    catalogVersion: COMMERCE_ANALYST_CATALOG_VERSION,
  };
}

/** @param {unknown} raw */
function parseReply(raw) {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  const reply = safeText(asRecord(value)?.reply, 1800);
  return reply.length >= 2 ? reply : null;
}

/** @param {unknown} value */
function safeKind(value) {
  const kind = safeText(value, 80);
  return /sql|query|customer|raw|token|secret/i.test(kind) ? "unsupported" : kind || "unknown";
}

/** @param {unknown} value */
function safeId(value) {
  return safeText(value, 120).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

/** @param {unknown} value */
function safeFormula(value) {
  const text = safeText(value, 220);
  if (!text || /[^A-Za-z0-9_+\-*/().,\s]/.test(text)) return "";
  return text;
}

/** @param {unknown} value @param {number} max */
function safeText(value, max) {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

/** @param {unknown} value */
function parseJson(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value */
function parseDate(value) {
  const text = safeText(value, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInteger(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** @param {unknown} value */
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** @param {unknown} value */
function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @param {number} [digits]
 */
function round(value, digits = 2) {
  const parsed = number(value);
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

/** @param {number[]} values */
function sum(values) {
  return values.reduce((total, value) => total + number(value), 0);
}

/** @param {unknown[]} values */
function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

/** @param {string[]} items */
function formatList(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** @param {string} value */
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
