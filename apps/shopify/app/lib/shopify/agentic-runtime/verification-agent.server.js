// @ts-check

import { Type } from "@google/genai";
import { logger as baseLogger } from "../../observability/logger.server.js";
import { getActionRevisionState } from "../api/gateway.server.js";
import { retrieveShopifyApiOperations } from "../api/retrieval.server.js";
import {
  SHOPIFY_AGENT_TOOL,
  SHOPIFY_AGENT_TOOL_CALL_SCHEMA,
  publicShopifyToolResults,
  runShopifyAgentTool,
} from "./tools.server.js";
import {
  buildExecutionSemanticAction,
  markActionExecutionOutcome,
  markExecutionPhase,
} from "./execution-agent.server.js";

const log = baseLogger.child({ component: "agentic-shopify-verification" });

export const AGENTIC_VERIFICATION_PROMPT_VERSION = "agentic-shopify-verification-v1";
export const MAX_VERIFICATION_ITERATIONS = 5;

// Gateway status values used when querying write receipts.
const RECEIPT_STATUSES = ["OK", "IDEMPOTENT_REPLAY"];

export const AGENTIC_VERIFICATION_SCHEMA = {
  type: Type.OBJECT,
  required: ["status"],
  properties: {
    status: {
      type: Type.STRING,
      enum: ["CONTINUE", "OUTCOME_ACHIEVED", "VERIFICATION_MISMATCH", "BLOCKED"],
    },
    toolCalls: SHOPIFY_AGENT_TOOL_CALL_SCHEMA,
    progressSummary: { type: Type.STRING, nullable: true },
    verification: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        verified: { type: Type.BOOLEAN, nullable: true },
        evidence: { type: Type.ARRAY, nullable: true, items: { type: Type.STRING } },
        remaining: { type: Type.ARRAY, nullable: true, items: { type: Type.STRING } },
        mismatch: { type: Type.STRING, nullable: true },
      },
    },
    blocker: { type: Type.STRING, nullable: true },
  },
};

/**
 * Verification-only runtime for an already-executed agentic Shopify Action.
 *
 * Safety invariant: this function NEVER issues Shopify mutations. Write capability
 * is blocked at the tool layer (`verificationMode: true`) regardless of what the
 * LLM requests. Any attempt to call a mutation operation returns VERIFICATION_WRITE_DENIED
 * and is recorded as a tool failure without touching Shopify.
 *
 * @param {{
 *   provider: { enabled?: boolean; generateStructuredJson?: Function };
 *   prisma?: any;
 *   client: { request: (document: string, variables?: Record<string, unknown>) => Promise<unknown> };
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   actionId: string;
 *   action?: any;
 *   acceptedRevision?: string | null;
 *   writeReceipts?: any[];
 *   grantedScopes?: string[];
 *   catalog?: import("../api/catalog.server.js").ShopifyApiCatalog;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   maxIterations?: number;
 * }} input
 */
