// @ts-check

/**
 * Focused-action semantic interpreter.
 *
 * Merchant natural language is understood here as a structured action plan.
 * Application code in action-command validates and executes; the model never
 * writes to Shopify, flips workflow status, or bypasses approval gates.
 *
 * Phrase matchers in plan-chat / action-command are not the product semantic
 * engine. They remain only as:
 * - button / explicit-command entry points
 * - a tiny LLM-down read-only fallback
 * - Stage B entity/step resolution helpers
 */

import { Type } from "@google/genai";
import { logger as baseLogger } from "../observability/logger.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  ACTION_COMMAND,
  executeActionCommand,
  executeActionPlan,
  isExplicitGeneralStoreQuestion,
  isMutationCommand,
} from "./action-command.server.js";
import { isActionStepStartCommand } from "./action-step-lifecycle.server.js";
import {
  listActionConstraints,
  normalizeChatText,
  normalizeMatch,
} from "./action-constraint.server.js";
import { recommendedPurchaseUnits } from "./action-capability.server.js";
import { resolveActionContext } from "./resolved-action-context.server.js";
import { getCurrentChangeSet } from "./action-changeset.server.js";
import {
  isAdvanceStepCommand,
  resolveStepTargetOrClarify,
} from "./action-workflow-navigation.server.js";

const log = baseLogger.child({ component: "action-interpreter" });

export const ACTION_INTERPRETER_VERSION = "1";

export const LLM_DOWN_INTERPRETER_REPLY =
  "I couldn't interpret that safely right now. You can use the step controls, or try again.";

/** Commands the model may propose. Unknown values are rejected in Stage B. */
export const ACTION_INTERPRETER_COMMANDS = Object.freeze([
  ACTION_COMMAND.ANSWER,
  ACTION_COMMAND.ACCEPT_PLAN,
  ACTION_COMMAND.REJECT_ACTION,
  ACTION_COMMAND.DEFER_ACTION,
  ACTION_COMMAND.ADD_CONSTRAINT,
  ACTION_COMMAND.REMOVE_CONSTRAINT,
  ACTION_COMMAND.REVISE_PLAN,
  ACTION_COMMAND.INSPECT_SCOPE,
  ACTION_COMMAND.INSPECT_PROPOSAL,
  ACTION_COMMAND.REPORT_EXECUTION,
  ACTION_COMMAND.START_STEP,
  ACTION_COMMAND.STOP_STEP,
  ACTION_COMMAND.ADVANCE_STEP,
  ACTION_COMMAND.GO_BACK,
  ACTION_COMMAND.GO_TO_STEP,
  ACTION_COMMAND.SKIP_STEP,
  ACTION_COMMAND.CREATE_CHANGESET,
  ACTION_COMMAND.APPLY_CHANGESET,
  ACTION_COMMAND.CONFIRM_MERCHANT_STEP,
  ACTION_COMMAND.NEEDS_CLARIFICATION,
  "INSPECT_ACTION",
  "RETRY_STEP",
  "REOPEN_STEP",
  "CREATE_ARTIFACT",
]);

const INTERPRETER_ALIASES = Object.freeze(/** @type {Record<string, string>} */ ({
  INSPECT_ACTION: ACTION_COMMAND.ANSWER,
  RETRY_STEP: ACTION_COMMAND.START_STEP,
  REOPEN_STEP: ACTION_COMMAND.GO_TO_STEP,
  CREATE_ARTIFACT: ACTION_COMMAND.CREATE_CHANGESET,
}));

const READ_ONLY_COMMANDS = new Set([
  ACTION_COMMAND.ANSWER,
  ACTION_COMMAND.INSPECT_SCOPE,
  ACTION_COMMAND.INSPECT_PROPOSAL,
  ACTION_COMMAND.REPORT_EXECUTION,
]);

const OPERATION_ARGUMENT_SCHEMA = {
  type: Type.OBJECT,
  nullable: true,
  properties: {
    coverDays: { type: Type.NUMBER, nullable: true },
    coverMonths: { type: Type.NUMBER, nullable: true },
    markdownPercent: { type: Type.NUMBER, nullable: true },
    maxProducts: { type: Type.NUMBER, nullable: true },
    constraintKind: { type: Type.STRING, nullable: true },
    productTitle: { type: Type.STRING, nullable: true },
    productHint: { type: Type.STRING, nullable: true },
    collectionTitle: { type: Type.STRING, nullable: true },
    tag: { type: Type.STRING, nullable: true },
    minInventory: { type: Type.NUMBER, nullable: true },
    minPrice: { type: Type.NUMBER, nullable: true },
    constraintLabel: { type: Type.STRING, nullable: true },
    constraintId: { type: Type.STRING, nullable: true },
    steps: { type: Type.NUMBER, nullable: true },
    targetHint: { type: Type.STRING, nullable: true },
    stepId: { type: Type.STRING, nullable: true },
    questionKind: { type: Type.STRING, nullable: true },
    simulate: { type: Type.BOOLEAN, nullable: true },
    scopeIntent: { type: Type.STRING, nullable: true },
    explicitApply: { type: Type.BOOLEAN, nullable: true },
    doNotMutate: { type: Type.BOOLEAN, nullable: true },
  },
};

export const ACTION_INTERPRETER_SCHEMA = {
  type: Type.OBJECT,
  required: ["operations", "requiresClarification", "confidence", "routing"],
  properties: {
    operations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["command"],
        properties: {
          command: { type: Type.STRING, enum: [...ACTION_INTERPRETER_COMMANDS] },
          arguments: OPERATION_ARGUMENT_SCHEMA,
        },
      },
    },
    requiresClarification: { type: Type.BOOLEAN },
    clarificationQuestion: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
    routing: { type: Type.STRING, enum: ["focused", "general_store"] },
    atomic: { type: Type.BOOLEAN, nullable: true },
    answerHint: { type: Type.STRING, nullable: true },
  },
};

