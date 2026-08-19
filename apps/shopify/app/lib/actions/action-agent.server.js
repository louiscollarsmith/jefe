// @ts-check

/**
 * LLM Action Agent — semantic planner with a bounded tool-calling loop.
 *
 * Merchant message → resolve state → plan tool calls → validated execution
 * → observe results → next tool or final answer.
 */

import { Type } from "@google/genai";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  ACTION_COMMAND,
  executeActionCommand,
  isMutationCommand,
} from "./action-command.server.js";
import { achieveOutcome } from "./action-outcome.server.js";
import { buildAgentStateContext, resolveActionState } from "./action-state.server.js";
import { formatSimulationReply } from "./action-interpreter.server.js";

const log = baseLogger.child({ component: "action-agent" });

export const ACTION_AGENT_VERSION = "1";
export const MAX_AGENT_TOOL_CALLS = 8;

/** @type {string[]} */
export const ACTION_AGENT_TOOLS = Object.freeze([
  "get_action_state",
  "update_plan",
  "add_constraint",
  "remove_constraint",
  "simulate_plan",
  "achieve_outcome",
  "inspect_scope",
  "inspect_proposal",
  "report_execution",
  "accept_plan",
  "create_changeset",
  "apply_changeset",
  "start_step",
  "advance_step",
  "go_back",
  "go_to_step",
  "skip_step",
  "answer",
]);

const TOOL_ARGUMENTS_SCHEMA = {
  type: Type.OBJECT,
  nullable: true,
  properties: {
    coverDays: { type: Type.NUMBER, nullable: true },
    markdownPercent: { type: Type.NUMBER, nullable: true },
    maxProducts: { type: Type.NUMBER, nullable: true },
    outcome: { type: Type.STRING, nullable: true },
    productHint: { type: Type.STRING, nullable: true },
    productTitle: { type: Type.STRING, nullable: true },
    constraintKind: { type: Type.STRING, nullable: true },
    constraintLabel: { type: Type.STRING, nullable: true },
    constraintId: { type: Type.STRING, nullable: true },
    scopeIntent: { type: Type.STRING, nullable: true },
    collectionTitle: { type: Type.STRING, nullable: true },
    tag: { type: Type.STRING, nullable: true },
    explicitApply: { type: Type.BOOLEAN, nullable: true },
    message: { type: Type.STRING, nullable: true },
    steps: { type: Type.NUMBER, nullable: true },
    targetHint: { type: Type.STRING, nullable: true },
    stepId: { type: Type.STRING, nullable: true },
  },
};

export const ACTION_AGENT_TURN_SCHEMA = {
  type: Type.OBJECT,
  required: ["done", "confidence"],
  properties: {
    done: { type: Type.BOOLEAN },
    finalReply: { type: Type.STRING, nullable: true },
    requiresClarification: { type: Type.BOOLEAN, nullable: true },
    clarificationQuestion: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
    routing: { type: Type.STRING, enum: ["focused", "general_store"], nullable: true },
    toolCalls: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        required: ["tool"],
        properties: {
          tool: { type: Type.STRING, enum: [...ACTION_AGENT_TOOLS] },
          arguments: TOOL_ARGUMENTS_SCHEMA,
        },
      },
    },
  },
};

const AGENT_SYSTEM_PROMPT = [
  "You are Jefe's focused-action agent. Given the merchant message and action state, choose tool calls to reach their desired outcome.",
  "Return JSON only. Never invent tools outside the enum.",
  "",
  "Principles:",
  "- Understand desired outcomes, not wizard commands. 'Draft the supplier message' → achieve_outcome outcome=supplier_draft.",
  "- One merchant turn may require several tools in sequence across turns of this loop.",
  "- Use get_action_state when unsure what is already complete or stale.",
  "- update_plan only uses fields listed in planSchema for this action type. Replenishment has coverDays, not markdownPercent.",
  "- simulate_plan for hypotheticals ('what would 60 days look like?'). update_plan only when they want to persist.",
  "- achieve_outcome auto-runs safe Jefe-owned prerequisites. Prefer it over START_STEP for supplier drafts, proposals, etc.",
  "- Do not apply Shopify writes unless the merchant clearly approves and policy allows.",
  "- routing=general_store only for explicit store-wide questions unrelated to this action.",
  "",
  "When done=true, finalReply is a grounded natural-language answer for the merchant.",
  "When requiresClarification=true, ask one narrow question and set done=true with empty toolCalls.",
  "",
  "Goal-oriented execution:",
  "- 'Draft the supplier message', 'build the proposal', 'finish the earlier work' → achieve_outcome with the matching outcome.",
  "- 'Remove Pear and use 90 days' → add_constraint then update_plan (multiple tools, one turn if safe).",
  "- Do not tell the merchant to start steps manually when achieve_outcome can run prerequisites.",
].join("\n");