export async function runAgenticShopifyVerification(input) {
  const logger = input.logger ?? log;
  const provider = input.provider;
  if (!provider?.enabled || typeof provider.generateStructuredJson !== "function") {
    return { ok: false, status: "BLOCKED", blocker: "llm_provider_unavailable", trace: null };
  }

  const action = input.action ?? (await loadAction(input.prisma, input));
  if (!action) return { ok: false, status: "BLOCKED", blocker: "action_not_found", trace: null };

  const revision = getActionRevisionState(action);
  const acceptedRevision = input.acceptedRevision ?? revision.acceptedActionRevision;
  if (!acceptedRevision) {
    return { ok: false, status: "BLOCKED", blocker: "accepted_action_revision_missing", trace: null };
  }

  const semanticAction = buildExecutionSemanticAction(action, revision);

  // Load durable write receipts for this action + accepted revision.
  // These prove what Shopify mutations succeeded and what resources were affected.
  const receipts = input.writeReceipts ??
    (await loadWriteReceipts(input.prisma, {
      merchantActionId: action.id,
      acceptedActionRevision: acceptedRevision,
    }));

  if (!receipts.length) {
    logger.warn("agentic verification: no write receipts found for revision", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      acceptedRevision,
    });
  }

  const initialTools = retrieveShopifyApiOperations(
    `verify ${semanticAction.outcome} ${semanticAction.verificationPlan ?? ""}`,
    { catalog: input.catalog, limit: 8, operationKind: "QUERY" },
  );

  /** @type {any[]} */
  const toolResults = [];
  /** @type {any[]} */
  const turns = [];

  for (let iteration = 0; iteration < (input.maxIterations ?? MAX_VERIFICATION_ITERATIONS); iteration += 1) {
    const llmResult = await provider.generateStructuredJson({
      systemPrompt: buildVerificationSystemPrompt(),
      prompt: JSON.stringify({
        promptVersion: AGENTIC_VERIFICATION_PROMPT_VERSION,
        iteration,
        acceptedActionRevision: acceptedRevision,
        acceptedAction: semanticAction,
        executedMutations: formatReceiptsForPrompt(receipts),
        initiallyRetrievedShopifyReadTools: initialTools,
        toolResults: publicShopifyToolResults(toolResults),
      }),
      schema: AGENTIC_VERIFICATION_SCHEMA,
      maxInputTokens: 20000,
      maxOutputTokens: 2000,
      timeoutMs: 60_000,
    });

    const turn = normalizeVerificationTurn(llmResult.json);
    turns.push({ ...turn, usage: llmResult.usage ?? null, durationMs: llmResult.durationMs ?? null });

    for (const toolCall of turn.toolCalls) {
      const toolResult = await runShopifyAgentTool(
        {
          prisma: input.prisma,
          client: input.client,
          merchantId: input.merchantId,
          shopId: input.shopId,
          shopDomain: input.shopDomain,
          actionId: input.actionId,
          acceptedActionRevision: acceptedRevision,
          grantedScopes: input.grantedScopes,
          catalog: input.catalog,
          logger,
          verificationMode: true,
        },
        toolCall,
      );
      toolResults.push(toolResult);
    }

    if (turn.status === "CONTINUE" && turn.toolCalls.length === 0) {
      toolResults.push({
        tool: "verification_validation",
        ok: false,
        message: "CONTINUE requires a Shopify read tool call. Mutations are not available.",
        facts: { requiredNextTools: [SHOPIFY_AGENT_TOOL.callOperation] },
        error: {
          code: "MISSING_VERIFICATION_TOOL_CALL",
          message: "Use a read operation to inspect Shopify state.",
        },
      });
      continue;
    }
    if (turn.toolCalls.length > 0 && turn.status === "CONTINUE") continue;

    if (turn.status === "OUTCOME_ACHIEVED") {
      await markActionExecutionOutcome(input.prisma, input, {
        status: "completed",
        executionPhase: "completed",
        outcome: {
          verification: turn.verification,
          progressSummary: turn.progressSummary ?? null,
        },
      });
      logger.info("agentic Shopify verification: outcome achieved", {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        iterations: iteration + 1,
      });
      return {
        ok: true,
        status: "OUTCOME_ACHIEVED",
        verification: turn.verification,
        trace: { turns, toolResults: publicShopifyToolResults(toolResults) },
      };
    }

    if (turn.status === "VERIFICATION_MISMATCH") {
      await markActionExecutionOutcome(input.prisma, input, {
        status: "needs_attention",
        executionPhase: "needs_attention",
        outcome: {
          verification: turn.verification,
          verificationMismatch: true,
          mismatch: turn.verification?.mismatch ?? turn.blocker ?? "Shopify state does not match expected outcome.",
          progressSummary: turn.progressSummary ?? null,
        },
      });
      logger.info("agentic Shopify verification: mismatch", {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        mismatch: turn.verification?.mismatch ?? turn.blocker,
      });
      return {
        ok: false,
        status: "VERIFICATION_MISMATCH",
        blocker: turn.blocker ?? turn.verification?.mismatch ?? null,
        trace: { turns, toolResults: publicShopifyToolResults(toolResults) },
      };
    }

    if (turn.status === "BLOCKED") {
      // Verification is blocked but recoverable — leave the phase as verification_incomplete.
      await markExecutionPhase(input.prisma, input, "verification_incomplete");
      return {
        ok: false,
        status: "BLOCKED",
        blocker: turn.blocker ?? null,
        trace: { turns, toolResults: publicShopifyToolResults(toolResults) },
      };
    }
  }

  // Verification budget exhausted — state is recoverable.
  await markExecutionPhase(input.prisma, input, "verification_incomplete");
  return {
    ok: false,
    status: "BLOCKED",
    blocker: "VERIFICATION_ITERATION_LIMIT",
    trace: { turns, toolResults: publicShopifyToolResults(toolResults) },
  };
}