const INTERPRETER_SYSTEM_PROMPT = [
  "You are Jefe's focused-action interpreter. Read the merchant's message against the supplied action state and return a structured action plan.",
  "Return only schema-constrained JSON. Do not narrate. Do not invent commands outside the enum.",
  "A message may contain several intentions. Emit every requested operation in order.",
  "The application validates and executes. You never write to Shopify, flip workflow status, or bypass approval.",
  "",
  "State-aware meaning:",
  "- 'Go ahead' on a proposed action usually means ACCEPT_PLAN (and START_STEP only if they also want the first step to run).",
  "- 'Go ahead' on an accepted action with a ready step means START_STEP.",
  "- 'Go ahead' / 'apply those changes' with a current approved Change Set means APPLY_CHANGESET.",
  "- 'Show me what you'd change but don't apply' is CREATE_CHANGESET or INSPECT_PROPOSAL, never APPLY_CHANGESET.",
  "",
  "Hypothetical vs imperative:",
  "- 'What would 60 days look like? Don't change it yet' is ANSWER with simulate=true and coverDays=60. Do not REVISE_PLAN.",
  "- 'What happens if we move on?' is ANSWER, not ADVANCE_STEP.",
  "- 'How would 90 days change the order?' is ANSWER simulate, not REVISE_PLAN.",
  "- 'Use 90 days' / 'Yeah, 90 is better. Use that.' is REVISE_PLAN.",
  "",
  "Negation:",
  "- 'Don't move on yet' must not ADVANCE_STEP.",
  "- 'Don't exclude Picnic' must not ADD_CONSTRAINT exclude Picnic. If Picnic is already excluded, REMOVE_CONSTRAINT.",
  "- 'I don't want to change the cover period' must not REVISE_PLAN coverDays.",
  "",
  "Questions mixed with commands: emit ANSWER first, then the mutation. Example: 'Why 120 days, and can we use 90 instead?' → ANSWER then REVISE_PLAN coverDays=90.",
  "",
  "Contextual references: resolve 'that', 'the other one', 'it', 'the previous step', 'the proposal' against known products, constraints, and workflow steps in the snapshot. Prefer productHint/targetHint over database ids.",
  "",
  "Scope:",
  "- 'Only replenish Pear' / 'Just Pear' → ADD_CONSTRAINT with scopeIntent=include_only and productHint Pear.",
  "- 'Leave Picnic out' / 'Don't include Picnic' → ADD_CONSTRAINT scopeIntent=exclude_product.",
  "- 'Put Picnic back in' / 'Add Picnic again' → ADD_CONSTRAINT scopeIntent=include_again or REMOVE_CONSTRAINT.",
  "- 'Exclude archived products' → ADD_CONSTRAINT constraintKind=exclude_archived.",
  "",
  "Navigation:",
  "- Move on / continue / proceed / we've finished this part → ADVANCE_STEP when they want the current step completed and the next unlocked. If the current step has not started, the runtime will not skip it; it will tell them to start.",
  "- Start the ready step / build it / go ahead and build it → START_STEP.",
  "- Go back / previous step → GO_BACK (set steps for 'two steps').",
  "- Go back to the inventory review / supplier bit / proposal → GO_TO_STEP with targetHint.",
  "- Skip this / I'll handle the supplier myself → SKIP_STEP.",
  "- If 'go back to the quantities' could mean calculation assumptions or the final proposal, set requiresClarification=true with a narrow question. Do not mutate.",
  "",
  "Routing: use general_store only for explicit store-wide questions that are not about this action (e.g. 'How many products do I sell overall?'). 'What are we proposing?' is focused INSPECT_PROPOSAL.",
  "",
  "Destructive operations (APPLY_CHANGESET, REJECT_ACTION) require explicit intent. When unsure, ask a clarification question instead of guessing.",
  "If the request is genuinely ambiguous, requiresClarification=true, clarificationQuestion set, operations empty.",
  "If they are only asking a focused question, operations=[{command:ANSWER}] or INSPECT_PROPOSAL / INSPECT_SCOPE / REPORT_EXECUTION as appropriate.",
].join("\n");

/**
 * Chat entry for a focused Merchant Action. Interprets the merchant message,
 * then executes the validated plan through Action Runtime.
 *
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
 *   provider?: { enabled?: boolean; provider?: string; model?: string; generateStructuredJson?: Function } | null;
 *   recentMessages?: Array<{ role?: string; content?: string }>;
 *   executeDeps?: any;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   classifyFallback?: ((message: string, context?: any) => { type: string; params?: Record<string, any> }) | null;
 * }} input
 */