/**
 * @param {any} prisma
 * @param {{
 *   message: string;
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   conversationId?: string | null;
 *   actor?: string | null;
 *   session?: { shop: string } | null;
 *   executeDeps?: any;
 *   provider?: { enabled?: boolean; generateStructuredJson?: Function; model?: string; provider?: string } | null;
 *   recentMessages?: Array<{ role?: string; content?: string }>;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function runActionAgent(prisma, input) {
  const logger = input.logger ?? log;
  const provider = input.provider;
  if (!provider?.enabled || typeof provider.generateStructuredJson !== "function") {
    return { ok: false, unavailable: true, routing: "focused", reply: "", toolTrace: [] };
  }

  /** @type {any[]} */
  const toolTrace = [];
  /** @type {any[]} */
  const observations = [];
  let state = await resolveActionState(prisma, input);
  if (!state) {
    return {
      ok: false,
      routing: "focused",
      reply: "I couldn't find that action. Open it again from home.",
      toolTrace,
    };
  }

  for (let turn = 0; turn < MAX_AGENT_TOOL_CALLS; turn += 1) {
    const agentTurn = await provider.generateStructuredJson({
      systemPrompt: AGENT_SYSTEM_PROMPT,
      prompt: JSON.stringify({
        merchantMessage: input.message,
        recentMessages: (input.recentMessages ?? []).slice(-8),
        actionState: buildAgentStateContext(state),
        priorObservations: observations.slice(-6),
        availableTools: ACTION_AGENT_TOOLS,
        planSchema: state.planSchema,
      }),
      schema: ACTION_AGENT_TURN_SCHEMA,
      maxOutputTokens: 800,
    });

    const parsed = parseAgentTurn(agentTurn.json);
    logger.info("action agent turn", {
      turn,
      done: parsed.done,
      toolCalls: (parsed.toolCalls ?? []).map((row) => row.tool),
      routing: parsed.routing,
    });

    if (parsed.routing === "general_store") {
      return {
        ok: true,
        routing: "general_store",
        reply: "",
        toolTrace,
        agentTurn: parsed,
      };
    }

    if (parsed.requiresClarification) {
      return {
        ok: true,
        routing: "focused",
        reply: parsed.clarificationQuestion || "Which did you mean?",
        toolTrace,
        requiresClarification: true,
        agentTurn: parsed,
      };
    }

    if (parsed.done || !parsed.toolCalls?.length) {
      const lastTool = toolTrace[toolTrace.length - 1];
      return {
        ok: true,
        routing: "focused",
        reply: parsed.finalReply || summarizeObservations(observations) || "Done.",
        toolTrace,
        result: lastTool?.result ?? null,
        agentTurn: parsed,
      };
    }

    for (const call of parsed.toolCalls) {
      const result = await executeAgentTool(prisma, {
        ...input,
        tool: call.tool,
        args: call.arguments ?? {},
        state,
        logger,
      });
      toolTrace.push({ tool: call.tool, args: call.arguments ?? {}, result });
      observations.push({
        tool: call.tool,
        ok: result.ok,
        summary: result.summary ?? result.reply ?? null,
        reply: result.reply ?? null,
      });
      if (!result.ok && isMutationTool(call.tool)) {
        return {
          ok: false,
          routing: "focused",
          reply: result.reply ?? "I couldn't complete that safely.",
          toolTrace,
          result: result.result ?? result,
        };
      }
    }

    state = await resolveActionState(prisma, input);
  }

  const lastTool = toolTrace[toolTrace.length - 1];
  return {
    ok: true,
    routing: "focused",
    reply: summarizeObservations(observations) || "I've done what I can for now — ask me to continue if you need more.",
    toolTrace,
    result: lastTool?.result ?? null,
    bounded: true,
  };
}

