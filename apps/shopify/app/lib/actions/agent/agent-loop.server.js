// @ts-check

/**
 * The one canonical focused-action path.
 *
 * Every merchant message on a conversation with a focused action goes through
 * `runFocusedActionAgent`. There is no regex router, no second interpreter and
 * no generic recap branch behind it.
 *
 * The loop's contract with the model is deliberately narrow:
 *
 * - the model proposes tool calls; **the application always executes the ones
 *   it proposes**, even on a turn the model marked `done` (the old loop
 *   returned early there, which is why a perfectly-planned turn could answer
 *   "Done." having performed nothing);
 * - every result — including validation rejections — goes back to the model
 *   before it may answer;
 * - the final wording is checked against the tool ledger by
 *   `composeGroundedReply`, so prose can never outrun what happened.
 */

import { Type } from "@google/genai";
import { logger as baseLogger } from "../../observability/logger.server.js";
import { ACTION_COMMAND, executeActionCommand } from "../action-command.server.js";
import { resolveActionState } from "../action-state.server.js";
import { listActionConstraints, normalizeMatch } from "../action-constraint.server.js";
import { reachCapability } from "./assist-runner.server.js";
import {
  TOOL_EFFECT,
  TOOL_SCHEMA_VERSION,
  assistResultToTool,
  buildCurrentProposal,
  diffFacts,
  fail,
  ok,
  planFacts,
  runTool,
  snapshotFacts,
  toolCatalogueForKind,
  toolEffect,
  toolNamesForKind,
  toolRequiresExplicitApproval,
} from "./tool-registry.server.js";
import {
  TURN_OUTCOME,
  classifyTurn,
  composeGroundedReply,
  summarizeLedger,
} from "./turn-outcome.server.js";
import { recordAgentTrace, startAgentTrace } from "./agent-trace.server.js";

const log = baseLogger.child({ component: "action-agent" });

export const ACTION_AGENT_VERSION = "2";
export const ACTION_AGENT_PROMPT_VERSION = "2";
export const MAX_AGENT_ITERATIONS = 6;
export const MAX_TOOL_CALLS_PER_TURN = 12;

/**
 * Union of every argument any tool accepts. Per-tool validation narrows this;
 * the model is separately told which arguments each tool actually takes.
 */
const TOOL_ARGUMENTS_SCHEMA = {
  type: Type.OBJECT,
  nullable: true,
  properties: {
    coverDays: { type: Type.NUMBER, nullable: true },
    markdownPercent: { type: Type.NUMBER, nullable: true },
    maxProducts: { type: Type.NUMBER, nullable: true },
    productTitle: { type: Type.STRING, nullable: true },
    constraintKind: { type: Type.STRING, nullable: true },
    constraintId: { type: Type.STRING, nullable: true },
    collectionTitle: { type: Type.STRING, nullable: true },
    tag: { type: Type.STRING, nullable: true },
    minInventory: { type: Type.NUMBER, nullable: true },
    minPrice: { type: Type.NUMBER, nullable: true },
    stepId: { type: Type.STRING, nullable: true },
  },
};

export const AGENT_TURN_SCHEMA = {
  type: Type.OBJECT,
  required: ["done"],
  properties: {
    intent: { type: Type.STRING, nullable: true },
    toolCalls: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        required: ["tool"],
        properties: {
          tool: { type: Type.STRING },
          arguments: TOOL_ARGUMENTS_SCHEMA,
        },
      },
    },
    done: { type: Type.BOOLEAN },
    finalReply: { type: Type.STRING, nullable: true },
    requiresClarification: { type: Type.BOOLEAN, nullable: true },
    clarificationQuestion: { type: Type.STRING, nullable: true },
    routing: { type: Type.STRING, enum: ["focused", "general_store"], nullable: true },
    confidence: { type: Type.NUMBER, nullable: true },
  },
};