export async function handleFocusedActionMessage(prisma, input) {
  const logger = input.logger ?? log;
  const message = normalizeChatText(input.message);
  const snapshot = await buildFocusedInterpreterSnapshot(prisma, input);
  if (!snapshot) {
    return {
      ok: false,
      routing: "focused",
      reply: "I couldn’t find that action. Open it again from home.",
      command: { type: ACTION_COMMAND.ANSWER, ok: false, reason: "not_found" },
    };
  }

  const pending = snapshot.pendingClarification;
  const followUp = pending ? resolveFollowUpClarification(message, pending, snapshot) : null;
  const interpretation = followUp
    ? followUp
    : await interpretActionMessage({
        provider: input.provider ?? null,
        message,
        snapshot,
        recentMessages: input.recentMessages ?? [],
        logger,
      });

  logger.info("action interpreter", {
    merchantMessageId: input.merchantMessageId ?? null,
    conversationId: input.conversationId ?? null,
    focusedActionId: input.actionId,
    interpreterModel: interpretation.model ?? null,
    interpreterVersion: ACTION_INTERPRETER_VERSION,
    interpretedOperations: (interpretation.rawOperations ?? interpretation.operations).map(summarizeOp),
    confidence: interpretation.confidence ?? null,
    requiresClarification: interpretation.requiresClarification === true,
    clarificationState: pending ? "pending" : "clear",
    routing: interpretation.routing,
    unavailable: interpretation.unavailable === true,
    resolvedActionVersion: snapshot.action?.updatedAt ?? null,
    planVersion: snapshot.plan?.version ?? null,
    constraintVersion: snapshot.constraintVersion ?? null,
    currentStep: snapshot.currentStep?.id ?? null,
  });

  if (interpretation.unavailable) {
    return handleInterpreterUnavailable(prisma, input, snapshot, message);
  }

  if (
    interpretation.routing !== "general_store" &&
    isExplicitGeneralStoreQuestion(message) &&
    (interpretation.operations ?? []).every(
      (op) => op.command === ACTION_COMMAND.ANSWER && !op.params?.simulate,
    )
  ) {
    interpretation.routing = "general_store";
  }

  if (interpretation.routing === "general_store") {
    return {
      ok: true,
      routing: "general_store",
      reply: "",
      command: { type: ACTION_COMMAND.ANSWER, ok: true, reason: "general_store" },
      interpretation,
    };
  }

  if (interpretation.requiresClarification) {
    await persistPendingInterpretation(prisma, snapshot.action, {
      kind: "interpretation",
      version: ACTION_INTERPRETER_VERSION,
      question: interpretation.clarificationQuestion,
      originalMessage: message,
      pendingOperations: interpretation.operations,
      candidates: interpretation.candidates ?? pending?.candidates ?? [],
      ambiguities: interpretation.ambiguities ?? [],
    });
    return {
      ok: true,
      routing: "focused",
      reply: interpretation.clarificationQuestion || "Which did you mean?",
      command: {
        type: ACTION_COMMAND.NEEDS_CLARIFICATION,
        ok: true,
        reason: null,
        interpretation,
      },
      interpretation,
    };
  }

  const resolved = resolveInterpretedOperations(interpretation.operations, snapshot);
  resolved.operations = coerceAdvanceIntent(message, resolved.operations);
  if (resolved.requiresClarification && resolved.operations.length === 0) {
    await persistPendingInterpretation(prisma, snapshot.action, {
      kind: "interpretation",
      version: ACTION_INTERPRETER_VERSION,
      question: resolved.clarificationQuestion,
      originalMessage: message,
      pendingOperations: resolved.operations,
      candidates: resolved.candidates ?? [],
      ambiguities: resolved.ambiguities ?? [],
    });
    return {
      ok: true,
      routing: "focused",
      reply: resolved.clarificationQuestion || "Which did you mean?",
      command: {
        type: ACTION_COMMAND.NEEDS_CLARIFICATION,
        ok: true,
        reason: null,
        interpretation,
      },
      interpretation,
    };
  }

  const executed = await executeActionPlan(prisma, {
    operations: resolved.operations,
    atomic: interpretation.atomic === true,
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    actor: input.actor ?? input.merchantId,
    conversationId: input.conversationId ?? null,
    session: input.session ?? null,
    executeDeps: input.executeDeps,
    message,
    logger,
  });

  if (resolved.requiresClarification) {
    await persistPendingInterpretation(prisma, snapshot.action, {
      kind: "interpretation",
      version: ACTION_INTERPRETER_VERSION,
      question: resolved.clarificationQuestion,
      originalMessage: message,
      pendingOperations: [],
      candidates: resolved.candidates ?? [],
      ambiguities: resolved.ambiguities ?? [],
    });
    return {
      ok: true,
      routing: "focused",
      reply: [executed.reply, resolved.clarificationQuestion].filter(Boolean).join(" "),
      command: {
        type: ACTION_COMMAND.NEEDS_CLARIFICATION,
        ok: true,
        reason: null,
        operations: (executed.results ?? []).map((/** @type {any} */ row) => row.command),
        interpretation,
      },
      interpretation,
      result: executed,
    };
  }

  await clearPendingInterpretation(prisma, snapshot.action);

  logger.info("action interpreter executed", {
    merchantMessageId: input.merchantMessageId ?? null,
    conversationId: input.conversationId ?? null,
    focusedActionId: input.actionId,
    validatedOperations: (executed.results ?? []).filter((/** @type {any} */ row) => row.ok).map((/** @type {any} */ row) => row.command),
    rejectedOperations: (executed.results ?? []).filter((/** @type {any} */ row) => !row.ok).map((/** @type {any} */ row) => ({
      command: row.command,
      reason: row.reason ?? null,
    })),
    executionOk: executed.ok,
  });

  return {
    ok: executed.ok,
    routing: "focused",
    reply: executed.reply,
    command: {
      type: executed.command,
      ok: executed.ok,
      reason: executed.reason ?? null,
      operations: (executed.results ?? []).map((/** @type {any} */ row) => row.command),
      interpretation,
    },
    interpretation,
    result: executed,
  };
}