/**
 * @param {any} prisma
 * @param {any} input
 */
async function executeAgentTool(prisma, input) {
  const { tool, args, state } = input;
  switch (tool) {
    case "get_action_state":
      return {
        ok: true,
        summary: "Current action state loaded.",
        state: buildAgentStateContext(state),
      };
    case "simulate_plan": {
      const snapshot = {
        plan: state.plan,
        scopeItems: state.scope?.items ?? [],
        action: state.action,
      };
      const reply = formatSimulationReply(snapshot, args);
      return {
        ok: true,
        reply,
        summary: reply,
      };
    }
    case "start_step":
      return runCommandTool(prisma, input, ACTION_COMMAND.START_STEP, {
        stepId: args.stepId ?? null,
      });
    case "achieve_outcome": {
      const achieved = await achieveOutcome(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        outcome: args.outcome ?? inferOutcomeFromMessage(input.message),
        actor: input.actor,
        conversationId: input.conversationId,
        session: input.session,
        executeDeps: input.executeDeps,
        logger: input.logger,
      });
      return wrapToolExecution(achieved, ACTION_COMMAND.ACHIEVE_OUTCOME);
    }
    case "update_plan":
      return runCommandTool(prisma, input, ACTION_COMMAND.REVISE_PLAN, {
        coverDays: args.coverDays,
        markdownPercent: args.markdownPercent,
        maxProducts: args.maxProducts,
      });
    case "add_constraint":
      return runCommandTool(prisma, input, ACTION_COMMAND.ADD_CONSTRAINT, {
        constraintKind: args.constraintKind,
        productTitle: args.productTitle ?? args.productHint,
        constraintLabel: args.constraintLabel,
        collectionTitle: args.collectionTitle,
        tag: args.tag,
        scopeModification: args.scopeIntent
          ? { intent: args.scopeIntent, title: args.productTitle ?? args.productHint }
          : undefined,
      });
    case "remove_constraint":
      return runCommandTool(prisma, input, ACTION_COMMAND.REMOVE_CONSTRAINT, {
        constraintId: args.constraintId,
        constraintKind: args.constraintKind,
        constraintLabel: args.constraintLabel,
      });
    case "inspect_scope":
      return runCommandTool(prisma, input, ACTION_COMMAND.INSPECT_SCOPE, {});
    case "inspect_proposal":
      return runCommandTool(prisma, input, ACTION_COMMAND.INSPECT_PROPOSAL, {});
    case "report_execution":
      return runCommandTool(prisma, input, ACTION_COMMAND.REPORT_EXECUTION, {});
    case "accept_plan":
      return runCommandTool(prisma, input, ACTION_COMMAND.ACCEPT_PLAN, {});
    case "create_changeset":
      return runCommandTool(prisma, input, ACTION_COMMAND.CREATE_CHANGESET, {});
    case "apply_changeset":
      return runCommandTool(prisma, input, ACTION_COMMAND.APPLY_CHANGESET, {
        explicitApply: args.explicitApply === true,
      });
    case "advance_step":
      return runCommandTool(prisma, input, ACTION_COMMAND.ADVANCE_STEP, {});
    case "go_back":
      return runCommandTool(prisma, input, ACTION_COMMAND.GO_BACK, {
        steps: args.steps ?? 1,
      });
    case "go_to_step":
      return runCommandTool(prisma, input, ACTION_COMMAND.GO_TO_STEP, {
        targetHint: args.targetHint,
        stepId: args.stepId,
      });
    case "skip_step":
      return runCommandTool(prisma, input, ACTION_COMMAND.SKIP_STEP, {});
    case "answer":
    default:
      return runCommandTool(prisma, input, ACTION_COMMAND.ANSWER, {
        simulate: args.simulate === true || args.coverDays != null || args.markdownPercent != null,
        coverDays: args.coverDays,
        markdownPercent: args.markdownPercent,
        questionKind: args.questionKind ?? null,
      });
  }
}