const SYSTEM_PROMPT = [
  "You are Jefe operating one specific merchant action. You understand what the merchant means and decide what needs to happen; the application decides what is valid and performs it.",
  "Return schema-constrained JSON only.",
  "",
  "How to work:",
  "- Read actionState. It is the truth about this action. Never infer current values from earlier chat prose.",
  "- Call the tools needed to reach the merchant's desired outcome. One message may need several tools; emit them in order.",
  "- You will see every tool result before you answer. Only set done=true once the work is finished or genuinely blocked.",
  "- If a tool result says an argument was rejected, fix the call rather than repeating it.",
  "",
  "Outcomes, not step ceremony:",
  "- 'Draft the supplier email', 'show me the proposal', 'move on', 'carry on', 'finish this' are requests for a RESULT. Call the tool that produces that result — it runs any missing prerequisites itself.",
  "- For product-type actions, if scopeStatus is 'unresolved', call discover_product_type_scope (or build_change_set, which discovers first) before answering what would change.",
  "- Never tell the merchant to start a step manually when a tool can do the work.",
  "",
  "Persist vs simulate:",
  "- 'Use 90 days' persists: update_plan.",
  "- 'What would 60 days look like?', 'what if', 'don't change it yet' simulate: simulate_plan. Never update_plan for a hypothetical.",
  "- A later 'yeah, use that' refers to the value you just simulated: then update_plan.",
  "",
  "Negation is a first-class instruction:",
  "- 'but don't draft the email' means you must not call draft_supplier_email in this turn.",
  "- 'don't change it', 'don't touch Shopify yet' mean no persisting tool and no apply.",
  "",
  "Questions and commands together: answer the question in finalReply AND run the requested tools.",
  "",
  "Ambiguity: if a reference genuinely could mean two things, set requiresClarification with one narrow question and call no mutating tools.",
  "",
  "Routing: set routing='general_store' only for a store-wide question unrelated to this action ('how many products do I sell overall?'). Anything about this action's plan, scope, numbers or work stays focused.",
  "",
  "finalReply: say what actually happened, using the numbers and names from the tool results. Never reply with a bare 'Done.' or 'Updated.'.",
].join("\n");

/**
 * @param {any} prisma
 * @param {{
 *   message: string;
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   conversationId?: string | null;
 *   merchantMessageId?: string | null;
 *   actor?: string | null;
 *   session?: { shop: string } | null;
 *   executeDeps?: any;
 *   provider?: { enabled?: boolean; generateStructuredJson?: Function; model?: string; provider?: string } | null;
 *   recentMessages?: Array<{ role?: string; content?: string }>;
 *   pendingClarification?: any;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   maxIterations?: number;
 * }} input
 */