/**
 * Stage A: structured LLM interpretation. Does not mutate state.
 *
 * @param {{
 *   provider?: { enabled?: boolean; provider?: string; model?: string; generateStructuredJson?: Function } | null;
 *   message: string;
 *   snapshot: any;
 *   recentMessages?: Array<{ role?: string; content?: string }>;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function interpretActionMessage(input) {
  const logger = input.logger ?? log;
  const provider = input.provider;
  if (!provider?.enabled || typeof provider.generateStructuredJson !== "function") {
    return unavailableInterpretation();
  }
  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: INTERPRETER_SYSTEM_PROMPT,
      prompt: JSON.stringify({
        merchantMessage: input.message,
        pendingClarification: input.snapshot?.pendingClarification ?? null,
        recentMessages: (input.recentMessages ?? []).slice(-8),
        focusedAction: buildInterpreterModelContext(input.snapshot),
      }),
      schema: ACTION_INTERPRETER_SCHEMA,
      maxOutputTokens: 700,
    });
    const parsed = parseInterpretedPlan(result.json);
    return {
      ...parsed,
      rawOperations: parsed.operations,
      model: result.model ?? provider.model ?? null,
      provider: result.provider ?? provider.provider ?? null,
      unavailable: false,
    };
  } catch (error) {
    logger.warn("action interpreter unavailable", {
      error: error instanceof Error ? error.name : "UnknownError",
      provider: provider.provider ?? null,
      model: provider.model ?? null,
    });
    return unavailableInterpretation(provider);
  }
}

/**
 * Validate and normalize raw model JSON. Hallucinated commands become ANSWER.
 * @param {any} raw
 */
export function parseInterpretedPlan(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyFocusedPlan();
  }
  const routing = raw.routing === "general_store" ? "general_store" : "focused";
  const requiresClarification = raw.requiresClarification === true;
  const clarificationQuestion =
    typeof raw.clarificationQuestion === "string" && raw.clarificationQuestion.trim()
      ? raw.clarificationQuestion.trim()
      : null;
  const confidence = finite01(raw.confidence);
  const operations = Array.isArray(raw.operations)
    ? raw.operations.map(parseInterpretedOperation).filter(Boolean)
    : [];
  if (requiresClarification) {
    return {
      operations: [],
      requiresClarification: true,
      clarificationQuestion: clarificationQuestion || "Which did you mean?",
      confidence,
      routing: "focused",
      atomic: raw.atomic === true,
      answerHint: stringOrNull(raw.answerHint),
    };
  }
  return {
    operations: operations.length > 0 ? operations : [{ command: ACTION_COMMAND.ANSWER, params: {} }],
    requiresClarification: false,
    clarificationQuestion: null,
    confidence,
    routing,
    atomic: raw.atomic === true,
    answerHint: stringOrNull(raw.answerHint),
  };
}

/**
 * Stage B: resolve hints against known products, steps, and constraints.
 * @param {Array<{ command: string; params: Record<string, any> }>} operations
 * @param {any} snapshot
 */
export function resolveInterpretedOperations(operations, snapshot) {
  /** @type {Array<{ command: string; params: Record<string, any> }>} */
  const resolved = [];
  /** @type {any} */
  let clarification = null;

  for (const operation of operations ?? []) {
    const mapped = mapInterpreterCommand(operation);
    if (!mapped) continue;
    if (mapped.params?.doNotMutate || mapped.params?.simulate) {
      if (isMutationCommand(mapped.command) && mapped.command !== ACTION_COMMAND.CREATE_CHANGESET) {
        resolved.push({
          command: ACTION_COMMAND.ANSWER,
          params: { ...mapped.params, simulate: true, questionKind: "simulate" },
        });
        continue;
      }
    }
    if (mapped.command === ACTION_COMMAND.ADD_CONSTRAINT || mapped.command === ACTION_COMMAND.REMOVE_CONSTRAINT) {
      const scoped = resolveConstraintOperation(mapped, snapshot);
      if (scoped.ambiguous) {
        clarification = scoped;
        break;
      }
      resolved.push(scoped.operation);
      continue;
    }
    if (mapped.command === ACTION_COMMAND.GO_TO_STEP) {
      const nav = resolveNavigationOperation(mapped, snapshot);
      if (nav.ambiguous) {
        clarification = nav;
        break;
      }
      resolved.push(nav.operation);
      continue;
    }
    if (mapped.command === ACTION_COMMAND.REVISE_PLAN) {
      resolved.push(resolveRevisionOperation(mapped));
      continue;
    }
    resolved.push(mapped);
  }

  const policyApplied = applyInterpreterPolicies(resolved);

  if (clarification?.ambiguous) {
    return {
      operations: policyApplied,
      requiresClarification: true,
      clarificationQuestion: clarification.clarificationQuestion,
      candidates: clarification.candidates ?? [],
      ambiguities: clarification.ambiguities ?? [],
    };
  }
  return {
    operations: policyApplied.length > 0 ? policyApplied : [{ command: ACTION_COMMAND.ANSWER, params: {} }],
    requiresClarification: false,
    clarificationQuestion: null,
  };
}

/**
 * Resolve a follow-up against a pending clarification without calling the LLM.
 * @param {string} message
 * @param {any} pending
 * @param {any} snapshot
 */
export function resolveFollowUpClarification(message, pending, snapshot) {
  if (!pending) return null;
  const text = normalizeChatText(message).toLowerCase();
  if (!text) return null;
  const candidates = Array.isArray(pending.candidates) ? pending.candidates : [];
  if (candidates.length > 0) {
    const matched = matchClarificationCandidate(text, candidates);
    if (matched) {
      const hint = matched.hint ?? matched.label ?? "";
      const command = pending.intent ?? ACTION_COMMAND.GO_TO_STEP;
      return {
        operations: [
          {
            command,
            params: {
              targetHint: hint,
              stepId: matched.stepId ?? null,
            },
          },
        ],
        requiresClarification: false,
        clarificationQuestion: null,
        confidence: 0.9,
        routing: "focused",
        atomic: false,
        model: "clarification-follow-up",
        unavailable: false,
      };
    }
  }
  return null;
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; conversationId?: string | null }} input
 */