/** @param {any} prisma @param {any} input @param {string} command @param {Record<string, any>} params */
async function runCommandTool(prisma, input, command, params) {
  const executed = await executeActionCommand(prisma, {
    command,
    params,
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    actor: input.actor,
    conversationId: input.conversationId,
    session: input.session,
    executeDeps: input.executeDeps,
    message: input.message,
    logger: input.logger,
  });
  return wrapToolExecution(executed, command);
}

/** @param {any} executed @param {string} [command] */
function wrapToolExecution(executed, command) {
  return {
    ok: executed.ok,
    reply: executed.reply,
    summary: executed.reply,
    result: executed,
    command: executed.command ?? command ?? null,
  };
}

/** @param {any} raw */
function parseAgentTurn(raw) {
  if (!raw || typeof raw !== "object") {
    return { done: true, finalReply: null, toolCalls: [], confidence: 0, routing: "focused" };
  }
  return {
    done: raw.done === true,
    finalReply: typeof raw.finalReply === "string" ? raw.finalReply.trim() : null,
    requiresClarification: raw.requiresClarification === true,
    clarificationQuestion:
      typeof raw.clarificationQuestion === "string" ? raw.clarificationQuestion.trim() : null,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.5,
    routing: raw.routing === "general_store" ? "general_store" : "focused",
    toolCalls: Array.isArray(raw.toolCalls)
      ? raw.toolCalls
          .map((/** @type {any} */ row) => ({
            tool: String(row?.tool ?? "").trim(),
            arguments: row?.arguments && typeof row.arguments === "object" ? row.arguments : {},
          }))
          .filter((/** @type {any} */ row) => ACTION_AGENT_TOOLS.includes(row.tool))
      : [],
  };
}

/** @param {any[]} observations */
function summarizeObservations(observations) {
  const replies = observations
    .map((row) => row.reply ?? row.summary)
    .filter((value) => typeof value === "string" && value.trim());
  return replies.length ? replies[replies.length - 1] : null;
}

/** @param {string} tool */
function isMutationTool(tool) {
  return [
    "update_plan",
    "add_constraint",
    "remove_constraint",
    "achieve_outcome",
    "accept_plan",
    "apply_changeset",
  ].includes(tool);
}

/** @param {string | null | undefined} message */
function inferOutcomeFromMessage(message) {
  const text = String(message ?? "").toLowerCase();
  if (/supplier|email|message|communication|draft/.test(text)) return "supplier_draft";
  if (/proposal|replenish|reorder/.test(text)) return "replenishment_proposal";
  if (/inventory|review|cover/.test(text)) return "inventory_review";
  if (/preview|change ?set|show me.*change/.test(text)) return "changeset_preview";
  return "supplier_draft";
}

/** @param {any[]} toolTrace */
export function primaryCommandFromToolTrace(toolTrace) {
  if (!Array.isArray(toolTrace) || toolTrace.length === 0) return null;
  const last = toolTrace[toolTrace.length - 1];
  const tool = String(last?.tool ?? "");
  /** @type {Record<string, string>} */
  const toolToCommand = {
    update_plan: ACTION_COMMAND.REVISE_PLAN,
    add_constraint: ACTION_COMMAND.ADD_CONSTRAINT,
    remove_constraint: ACTION_COMMAND.REMOVE_CONSTRAINT,
    inspect_scope: ACTION_COMMAND.INSPECT_SCOPE,
    inspect_proposal: ACTION_COMMAND.INSPECT_PROPOSAL,
    report_execution: ACTION_COMMAND.REPORT_EXECUTION,
    accept_plan: ACTION_COMMAND.ACCEPT_PLAN,
    create_changeset: ACTION_COMMAND.CREATE_CHANGESET,
    apply_changeset: ACTION_COMMAND.APPLY_CHANGESET,
    achieve_outcome: ACTION_COMMAND.ACHIEVE_OUTCOME,
    start_step: ACTION_COMMAND.START_STEP,
    advance_step: ACTION_COMMAND.ADVANCE_STEP,
    go_back: ACTION_COMMAND.GO_BACK,
    go_to_step: ACTION_COMMAND.GO_TO_STEP,
    skip_step: ACTION_COMMAND.SKIP_STEP,
    answer: ACTION_COMMAND.ANSWER,
    simulate_plan: ACTION_COMMAND.ANSWER,
  };
  return toolToCommand[tool] ?? null;
}