export async function runFocusedActionAgent(prisma, input) {
  const logger = input.logger ?? log;
  const provider = input.provider;

  let state = await resolveActionState(prisma, input);
  if (!state) {
    return {
      ok: false,
      outcome: TURN_OUTCOME.failed,
      routing: "focused",
      reply: "I couldn't find that action. Open it again from home.",
      ledger: [],
      trace: null,
    };
  }

  if (!provider?.enabled || typeof provider.generateStructuredJson !== "function") {
    return {
      ok: false,
      unavailable: true,
      outcome: TURN_OUTCOME.failed,
      routing: "focused",
      reply:
        "I couldn't process that right now. Try again in a moment, or use the controls on the action.",
      ledger: [],
      trace: null,
    };
  }

  const kind = state.action?.kind ?? "generic";
  const availableTools = toolNamesForKind(kind);
  const catalogue = toolCatalogueForKind(kind);
  const trace = startAgentTrace({
    merchantMessageId: input.merchantMessageId ?? null,
    conversationId: input.conversationId ?? null,
    focusedActionId: input.actionId,
    message: input.message,
    model: provider.model ?? null,
    provider: provider.provider ?? null,
    agentVersion: ACTION_AGENT_VERSION,
    promptVersion: ACTION_AGENT_PROMPT_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    stateBefore: snapshotFacts(state),
  });

  /** @type {import("./tool-registry.server.js").ToolResult[]} */
  const ledger = [];
  /** @type {Set<string>} */
  const executedCalls = new Set();
  let modelReply = /** @type {string | null} */ (null);
  let clarificationQuestion = /** @type {string | null} */ (null);
  let routing = "focused";
  let bounded = false;

  const maxIterations = input.maxIterations ?? MAX_AGENT_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const ctx = await buildToolContext(prisma, input, { state, kind, logger });

    let turn;
    try {
      const generated = await provider.generateStructuredJson({
        systemPrompt: SYSTEM_PROMPT,
        prompt: JSON.stringify({
          merchantMessage: input.message,
          recentMessages: (input.recentMessages ?? []).slice(-8),
          pendingClarification: input.pendingClarification ?? null,
          actionState: agentStateView(state),
          tools: catalogue,
          toolResultsThisTurn: ledger.map(publicToolResult),
          iteration,
        }),
        schema: AGENT_TURN_SCHEMA,
        maxOutputTokens: 900,
      });
      turn = parseAgentTurn(generated.json, availableTools);
    } catch (error) {
      logger.warn("action agent planner failed", {
        actionId: input.actionId,
        iteration,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      trace.plannerError = error instanceof Error ? error.name : "UnknownError";
      break;
    }

    trace.iterations.push({
      iteration,
      intent: turn.intent,
      requestedTools: turn.toolCalls.map((call) => call.tool),
      rejectedTools: turn.rejectedTools,
      done: turn.done,
      routing: turn.routing,
    });

    if (turn.routing === "general_store" && ledger.length === 0) {
      routing = "general_store";
      break;
    }

    if (turn.requiresClarification && ledger.length === 0) {
      clarificationQuestion = turn.clarificationQuestion || "Which did you mean?";
      break;
    }

    if (turn.finalReply) modelReply = turn.finalReply;

    // Unknown tool names are a planner error the model must see, not silence.
    for (const name of turn.rejectedTools) {
      ledger.push(
        fail(name, {
          code: "UNKNOWN_TOOL",
          message: `"${name}" is not available on this action. Available: ${availableTools.join(", ")}.`,
        }),
      );
    }

    const calls = turn.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);

    // The old loop returned here whenever `done` was set, discarding the very
    // tool calls that were meant to do the work. Tools run first, always.
    if (calls.length === 0) {
      if (turn.done || turn.rejectedTools.length === 0) break;
      continue;
    }

    for (const call of calls) {
      const signature = `${call.tool}:${stableJson(call.arguments)}`;
      if (executedCalls.has(signature)) {
        ledger.push(
          fail(call.tool, {
            code: "ALREADY_RUN",
            message: `${call.tool} already ran with those arguments this turn — its result is above.`,
          }),
        );
        continue;
      }
      executedCalls.add(signature);

      const gate = gateToolCall(call.tool, ledger);
      if (gate) {
        ledger.push(gate);
        continue;
      }

      const result = await runTool(ctx, call.tool, call.arguments);
      ledger.push(result);

      if (result.ok && result.effect !== TOOL_EFFECT.read) {
        state = await resolveActionState(prisma, input);
        ctx.state = state;
      }
    }

    state = await resolveActionState(prisma, input);

    if (iteration === maxIterations - 1) bounded = true;
  }

  if (routing === "general_store") {
    recordAgentTrace(prisma, input, { ...trace, routing, outcome: "GENERAL_STORE" }, logger);
    return { ok: true, routing: "general_store", reply: "", ledger, outcome: TURN_OUTCOME.noAction, trace };
  }

  const outcome = clarificationQuestion
    ? TURN_OUTCOME.needsClarification
    : classifyTurn(ledger);

  const composed = composeGroundedReply({
    outcome,
    ledger,
    modelReply,
    clarificationQuestion,
  });

  const stateAfter = await resolveActionState(prisma, input);
  await recordRevisions(prisma, input, ledger, stateAfter, logger);

  trace.stateAfter = snapshotFacts(stateAfter);
  trace.ledger = ledger.map(publicToolResult);
  trace.outcome = outcome;
  trace.modelReply = modelReply;
  trace.finalReply = composed.reply;
  trace.usedModelProse = composed.usedModelProse;
  trace.bounded = bounded;
  recordAgentTrace(prisma, input, trace, logger);

  const parts = summarizeLedger(ledger);
  logger.info("focused action turn", {
    merchantMessageId: input.merchantMessageId ?? null,
    conversationId: input.conversationId ?? null,
    focusedActionId: input.actionId,
    agentVersion: ACTION_AGENT_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    model: provider.model ?? null,
    outcome,
    tools: ledger.map((row) => row.tool),
    effectfulSucceeded: parts.succeeded.length,
    failed: parts.failed.length,
    blocked: parts.blocked.length,
    usedModelProse: composed.usedModelProse,
    bounded,
  });

  return {
    ok: outcome === TURN_OUTCOME.success ||
      outcome === TURN_OUTCOME.partialSuccess ||
      outcome === TURN_OUTCOME.noAction ||
      outcome === TURN_OUTCOME.needsClarification,
    outcome,
    routing: "focused",
    reply: composed.reply,
    requiresClarification: outcome === TURN_OUTCOME.needsClarification,
    ledger,
    artifacts: parts.artifacts,
    changes: parts.changes,
    trace,
    bounded,
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic gates                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Hard boundaries the model cannot talk its way past.
 *
 * @param {string} tool
 * @param {import("./tool-registry.server.js").ToolResult[]} ledger
 */
function gateToolCall(tool, ledger) {
  if (!toolRequiresExplicitApproval(tool)) return null;
  const mutatedThisTurn = ledger.some(
    (row) => row.ok && row.effect === TOOL_EFFECT.stateChange,
  );
  if (mutatedThisTurn) {
    return fail(tool, {
      code: "APPROVAL_REQUIRED_AFTER_CHANGE",
      message:
        "I changed the plan in this same request, so I've built the updated preview instead of applying it. Tell me to apply it once you've looked.",
    });
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tool context                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} prisma
 * @param {any} input
 * @param {{ state: any; kind: string; logger: any }} extra
 */
async function buildToolContext(prisma, input, extra) {
  const constraints = await safeListConstraints(prisma, input);

  const ctx = {
    prisma,
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    conversationId: input.conversationId ?? null,
    actor: input.actor ?? input.merchantId,
    session: input.session ?? null,
    executeDeps: input.executeDeps,
    message: input.message,
    logger: extra.logger,
    kind: extra.kind,
    state: extra.state,
    constraints,

    async reloadState() {
      ctx.state = await resolveActionState(prisma, input);
      return ctx.state;
    },

    /** @param {string} command @param {Record<string, any>} params */
    async runCommand(command, params) {
      return executeActionCommand(prisma, {
        command,
        params,
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        actor: input.actor ?? input.merchantId,
        conversationId: input.conversationId ?? null,
        session: input.session ?? null,
        executeDeps: input.executeDeps,
        message: input.message,
        logger: extra.logger,
      });
    },

    /**
     * Run a domain command and describe it from the state diff rather than
     * from the handler's prose. What the reply may claim is decided here.
     *
     * @param {string} tool @param {string} command @param {Record<string, any>} params
     */
    async runCommandWithDiff(tool, command, params) {
      const before = { ...planFacts(ctx.state), lifecycle: ctx.state?.lifecycle ?? null };
      const executed = await ctx.runCommand(command, params);
      const after = await ctx.reloadState();
      const afterFacts = { ...planFacts(after), lifecycle: after?.lifecycle ?? null };
      const changes = diffFacts(before, afterFacts);

      if (!executed.ok) {
        return fail(tool, {
          code: String(executed.reason ?? "COMMAND_REJECTED").toUpperCase(),
          message: executed.reply ?? "I couldn't make that change.",
          retryable: false,
        });
      }

      const effect =
        command === ACTION_COMMAND.APPLY_CHANGESET
          ? TOOL_EFFECT.externalWrite
          : command === ACTION_COMMAND.CREATE_CHANGESET
            ? TOOL_EFFECT.artifact
            : TOOL_EFFECT.stateChange;

      if (effect === TOOL_EFFECT.stateChange && changes.length === 0) {
        return ok(tool, {
          effect: TOOL_EFFECT.read,
          message: "That was already the case — nothing needed changing.",
          facts: afterFacts,
        });
      }

      const proposal = buildCurrentProposal(after);

      return ok(tool, {
        effect,
        message: executed.reply ?? "",
        facts: { ...afterFacts, proposal: proposal.lines },
        changes,
        artifact:
          effect === TOOL_EFFECT.stateChange
            ? null
            : { type: proposal.type, title: proposal.title, lines: proposal.lines },
      });
    },

    /** @param {string} tool @param {string} capabilityRef */
    async reachCapabilityTool(tool, capabilityRef) {
      const result = await reachCapability(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        capabilityRef,
        actor: input.actor ?? input.merchantId,
        conversationId: input.conversationId ?? null,
        logger: extra.logger,
      });
      const after = await ctx.reloadState();
      return assistResultToTool(tool, result, after);
    },

    /**
     * Resolve a merchant's product reference against products this action
     * actually knows about. Ambiguity asks; it never guesses.
     *
     * @param {string} hint
     */
    resolveProductTitle(hint) {
      const wanted = normalizeMatch(hint ?? "");
      if (!wanted) return { title: null, ambiguous: false };
      const pool = [
        ...(ctx.state?.scope?.items ?? []).map((/** @type {any} */ item) => item.title),
        ...(ctx.state?.scope?.excluded ?? []).map((/** @type {any} */ item) => item.title),
      ]
        .map((title) => String(title ?? "").trim())
        .filter(Boolean);
      const unique = [...new Map(pool.map((title) => [normalizeMatch(title), title])).values()];
      const exact = unique.filter((title) => normalizeMatch(title) === wanted);
      if (exact.length === 1) return { title: exact[0], ambiguous: false };
      const partial = unique.filter((title) => {
        const normalized = normalizeMatch(title);
        return normalized.includes(wanted) || wanted.includes(normalized);
      });
      if (partial.length === 1) return { title: partial[0], ambiguous: false };
      if (partial.length > 1) {
        return {
          title: null,
          ambiguous: true,
          question: `Did you mean ${partial.slice(0, 3).map((title) => `"${title}"`).join(" or ")}?`,
          candidates: partial.slice(0, 4).map((title) => ({ label: title })),
        };
      }
      return { title: null, ambiguous: false };
    },

    /** @param {string} title */
    findExclusionConstraint(title) {
      const wanted = normalizeMatch(title);
      return (
        ctx.constraints.find((/** @type {any} */ row) => {
          const target = normalizeMatch(row.params?.title ?? row.label ?? "");
          return target === wanted || target.includes(wanted) || wanted.includes(target);
        }) ?? null
      );
    },

    async loadHistory() {
      return loadActionHistory(prisma, input);
    },
  };

  return ctx;
}

/** @param {any} prisma @param {any} input */
async function safeListConstraints(prisma, input) {
  try {
    return await listActionConstraints(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    });
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Revision history                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Persist what changed so "what changed from the original?" is answered from
 * structured history rather than from re-reading the transcript.
 *
 * @param {any} prisma
 * @param {any} input
 * @param {import("./tool-registry.server.js").ToolResult[]} ledger
 * @param {any} stateAfter
 * @param {any} logger
 */
async function recordRevisions(prisma, input, ledger, stateAfter, logger) {
  const changes = ledger.filter((row) => row.ok).flatMap((row) => row.changes ?? []);
  if (changes.length === 0) return;
  if (!prisma?.merchantAction?.findFirst || !prisma?.merchantAction?.update) return;
  try {
    const row = await prisma.merchantAction.findFirst({
      where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
      select: { id: true, progress: true },
    });
    if (!row) return;
    const progress =
      row.progress && typeof row.progress === "object" && !Array.isArray(row.progress)
        ? row.progress
        : {};
    const revisions = Array.isArray(progress.revisions) ? progress.revisions : [];
    revisions.push({
      at: new Date().toISOString(),
      changes,
      resulting: planFacts(stateAfter),
    });
    await prisma.merchantAction.update({
      where: { id: row.id },
      data: { progress: { ...progress, revisions: revisions.slice(-25) } },
    });
  } catch (error) {
    logger?.warn?.("could not record action revision", {
      actionId: input.actionId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/** @param {any} prisma @param {any} input */
async function loadActionHistory(prisma, input) {
  try {
    const row = await prisma.merchantAction.findFirst({
      where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
      select: { progress: true },
    });
    const progress =
      row?.progress && typeof row.progress === "object" && !Array.isArray(row.progress)
        ? row.progress
        : {};
    const revisions = Array.isArray(progress.revisions) ? progress.revisions : [];
    return revisions.map((/** @type {any} */ revision) => ({
      at: revision.at,
      changes: revision.changes,
      resulting: revision.resulting,
      summary: summarizeRevision(revision),
    }));
  } catch {
    return [];
  }
}

/** @param {any} revision */
function summarizeRevision(revision) {
  const resulting = revision?.resulting ?? {};
  const bits = [];
  if (resulting.coverDays != null) bits.push(`${resulting.coverDays}-day cover`);
  if (resulting.markdownPercent != null) bits.push(`${resulting.markdownPercent}% markdown`);
  if (Array.isArray(resulting.included) && resulting.included.length) {
    bits.push(resulting.included.join(" + "));
  }
  return bits.length ? `${bits.join(", ")}.` : "Plan updated.";
}

/* -------------------------------------------------------------------------- */
/* Model IO                                                                    */
/* -------------------------------------------------------------------------- */

/** @param {any} state */
function agentStateView(state) {
  if (!state) return null;
  return {
    ...snapshotFacts(state),
    action: state.action,
    lifecycle: state.lifecycle,
    plan: state.plan?.values ?? {},
    planFields: state.planSchema?.fields ?? [],
    constraints: (state.constraints ?? []).map((/** @type {any} */ row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
    })),
    currentChangeSet: state.currentChangeSet ?? null,
  };
}

/** @param {import("./tool-registry.server.js").ToolResult} result */
function publicToolResult(result) {
  return {
    tool: result.tool,
    ok: result.ok,
    effect: result.effect,
    message: result.message,
    facts: result.facts,
    changes: result.changes,
    artifact: result.artifact,
    error: result.error,
    blocked: result.blocked,
  };
}

/**
 * @param {any} raw
 * @param {string[]} availableTools
 */
export function parseAgentTurn(raw, availableTools) {
  const empty = {
    intent: null,
    toolCalls: /** @type {Array<{ tool: string; arguments: Record<string, any> }>} */ ([]),
    rejectedTools: /** @type {string[]} */ ([]),
    done: true,
    finalReply: null,
    requiresClarification: false,
    clarificationQuestion: null,
    routing: "focused",
    confidence: 0,
  };
  if (!raw || typeof raw !== "object") return empty;

  /** @type {Array<{ tool: string; arguments: Record<string, any> }>} */
  const toolCalls = [];
  /** @type {string[]} */
  const rejectedTools = [];
  for (const row of Array.isArray(raw.toolCalls) ? raw.toolCalls : []) {
    const tool = String(row?.tool ?? "").trim();
    if (!tool) continue;
    if (!availableTools.includes(tool)) {
      rejectedTools.push(tool);
      continue;
    }
    toolCalls.push({
      tool,
      arguments:
        row?.arguments && typeof row.arguments === "object" && !Array.isArray(row.arguments)
          ? stripNulls(row.arguments)
          : {},
    });
  }

  return {
    intent: typeof raw.intent === "string" ? raw.intent.slice(0, 300) : null,
    toolCalls,
    rejectedTools,
    done: raw.done === true,
    finalReply: typeof raw.finalReply === "string" && raw.finalReply.trim() ? raw.finalReply.trim() : null,
    requiresClarification: raw.requiresClarification === true,
    clarificationQuestion:
      typeof raw.clarificationQuestion === "string" && raw.clarificationQuestion.trim()
        ? raw.clarificationQuestion.trim()
        : null,
    routing: raw.routing === "general_store" ? "general_store" : "focused",
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.5,
  };
}

/** @param {Record<string, any>} value */
function stripNulls(value) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    out[key] = item;
  }
  return out;
}

/** @param {any} value */
function stableJson(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value ?? null);
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key];
        return acc;
      }, /** @type {Record<string, any>} */ ({})),
  );
}

export { TURN_OUTCOME, toolEffect };