export async function buildFocusedInterpreterSnapshot(prisma, input) {
  const action = await getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  });
  if (!action) return null;
  const [resolved, constraints, changeSet] = await Promise.all([
    resolveActionContext(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      conversationId: input.conversationId ?? null,
    }),
    listActionConstraints(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    }),
    getCurrentChangeSet(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    }),
  ]);
  const steps = uniqueSteps([
    ...(Array.isArray(action.workflow?.steps) ? action.workflow.steps : []),
    ...(Array.isArray(action.displaySteps) ? action.displaySteps : []),
  ]);
  const currentStep =
    action.currentStep ??
    steps.find((step) =>
      ["ready", "running", "needs_merchant", "needs_attention", "needs_updating"].includes(
        String(step.status ?? ""),
      ),
    ) ??
    null;
  const progress = jsonObject(action.progress);
  return {
    action,
    resolved,
    plan: resolved?.plan ?? { values: jsonObject(action.plan) },
    constraintVersion: resolved?.constraintVersion ?? null,
    steps,
    currentStep,
    constraints,
    scopeItems: Array.isArray(resolved?.scope?.items) ? resolved.scope.items : [],
    excluded: Array.isArray(resolved?.scope?.excluded) ? resolved.scope.excluded : [],
    currentChangeSet: changeSet ?? null,
    pendingClarification: progress.pendingInterpretation ?? progress.pendingNavigation ?? null,
  };
}

/** @param {any} snapshot */
export function buildInterpreterModelContext(snapshot) {
  const planValues = snapshot?.plan?.values ?? jsonObject(snapshot?.action?.plan);
  return {
    title: snapshot?.action?.title ?? null,
    actionType: snapshot?.action?.actionType ?? null,
    status: snapshot?.action?.status ?? null,
    plan: planValues,
    currentStep: snapshot?.currentStep
      ? {
          id: snapshot.currentStep.id ?? null,
          title: snapshot.currentStep.title ?? null,
          status: snapshot.currentStep.status ?? null,
          mode: snapshot.currentStep.mode ?? null,
        }
      : null,
    workflow: (snapshot?.steps ?? []).map((/** @type {any} */ step, /** @type {number} */ index) => ({
      id: step.id ?? null,
      order: index + 1,
      title: step.title ?? null,
      status: step.status ?? null,
      mode: step.mode ?? null,
    })),
    productsInScope: (snapshot?.scopeItems ?? []).map((/** @type {any} */ item) => ({
      title: item.title ?? item.productTitle ?? null,
      recommendedUnits: item.recommendedUnits ?? item.after ?? null,
    })),
    excludedProducts: (snapshot?.excluded ?? []).map((/** @type {any} */ item) => ({
      title: item.title ?? null,
      reason: item.reason ?? null,
    })),
    activeConstraints: (snapshot?.constraints ?? []).map((/** @type {any} */ row) => ({
      id: row.id ?? null,
      kind: row.kind ?? null,
      label: row.label ?? null,
      title: row.params?.title ?? null,
    })),
    currentChangeSet: snapshot?.currentChangeSet
      ? {
          id: snapshot.currentChangeSet.id ?? snapshot.currentChangeSet?.id ?? null,
          status: snapshot.currentChangeSet.status ?? null,
          itemCount: Array.isArray(snapshot.currentChangeSet.items)
            ? snapshot.currentChangeSet.items.length
            : null,
        }
      : null,
    capabilities: [...ACTION_INTERPRETER_COMMANDS],
  };
}

/** @param {any} prisma @param {any} input @param {any} snapshot @param {string} message */
async function handleInterpreterUnavailable(prisma, input, snapshot, message) {
  const fallback = input.classifyFallback
    ? input.classifyFallback(message, {
        hasReadyChangeSet: Boolean(snapshot.currentChangeSet),
        actionStatus: snapshot.action?.status ?? null,
        pendingNavigation: snapshot.pendingClarification,
      })
    : null;
  const type = fallback?.type ?? ACTION_COMMAND.ANSWER;
  if (fallback && READ_ONLY_COMMANDS.has(type)) {
    const executed = await executeActionCommand(prisma, {
      command: type,
      params: fallback.params ?? {},
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      actor: input.actor ?? input.merchantId,
      conversationId: input.conversationId ?? null,
      message,
      logger: input.logger ?? log,
    });
    return {
      ok: executed.ok,
      routing: "focused",
      reply: executed.reply,
      command: {
        type: executed.command,
        ok: executed.ok,
        reason: executed.reason ?? "llm_down_readonly_fallback",
      },
      unavailable: true,
    };
  }
  return {
    ok: true,
    routing: "focused",
    reply: LLM_DOWN_INTERPRETER_REPLY,
    command: {
      type: ACTION_COMMAND.ANSWER,
      ok: true,
      reason: "interpreter_unavailable",
    },
    unavailable: true,
  };
}