export function buildVerificationSystemPrompt() {
  return `You are Jefe verifying the outcome of a Shopify Action that has already been executed.

The mutation phase is CLOSED. You have read-only tools. Any attempt to call a mutation operation will be rejected by the gateway — do not attempt writes.

You are given a summary of the mutations that were successfully issued. Your job is to read current Shopify state and determine whether the intended outcome is now in place.

Use retrieve_shopify_operations to find appropriate read operations. Call them with appropriate variables to inspect the affected resources. When you have sufficient evidence that the outcome is achieved, return OUTCOME_ACHIEVED with a verification summary. If current Shopify state does not match the expected outcome, return VERIFICATION_MISMATCH and describe what is wrong. If you are unable to verify after reading, return BLOCKED.

Do not attempt mutations. Do not claim OUTCOME_ACHIEVED without reading actual Shopify state.`;
}

/** @param {any[]} receipts */
function formatReceiptsForPrompt(receipts) {
  return receipts.map((r) => ({
    operation: r.operationName ?? r.operationId ?? "unknown",
    purpose: r.purpose ?? "",
    expectedEffect: r.expectedEffect ?? "",
    resourceIds: Array.isArray(r.resourceIds) ? r.resourceIds : [],
    status: r.status,
  }));
}

/** @param {unknown} raw */
function normalizeVerificationTurn(raw) {
  const object =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, any>} */ (raw)
      : {};
  const toolCalls = (Array.isArray(object.toolCalls) ? object.toolCalls : [])
    .map((/** @type {any} */ row) => ({
      tool: String(row?.tool ?? ""),
      arguments:
        row?.arguments && typeof row.arguments === "object" && !Array.isArray(row.arguments)
          ? stripNulls(row.arguments)
          : {},
    }))
    .filter(
      (row) =>
        row.tool === SHOPIFY_AGENT_TOOL.retrieveOperations ||
        row.tool === SHOPIFY_AGENT_TOOL.callOperation,
    );
  return {
    status: ["CONTINUE", "OUTCOME_ACHIEVED", "VERIFICATION_MISMATCH", "BLOCKED"].includes(
      String(object.status),
    )
      ? String(object.status)
      : "CONTINUE",
    toolCalls,
    progressSummary: typeof object.progressSummary === "string" ? object.progressSummary : null,
    verification:
      object.verification &&
      typeof object.verification === "object" &&
      !Array.isArray(object.verification)
        ? /** @type {Record<string, any>} */ (object.verification)
        : null,
    blocker: typeof object.blocker === "string" ? object.blocker : null,
  };
}

/**
 * Load successful write receipts for the given action and accepted revision.
 * Only MUTATION operations with OK or IDEMPOTENT_REPLAY status are returned —
 * these are the receipts that prove writes occurred and give the verifier context.
 * @param {any} prisma
 * @param {{ merchantActionId: string; acceptedActionRevision: string }} input
 */
async function loadWriteReceipts(prisma, input) {
  if (!prisma?.shopifyOperationCall?.findMany) return [];
  try {
    return await prisma.shopifyOperationCall.findMany({
      where: {
        merchantActionId: input.merchantActionId,
        acceptedActionRevision: input.acceptedActionRevision,
        operationKind: "MUTATION",
        status: { in: RECEIPT_STATUSES },
      },
      orderBy: { createdAt: "asc" },
    });
  } catch {
    return [];
  }
}

/** @param {any} prisma @param {{ actionId: string; merchantId: string; shopId: string }} input */
async function loadAction(prisma, input) {
  if (!prisma?.merchantAction?.findFirst) return null;
  return prisma.merchantAction.findFirst({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
  });
}

/** @param {Record<string, any>} value */
function stripNulls(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v != null));
}