/** @param {any} operation */
function parseInterpretedOperation(operation) {
  if (!operation || typeof operation !== "object") return null;
  const rawCommand = String(operation.command ?? operation.type ?? "").trim().toUpperCase();
  if (!rawCommand || rawCommand === "DELETE_STORE") return null;
  if (!ACTION_INTERPRETER_COMMANDS.includes(rawCommand) && !(rawCommand in ACTION_COMMAND)) {
    return null;
  }
  const args = operation.arguments ?? operation.params ?? {};
  return {
    command: rawCommand,
    params: {
      coverDays: finiteOrNull(args.coverDays),
      coverMonths: finiteOrNull(args.coverMonths),
      markdownPercent: finiteOrNull(args.markdownPercent),
      maxProducts: finiteOrNull(args.maxProducts),
      constraintKind: stringOrNull(args.constraintKind),
      productTitle: stringOrNull(args.productTitle ?? args.title),
      productHint: stringOrNull(args.productHint),
      collectionTitle: stringOrNull(args.collectionTitle),
      tag: stringOrNull(args.tag),
      minInventory: finiteOrNull(args.minInventory),
      minPrice: finiteOrNull(args.minPrice ?? args.amount),
      constraintLabel: stringOrNull(args.constraintLabel),
      constraintId: stringOrNull(args.constraintId),
      steps: finiteOrNull(args.steps),
      targetHint: stringOrNull(args.targetHint),
      stepId: stringOrNull(args.stepId),
      questionKind: stringOrNull(args.questionKind),
      simulate: args.simulate === true,
      scopeIntent: stringOrNull(args.scopeIntent ?? args.intent),
      explicitApply: args.explicitApply === true,
      doNotMutate: args.doNotMutate === true,
    },
  };
}

/** @param {{ command: string; params: Record<string, any> }} operation */
function mapInterpreterCommand(operation) {
  const aliased = INTERPRETER_ALIASES[operation.command] ?? operation.command;
  if (aliased === "INSPECT_ACTION" || operation.command === "INSPECT_ACTION") {
    return {
      command: ACTION_COMMAND.ANSWER,
      params: { ...operation.params, questionKind: operation.params.questionKind ?? "recap" },
    };
  }
  if (!(Object.values(ACTION_COMMAND)).includes(aliased)) return null;
  if (operation.command === "RETRY_STEP") {
    return { command: ACTION_COMMAND.START_STEP, params: operation.params };
  }
  if (operation.command === "REOPEN_STEP") {
    return { command: ACTION_COMMAND.GO_TO_STEP, params: operation.params };
  }
  return { command: aliased, params: operation.params };
}

/**
 * "Move to the next step" is not a recap, and it is not a silent start.
 * Route it through ADVANCE_STEP so the runtime can advise if the current
 * step has not started yet.
 *
 * @param {string} message
 * @param {Array<{ command: string; params?: Record<string, any> }>} operations
 */
function coerceAdvanceIntent(message, operations) {
  if (!isAdvanceStepCommand(message) || isActionStepStartCommand(message)) {
    return operations;
  }
  const list = Array.isArray(operations) ? operations : [];
  if (list.length === 0) {
    return [{ command: ACTION_COMMAND.ADVANCE_STEP, params: {} }];
  }
  if (
    list.length === 1 &&
    (list[0].command === ACTION_COMMAND.ANSWER || list[0].command === ACTION_COMMAND.START_STEP)
  ) {
    return [{ command: ACTION_COMMAND.ADVANCE_STEP, params: {} }];
  }
  return list;
}

/** @param {{ command: string; params: Record<string, any> }} operation @param {any} snapshot */
function resolveConstraintOperation(operation, snapshot) {
  const params = { ...operation.params };
  const hint = params.productHint ?? params.productTitle ?? params.constraintLabel ?? "";
  const intent = params.scopeIntent;
  const products = knownProducts(snapshot);

  if (params.constraintKind === "exclude_archived" || intent === "exclude_archived") {
    return {
      ambiguous: false,
      operation: {
        command: ACTION_COMMAND.ADD_CONSTRAINT,
        params: { constraintKind: "exclude_archived", constraintLabel: "Exclude archived products" },
      },
    };
  }

  if (intent === "include_only" || intent === "exclude_product" || intent === "include_again") {
    const matched = resolveProductReference(hint, products, snapshot, intent);
    if (matched.ambiguous) return matched;
    if (!matched.product) {
      return {
        ambiguous: true,
        clarificationQuestion: hint
          ? `I wasn't sure which product "${hint}" refers to. Which one should I change?`
          : "Which product should I include or exclude?",
        candidates: products.slice(0, 4).map((item) => ({
          label: item.title,
          hint: item.title,
        })),
      };
    }
    return {
      ambiguous: false,
      operation: {
        command: ACTION_COMMAND.ADD_CONSTRAINT,
        params: {
          scopeModification: { intent, title: matched.product.title },
          productTitle: matched.product.title,
        },
      },
    };
  }

  if (operation.command === ACTION_COMMAND.REMOVE_CONSTRAINT) {
    const constraints = snapshot?.constraints ?? [];
    if (params.constraintId) {
      return { ambiguous: false, operation };
    }
    const wanted = normalizeMatch(hint);
    const matches = constraints.filter((/** @type {any} */ row) => {
      const title = normalizeMatch(row.params?.title ?? row.label ?? "");
      return wanted && (title === wanted || title.includes(wanted) || wanted.includes(title));
    });
    if (matches.length === 1) {
      return {
        ambiguous: false,
        operation: {
          command: ACTION_COMMAND.REMOVE_CONSTRAINT,
          params: { constraintId: matches[0].id, productTitle: matches[0].params?.title },
        },
      };
    }
    if (matches.length === 0 && constraints.length === 1) {
      return {
        ambiguous: false,
        operation: {
          command: ACTION_COMMAND.REMOVE_CONSTRAINT,
          params: { constraintId: constraints[0].id },
        },
      };
    }
    if (constraints.length > 1 && !wanted) {
      return {
        ambiguous: true,
        clarificationQuestion: formatConstraintClarification(constraints),
        candidates: constraints.map((/** @type {any} */ row) => ({
          label: row.label,
          hint: row.params?.title ?? row.label,
        })),
      };
    }
  }

  if (hint && !params.constraintKind) {
    const matched = resolveProductReference(hint, products, snapshot, "exclude_product");
    if (matched.ambiguous) return matched;
    if (matched.product) {
      return {
        ambiguous: false,
        operation: {
          command: ACTION_COMMAND.ADD_CONSTRAINT,
          params: {
            scopeModification: { intent: "exclude_product", title: matched.product.title },
            productTitle: matched.product.title,
          },
        },
      };
    }
  }

  return { ambiguous: false, operation };
}

/** @param {{ command: string; params: Record<string, any> }} operation @param {any} snapshot */
function resolveNavigationOperation(operation, snapshot) {
  const hint = operation.params.targetHint;
  if (operation.params.stepId) return { ambiguous: false, operation };
  if (!hint) return { ambiguous: false, operation };
  const steps = snapshot?.steps ?? [];
  const resolved = resolveStepTargetOrClarify(steps, hint);
  if (resolved.ambiguous) {
    return {
      ambiguous: true,
      clarificationQuestion: resolved.question,
      candidates: resolved.candidates,
    };
  }
  if (!resolved.step) {
    return { ambiguous: false, operation };
  }
  return {
    ambiguous: false,
    operation: {
      command: ACTION_COMMAND.GO_TO_STEP,
      params: { ...operation.params, stepId: resolved.step.id, targetHint: hint },
    },
  };
}

/** @param {{ command: string; params: Record<string, any> }} operation */
function resolveRevisionOperation(operation) {
  const params = { ...operation.params };
  if (params.coverDays == null && params.coverMonths != null) {
    params.coverDays = Math.round(Number(params.coverMonths) * 30);
  }
  return { command: ACTION_COMMAND.REVISE_PLAN, params };
}

/**
 * @param {Array<{ command: string; params: Record<string, any> }>} operations
 */
export function applyInterpreterPolicies(operations) {
  const hasDoNotMutate = operations.some(
    (op) => op.params?.simulate === true || op.params?.doNotMutate === true,
  );
  let next = operations;
  if (hasDoNotMutate) {
    next = operations
      .filter((op) => !isMutationCommand(op.command) || op.params?.simulate)
      .map((op) =>
        isMutationCommand(op.command)
          ? { command: ACTION_COMMAND.ANSWER, params: { ...op.params, simulate: true } }
          : op,
      );
  }
  const mutatesPlan = next.some((op) =>
    [ACTION_COMMAND.REVISE_PLAN, ACTION_COMMAND.ADD_CONSTRAINT, ACTION_COMMAND.REMOVE_CONSTRAINT].includes(
      op.command,
    ),
  );
  next = next.map((op) => {
    if (
      op.command === ACTION_COMMAND.APPLY_CHANGESET &&
      mutatesPlan &&
      op.params?.explicitApply !== true
    ) {
      return { command: ACTION_COMMAND.CREATE_CHANGESET, params: op.params };
    }
    return op;
  });
  return next;
}

/**
 * @param {string} hint
 * @param {Array<{ title: string }>} products
 * @param {any} snapshot
 * @param {string} intent
 */
export function resolveProductReference(hint, products, snapshot, intent) {
  const normalized = normalizeMatch(hint);
  const excluded = (snapshot?.excluded ?? [])
    .map((/** @type {any} */ item) => String(item.title ?? "").trim())
    .filter(Boolean);
  const inScope = (snapshot?.scopeItems ?? [])
    .map((/** @type {any} */ item) => String(item.title ?? item.productTitle ?? "").trim())
    .filter(Boolean);

  if (/other (?:one|wine|product)|the other\b/.test(String(hint ?? "").toLowerCase())) {
    if (intent === "include_again" && excluded.length === 1) {
      return { ambiguous: false, product: { title: excluded[0] } };
    }
    if (intent === "exclude_product" && inScope.length === 2) {
      return { ambiguous: false, product: { title: inScope[1] } };
    }
    if (inScope.length === 1 && excluded.length === 1 && intent === "include_again") {
      return { ambiguous: false, product: { title: excluded[0] } };
    }
  }

  if (!normalized) {
    if (intent === "include_again" && excluded.length === 1) {
      return { ambiguous: false, product: { title: excluded[0] } };
    }
    return { ambiguous: false, product: null };
  }

  const pool = uniqueTitles([...inScope, ...excluded, ...products.map((item) => item.title)]);
  const matches = pool.filter((title) => {
    const n = normalizeMatch(title);
    return n === normalized || n.includes(normalized) || normalized.includes(n);
  });
  if (matches.length === 1) return { ambiguous: false, product: { title: matches[0] } };
  if (matches.length > 1) {
    return {
      ambiguous: true,
      clarificationQuestion: `Did you mean ${matches.slice(0, 2).map((title) => `"${title}"`).join(" or ")}?`,
      candidates: matches.map((title) => ({ label: title, hint: title })),
    };
  }
  return { ambiguous: false, product: null };
}

/**
 * Cheap hypothetical quantities from resolved scope. Used by ANSWER simulate.
 * @param {any} snapshot
 * @param {{ coverDays?: number | null; markdownPercent?: number | null }} params
 */
export function formatSimulationReply(snapshot, params) {
  const currentCover = Number(snapshot?.plan?.values?.coverDays ?? snapshot?.action?.plan?.coverDays);
  const coverDays = Number(params.coverDays);
  const markdown = Number(params.markdownPercent);
  const items = snapshot?.scopeItems ?? [];
  if (Number.isFinite(coverDays) && coverDays > 0 && items.length > 0) {
    const lines = items
      .map((/** @type {any} */ item) => {
        const units = recommendedPurchaseUnits(
          {
            available: item.available ?? item.inventory ?? 0,
            dailyVelocity: item.dailyVelocity,
          },
          coverDays,
        );
        const title = item.title ?? item.productTitle ?? "Item";
        return units == null ? `• ${title}` : `• ${title} = ${units}`;
      })
      .join("\n");
    const kept = Number.isFinite(currentCover)
      ? ` The current plan is still ${currentCover} days.`
      : " I haven't changed the current plan.";
    return `If we used ${coverDays} days:\n${lines}.${kept}`;
  }
  if (Number.isFinite(markdown) && markdown >= 0) {
    return `A ${markdown}% markdown would change the current proposal. I haven't applied that yet.`;
  }
  return "I can show a hypothetical, but I need a cover period or markdown percent to calculate from.";
}

/** @param {string} text @param {any[]} candidates */
function matchClarificationCandidate(text, candidates) {
  if (
    /\bhow (?:they(?:'re| are) )?calculated\b/.test(text) ||
    /\bcalculation|assumptions|inventory review|cover period\b/.test(text)
  ) {
    return (
      candidates.find((candidate) =>
        /calculat|assumption|inventory|cover/.test(
          String(candidate.hint ?? candidate.label ?? "").toLowerCase(),
        ),
      ) ?? candidates[0]
    );
  }
  if (/\bproposal|final\b/.test(text)) {
    return (
      candidates.find((candidate) =>
        /proposal/.test(String(candidate.hint ?? candidate.label ?? "").toLowerCase()),
      ) ?? candidates[1] ?? null
    );
  }
  for (const candidate of candidates) {
    const label = String(candidate.label ?? "").toLowerCase();
    if (label && text.includes(label)) return candidate;
    const hint = String(candidate.hint ?? "").toLowerCase();
    if (hint && hint.length > 4 && text.includes(hint)) return candidate;
  }
  if (/\b(?:first|1|one|the calculation)\b/.test(text)) return candidates[0] ?? null;
  if (/\b(?:second|2)\b/.test(text)) return candidates[1] ?? null;
  return null;
}

/** @param {any} snapshot */
function knownProducts(snapshot) {
  const titles = uniqueTitles([
    ...(snapshot?.scopeItems ?? []).map((/** @type {any} */ item) => item.title ?? item.productTitle),
    ...(snapshot?.excluded ?? []).map((/** @type {any} */ item) => item.title),
  ]);
  return titles.map((title) => ({ title }));
}

/** @param {any[]} constraints */
function formatConstraintClarification(constraints) {
  const labels = constraints
    .slice(0, 2)
    .map((row) => row.label ?? row.params?.title)
    .filter(Boolean);
  if (labels.length >= 2) {
    return `Do you mean remove ${labels[0]} or change ${labels[1]}?`;
  }
  return "Which constraint should I remove?";
}

/** @param {any} prisma @param {any} action @param {any} pending */
async function persistPendingInterpretation(prisma, action, pending) {
  if (!prisma?.merchantAction?.update || !action?.id) return;
  const progress = jsonObject(action.progress);
  await prisma.merchantAction.update({
    where: { id: action.id },
    data: {
      progress: {
        ...progress,
        pendingInterpretation: pending,
        pendingNavigation: {
          intent: ACTION_COMMAND.GO_TO_STEP,
          question: pending.question,
          candidates: pending.candidates ?? [],
        },
      },
    },
  });
}

/** @param {any} prisma @param {any} action */
async function clearPendingInterpretation(prisma, action) {
  if (!prisma?.merchantAction?.update || !action?.id) return;
  const progress = jsonObject(action.progress);
  if (!progress.pendingInterpretation && !progress.pendingNavigation) return;
  const {
    pendingInterpretation: _pending,
    pendingNavigation: _nav,
    ...rest
  } = progress;
  await prisma.merchantAction.update({
    where: { id: action.id },
    data: { progress: rest },
  });
}

function emptyFocusedPlan() {
  return {
    operations: [{ command: ACTION_COMMAND.ANSWER, params: {} }],
    requiresClarification: false,
    clarificationQuestion: null,
    confidence: 0,
    routing: "focused",
    atomic: false,
    answerHint: null,
  };
}

/** @param {any} [provider] */
function unavailableInterpretation(provider) {
  return {
    ...emptyFocusedPlan(),
    unavailable: true,
    model: provider?.model ?? null,
    provider: provider?.provider ?? null,
  };
}

/** @param {{ command?: string; params?: Record<string, any> }} op */
function summarizeOp(op) {
  return {
    command: op.command,
    arguments: op.params ?? {},
  };
}

/** @param {any[]} steps */
function uniqueSteps(steps) {
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const step of steps) {
    const id = step?.id ?? step?.title;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(step);
  }
  return out.sort((left, right) => Number(left.orderIndex ?? 0) - Number(right.orderIndex ?? 0));
}

/** @param {unknown[]} titles */
function uniqueTitles(titles) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const title of titles) {
    const label = String(title ?? "").trim();
    if (!label) continue;
    const key = normalizeMatch(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function finite01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/** @param {unknown} value */
function stringOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export { isExplicitGeneralStoreQuestion };
