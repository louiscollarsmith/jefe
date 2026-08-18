// @ts-check

/**
 * Structured Action Runtime commands. Chat and UI buttons both land here.
 * The LLM may propose a command; application code validates state and executes
 * through lifecycle / Change Set / typed-adapter services. The model never
 * mutates Shopify or workflow status itself.
 */

import { logger as baseLogger } from "../observability/logger.server.js";
import {
  acceptMerchantActionPlan,
  completeCurrentActionStep,
  isPrimarilyQuestion,
  processReadyActionStepRuns,
  skipCurrentActionStep,
  startActionStep,
  stopActionStep,
} from "./action-step-lifecycle.server.js";
import { executeStartedAssistStepRun } from "./assist-steps/run.server.js";
import { rejectAction, reviseAction } from "./action-resolution.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  addActionConstraint,
  listActionConstraints,
  parseConstraintsFromMessage,
  removeActionConstraint,
  serializeConstraint,
  normalizeChatText,
} from "./action-constraint.server.js";
import {
  applyActionChangeSet,
  createActionChangeSet,
  formatChangeSetReply,
  formatExecutionResultReply,
  getCurrentChangeSet,
  getLatestChangeSet,
  isRestockAction,
  serializeChangeSet,
  staleLiveChangeSets,
} from "./action-changeset.server.js";
import {
  PLAN_CHAT_INTENT,
  buildPlanAcceptReply,
  buildPlanCompleteReply,
  buildPlanDeclineReply,
  buildPlanRecapReply,
  buildPlanScopeReply,
  buildPlanSkipReply,
  buildPlanStatusReply,
  buildPlanStopReply,
  classifyPlanChatIntent,
  extractPlanScopeItems,
} from "./plan-chat.server.js";

const log = baseLogger.child({ component: "action-command" });

export const ACTION_COMMAND = Object.freeze({
  ANSWER: "ANSWER",
  ACCEPT_PLAN: "ACCEPT_PLAN",
  REVISE_PLAN: "REVISE_PLAN",
  ADD_CONSTRAINT: "ADD_CONSTRAINT",
  REMOVE_CONSTRAINT: "REMOVE_CONSTRAINT",
  START_STEP: "START_STEP",
  STOP_STEP: "STOP_STEP",
  SKIP_STEP: "SKIP_STEP",
  DEFER_ACTION: "DEFER_ACTION",
  REJECT_ACTION: "REJECT_ACTION",
  CREATE_CHANGESET: "CREATE_CHANGESET",
  APPLY_CHANGESET: "APPLY_CHANGESET",
  CONFIRM_MERCHANT_STEP: "CONFIRM_MERCHANT_STEP",
  INSPECT_SCOPE: "INSPECT_SCOPE",
  REPORT_EXECUTION: "REPORT_EXECUTION",
});

/** @type {Set<string>} */
const MUTATION_COMMANDS = new Set([
  ACTION_COMMAND.ACCEPT_PLAN,
  ACTION_COMMAND.REVISE_PLAN,
  ACTION_COMMAND.ADD_CONSTRAINT,
  ACTION_COMMAND.REMOVE_CONSTRAINT,
  ACTION_COMMAND.START_STEP,
  ACTION_COMMAND.STOP_STEP,
  ACTION_COMMAND.SKIP_STEP,
  ACTION_COMMAND.DEFER_ACTION,
  ACTION_COMMAND.REJECT_ACTION,
  ACTION_COMMAND.CREATE_CHANGESET,
  ACTION_COMMAND.APPLY_CHANGESET,
  ACTION_COMMAND.CONFIRM_MERCHANT_STEP,
]);

const COMMAND_ALIASES = Object.freeze(/** @type {Record<string, string>} */ ({
  accept: ACTION_COMMAND.ACCEPT_PLAN,
  start: ACTION_COMMAND.START_STEP,
  stop: ACTION_COMMAND.STOP_STEP,
  skip: ACTION_COMMAND.SKIP_STEP,
  complete: ACTION_COMMAND.CONFIRM_MERCHANT_STEP,
  decline: ACTION_COMMAND.REJECT_ACTION,
  retry: ACTION_COMMAND.START_STEP,
  scope: ACTION_COMMAND.INSPECT_SCOPE,
  recap: ACTION_COMMAND.ANSWER,
  status: ACTION_COMMAND.ANSWER,
  question: ACTION_COMMAND.ANSWER,
}));

/**
 * @param {string} message
 * @param {{ hasReadyChangeSet?: boolean; actionStatus?: string | null }} [context]
 */
export function classifyActionCommand(message, context = {}) {
  const text = normalizeChatText(message);
  if (!text) return { type: ACTION_COMMAND.ANSWER, params: {} };

  if (isCreateChangeSetAsk(text)) {
    return { type: ACTION_COMMAND.CREATE_CHANGESET, params: {} };
  }
  if (isExecutionReportAsk(text)) {
    return { type: ACTION_COMMAND.REPORT_EXECUTION, params: {} };
  }
  if (/\blooks good\b/i.test(text) && !isPrimarilyQuestion(text)) {
    return { type: ACTION_COMMAND.ACCEPT_PLAN, params: {} };
  }

  if (!isPrimarilyQuestion(text)) {
    const constraints = parseConstraintsFromMessage(text);
    if (constraints.length > 0) {
      return { type: ACTION_COMMAND.ADD_CONSTRAINT, params: { constraints } };
    }
    const revision = parsePlanRevision(text);
    if (revision) {
      return { type: ACTION_COMMAND.REVISE_PLAN, params: revision };
    }
    if (isDeferCommand(text)) {
      return { type: ACTION_COMMAND.DEFER_ACTION, params: {} };
    }
    if (isRemoveConstraintCommand(text)) {
      return { type: ACTION_COMMAND.REMOVE_CONSTRAINT, params: parseRemoveConstraint(text) };
    }
  }

  if (isInspectScopeAsk(text)) {
    return { type: ACTION_COMMAND.INSPECT_SCOPE, params: {} };
  }

  const planIntent = classifyPlanChatIntent(text);
  if (planIntent === PLAN_CHAT_INTENT.start || planIntent === PLAN_CHAT_INTENT.retry) {
    if (context.hasReadyChangeSet) {
      return { type: ACTION_COMMAND.APPLY_CHANGESET, params: {} };
    }
    return { type: ACTION_COMMAND.START_STEP, params: {} };
  }
  if (planIntent === PLAN_CHAT_INTENT.scope) {
    return { type: ACTION_COMMAND.INSPECT_SCOPE, params: {} };
  }
  const mapped = COMMAND_ALIASES[planIntent];
  if (mapped && mapped !== ACTION_COMMAND.ANSWER) {
    return { type: mapped, params: {} };
  }
  return {
    type: ACTION_COMMAND.ANSWER,
    params: { questionKind: planIntent === PLAN_CHAT_INTENT.question ? null : planIntent },
  };
}

/**
 * Normalize an LLM-proposed command. Unknown types become ANSWER.
 * @param {any} raw
 */
export function parseProposedCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = normalizeCommandType(raw.type ?? raw.planIntent);
  if (!type) return null;
  return {
    type,
    params: {
      markdownPercent: finiteOrNull(raw.markdownPercent ?? raw.params?.markdownPercent),
      coverDays: finiteOrNull(raw.coverDays ?? raw.params?.coverDays),
      maxProducts: finiteOrNull(raw.maxProducts ?? raw.params?.maxProducts),
      constraintKind: stringOrNull(raw.constraintKind ?? raw.params?.constraintKind),
      collectionTitle: stringOrNull(raw.collectionTitle ?? raw.params?.collectionTitle),
      tag: stringOrNull(raw.tag ?? raw.params?.tag),
      minInventory: finiteOrNull(raw.minInventory ?? raw.params?.minInventory),
      minPrice: finiteOrNull(raw.minPrice ?? raw.params?.minPrice ?? raw.params?.amount),
      constraintLabel: stringOrNull(raw.constraintLabel ?? raw.params?.constraintLabel),
      constraintId: stringOrNull(raw.constraintId ?? raw.params?.constraintId),
      stepId: stringOrNull(raw.stepId ?? raw.params?.stepId),
      constraints: Array.isArray(raw.constraints) ? raw.constraints : undefined,
    },
  };
}

/** @param {string} type */
export function isMutationCommand(type) {
  return MUTATION_COMMANDS.has(type);
}

/**
 * Single entry point for buttons and chat.
 *
 * @param {any} prisma
 * @param {{
 *   command: string;
 *   params?: Record<string, any>;
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   actor?: string | null;
 *   conversationId?: string | null;
 *   session?: { shop: string } | null;
 *   executeDeps?: any;
 *   message?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 * @returns {Promise<{
 *   ok: boolean;
 *   command: string;
 *   reply: string;
 *   reason?: string | null;
 *   result?: any;
 *   action?: any;
 *   changeSet?: any;
 *   assistOnly?: boolean;
 * }>}
 */
export async function executeActionCommand(prisma, input) {
  const logger = input.logger ?? log;
  const command = normalizeCommandType(input.command) ?? ACTION_COMMAND.ANSWER;
  const params = input.params ?? {};
  const action = await getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  });
  if (!action) {
    return {
      ok: false,
      command,
      reason: "not_found",
      reply: "I couldn’t find that action. Open it again from home.",
    };
  }

  logger.info("action command", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    command,
  });

  switch (command) {
    case ACTION_COMMAND.ACCEPT_PLAN:
      return runAcceptPlan(prisma, { ...input, action, logger });
    case ACTION_COMMAND.REVISE_PLAN:
      return runRevisePlan(prisma, { ...input, action, params, logger });
    case ACTION_COMMAND.ADD_CONSTRAINT:
      return runAddConstraint(prisma, { ...input, action, params, logger });
    case ACTION_COMMAND.REMOVE_CONSTRAINT:
      return runRemoveConstraint(prisma, { ...input, action, params, logger });
    case ACTION_COMMAND.START_STEP:
      return runStartStep(prisma, { ...input, action, params, logger });
    case ACTION_COMMAND.STOP_STEP:
      return runStopStep(prisma, { ...input, action, logger });
    case ACTION_COMMAND.SKIP_STEP:
      return runSkipStep(prisma, { ...input, action, logger });
    case ACTION_COMMAND.DEFER_ACTION:
      return runDeferAction(prisma, { ...input, action, logger });
    case ACTION_COMMAND.REJECT_ACTION:
      return runRejectAction(prisma, { ...input, action, logger });
    case ACTION_COMMAND.CREATE_CHANGESET:
      return runCreateChangeSet(prisma, { ...input, action, logger });
    case ACTION_COMMAND.APPLY_CHANGESET:
      return runApplyChangeSet(prisma, { ...input, action, logger });
    case ACTION_COMMAND.CONFIRM_MERCHANT_STEP:
      return runConfirmMerchantStep(prisma, { ...input, action, logger });
    case ACTION_COMMAND.INSPECT_SCOPE:
      return runInspectScope(prisma, { ...input, action, logger });
    case ACTION_COMMAND.REPORT_EXECUTION:
      return runReportExecution(prisma, { ...input, action, logger });
    default:
      return runAnswer(action, params);
  }
}

/** @param {any} prisma @param {any} input */
async function runAcceptPlan(prisma, input) {
  const result = await acceptMerchantActionPlan(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.ACCEPT_PLAN,
    reason: result.ok ? null : result.reason,
    result,
    reply: buildPlanAcceptReply(fresh ?? input.action, result),
    action: fresh ?? input.action,
  };
}

/** @param {any} prisma @param {any} input */
async function runRevisePlan(prisma, input) {
  const planPatch = planPatchFromParams(input.params);
  if (Object.keys(planPatch).length === 0) {
    return {
      ok: false,
      command: ACTION_COMMAND.REVISE_PLAN,
      reason: "no_revision",
      reply: "Tell me which number to change — for example the markdown percent, cover days, or how many products.",
    };
  }
  await persistActionPlan(prisma, input, planPatch);
  await staleLiveChangeSets(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });

  let reviseResult = null;
  if (input.action.actionRunId && (planPatch.markdownPercent != null || planPatch.maxProducts != null)) {
    try {
      reviseResult = await reviseAction(prisma, {
        merchantId: input.merchantId,
        actionRunId: input.action.actionRunId,
        params: {
          ...(planPatch.markdownPercent != null ? { markdownPercent: planPatch.markdownPercent } : {}),
          ...(planPatch.maxProducts != null ? { maxProducts: planPatch.maxProducts } : {}),
        },
      });
    } catch {
      reviseResult = { status: "unavailable" };
    }
  }

  const fresh = await refreshAction(prisma, input);
  const changeSet = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor,
    logger: input.logger,
  });
  return {
    ok: true,
    command: ACTION_COMMAND.REVISE_PLAN,
    result: { plan: planPatch, revise: reviseResult, changeSet: createdChangeSet(changeSet) },
    reply: buildReviseReply(fresh ?? input.action, planPatch, changeSet),
    action: fresh ?? input.action,
    changeSet: createdChangeSet(changeSet),
  };
}

/** @param {any} prisma @param {any} input */
async function runAddConstraint(prisma, input) {
  const parsed = constraintsFromParams(input.params, input.message);
  if (parsed.length === 0) {
    return {
      ok: false,
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      reason: "no_constraint",
      reply: "I understood that as a rule, but I couldn’t turn it into a precise constraint. Try “don’t touch archived products” or “exclude collection Summer Essentials”.",
    };
  }
  const added = [];
  for (const constraint of parsed) {
    const result = await addActionConstraint(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      kind: constraint.kind,
      params: constraint.params,
      label: constraint.label,
      source: input.params?.source ?? "chat",
    });
    if (result.ok && result.constraint) added.push(result.constraint);
  }
  if (added.length === 0) {
    return {
      ok: false,
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      reason: "not_persisted",
      reply: "I couldn’t save that constraint against this action.",
    };
  }
  await staleLiveChangeSets(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  const changeSet = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor,
    logger: input.logger,
  });
  const labels = added.map((item) => item.label).join("; ");
  const scope = changeSet.ok
    ? `\n\n${formatChangeSetReply(createdChangeSet(changeSet))}`
    : "";
  return {
    ok: true,
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    result: { constraints: added, changeSet: createdChangeSet(changeSet) },
    reply: `Saved ${added.length === 1 ? "this constraint" : "these constraints"} on this action: ${labels}.${scope}`,
    changeSet: createdChangeSet(changeSet),
  };
}

/** @param {any} prisma @param {any} input */
async function runRemoveConstraint(prisma, input) {
  const result = await removeActionConstraint(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    constraintId: input.params?.constraintId ?? null,
    kind: input.params?.constraintKind ?? null,
  });
  if (!result.ok) {
    return {
      ok: false,
      command: ACTION_COMMAND.REMOVE_CONSTRAINT,
      reason: result.reason,
      reply: "I couldn’t find a matching constraint to remove on this action.",
    };
  }
  await staleLiveChangeSets(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  const changeSet = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor,
    logger: input.logger,
  });
  return {
    ok: true,
    command: ACTION_COMMAND.REMOVE_CONSTRAINT,
    result,
    reply: `Removed that constraint.${changeSet.ok ? `\n\n${formatChangeSetReply(createdChangeSet(changeSet))}` : ""}`,
    changeSet: createdChangeSet(changeSet),
  };
}

/** @param {any} prisma @param {any} input */
async function runStartStep(prisma, input) {
  if (input.action.status === "proposed") {
    const accepted = await acceptMerchantActionPlan(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      actor: input.actor ?? input.merchantId,
      logger: input.logger,
    });
    if (!accepted.ok) {
      return {
        ok: false,
        command: ACTION_COMMAND.START_STEP,
        reason: accepted.reason,
        reply: buildPlanAcceptReply(input.action, accepted),
      };
    }
  }

  const current = await getCurrentChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  const executeStep = isExecuteStep(input.action.currentStep ?? input.action);
  if (executeStep && !current) {
    await createActionChangeSet(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      actor: input.actor,
      logger: input.logger,
    });
  }
  if (executeStep) {
    await applyActionChangeSet(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      actor: input.actor,
      session: null,
      logger: input.logger,
    });
  }

  const stepStart = await startActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    stepId: input.params?.stepId ?? null,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  let reply = buildStartReply(fresh ?? input.action, stepStart);
  if (stepStart.ok && stepStart.stepRunId) {
    const startedStep = findStep(fresh ?? input.action, stepStart.stepId);
    if (startedStep?.mode === "assist") {
      const assist = await executeStartedAssistStepRun(prisma, {
        stepRunId: stepStart.stepRunId,
        actionId: input.action.id,
        conversationId: input.conversationId ?? null,
        logger: input.logger,
      });
      if (assist.ok && assist.chatReply) reply = assist.chatReply;
    } else if (startedStep?.mode === "execute") {
      await processReadyActionStepRuns(prisma, {
        maxRuns: 1,
        logger: input.logger,
        ...(input.executeDeps ?? {}),
      });
      const changeSet = await getLatestChangeSet(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.action.id,
      });
      if (changeSet) {
        reply = formatExecutionResultReply(serializeChangeSet(changeSet));
      }
    }
  }
  return {
    ok: Boolean(stepStart.ok),
    command: ACTION_COMMAND.START_STEP,
    reason: stepStart.ok ? null : stepStart.reason,
    result: stepStart,
    reply,
    action: fresh ?? input.action,
  };
}

/** @param {any} prisma @param {any} input */
async function runStopStep(prisma, input) {
  const result = await stopActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.STOP_STEP,
    reason: result.ok ? null : result.reason,
    result,
    reply: buildPlanStopReply(fresh ?? input.action, result),
  };
}

/** @param {any} prisma @param {any} input */
async function runSkipStep(prisma, input) {
  const result = await skipCurrentActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.SKIP_STEP,
    reason: result.ok ? null : result.reason,
    result,
    reply: buildPlanSkipReply(fresh ?? input.action, result),
  };
}

/** @param {any} prisma @param {any} input */
async function runDeferAction(prisma, input) {
  const result = await deferMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.DEFER_ACTION,
    reason: result.ok ? null : result.reason,
    result,
    reply: result.ok
      ? `I’ll leave “${input.action.title}” until later. Nothing was written to the store.`
      : "I couldn’t defer this action just now.",
  };
}

/** @param {any} prisma @param {any} input */
async function runRejectAction(prisma, input) {
  if (!input.action.actionRunId) {
    const deferred = await deferMerchantAction(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      actor: input.actor ?? input.merchantId,
      status: "declined",
      logger: input.logger,
    });
    return {
      ok: Boolean(deferred.ok),
      command: ACTION_COMMAND.REJECT_ACTION,
      result: deferred,
      reply: buildPlanDeclineReply({ status: deferred.ok ? "rejected" : "failed" }),
    };
  }
  const result = await rejectAction(prisma, {
    merchantId: input.merchantId,
    actionRunId: input.action.actionRunId,
    reasonCategory: "decline",
  });
  return {
    ok: result.status === "rejected",
    command: ACTION_COMMAND.REJECT_ACTION,
    result,
    reply: buildPlanDeclineReply(result),
  };
}

/** @param {any} prisma @param {any} input */
async function runCreateChangeSet(prisma, input) {
  const result = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor,
    logger: input.logger,
  });
  if (!result.ok) {
    return {
      ok: false,
      command: ACTION_COMMAND.CREATE_CHANGESET,
      reason: result.reason,
      reply:
        result.reason === "no_preview"
          ? "I don’t have an exact mutation list yet. Accept the plan and I can build one from the live proposal."
          : "I couldn’t build an exact change set just now.",
    };
  }
  return {
    ok: true,
    command: ACTION_COMMAND.CREATE_CHANGESET,
    changeSet: result.changeSet,
    reply: `${formatChangeSetReply(result.changeSet)}\n\nSay go ahead when you want me to apply this exact set.`,
  };
}

/** @param {any} prisma @param {any} input */
async function runApplyChangeSet(prisma, input) {
  const applied = await applyActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor,
    session: input.session ?? null,
    executeDeps: input.executeDeps,
    logger: input.logger,
  });
  if (!applied.ok) {
    return {
      ok: false,
      command: ACTION_COMMAND.APPLY_CHANGESET,
      reason: applied.reason,
      reply: "I couldn’t apply that change set. Nothing was written.",
    };
  }
  if (applied.assistOnly) {
    return {
      ok: true,
      command: ACTION_COMMAND.APPLY_CHANGESET,
      changeSet: applied.changeSet,
      reply: `${formatChangeSetReply(applied.changeSet)}\n\nThese quantities are for you to order — I haven’t written anything to Shopify.`,
    };
  }
  if (applied.alreadyApplied) {
    return {
      ok: true,
      command: ACTION_COMMAND.APPLY_CHANGESET,
      changeSet: applied.changeSet,
      reply: formatExecutionResultReply(applied.changeSet),
    };
  }
  if (applied.pendingExecution) {
    const started = await runStartStep(prisma, input);
    return { ...started, command: ACTION_COMMAND.APPLY_CHANGESET };
  }
  return {
    ok: true,
    command: ACTION_COMMAND.APPLY_CHANGESET,
    changeSet: applied.changeSet,
    result: applied.result,
    reply: formatExecutionResultReply(applied.changeSet),
  };
}

/** @param {any} prisma @param {any} input */
async function runConfirmMerchantStep(prisma, input) {
  const result = await completeCurrentActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.CONFIRM_MERCHANT_STEP,
    reason: result.ok ? null : result.reason,
    result,
    reply: buildPlanCompleteReply(fresh ?? input.action, result),
  };
}

/** @param {any} prisma @param {any} input */
async function runInspectScope(prisma, input) {
  const current = await getCurrentChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  if (current) {
    return {
      ok: true,
      command: ACTION_COMMAND.INSPECT_SCOPE,
      changeSet: serializeChangeSet(current),
      reply: formatChangeSetReply(serializeChangeSet(current)),
    };
  }
  const created = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    logger: input.logger,
  });
  if (created.ok) {
    return {
      ok: true,
      command: ACTION_COMMAND.INSPECT_SCOPE,
      changeSet: created.changeSet,
      reply: formatChangeSetReply(created.changeSet),
    };
  }
  return {
    ok: true,
    command: ACTION_COMMAND.INSPECT_SCOPE,
    reply: buildPlanScopeReply(input.action),
  };
}

/** @param {any} prisma @param {any} input */
async function runReportExecution(prisma, input) {
  const latest = await getLatestChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  if (latest) {
    return {
      ok: true,
      command: ACTION_COMMAND.REPORT_EXECUTION,
      changeSet: serializeChangeSet(latest),
      reply: formatExecutionResultReply(serializeChangeSet(latest)),
    };
  }
  const items = extractPlanScopeItems(input.action);
  if (input.action.executionStatus === "applied" || input.action.executionStatus === "partially_applied") {
    return {
      ok: true,
      command: ACTION_COMMAND.REPORT_EXECUTION,
      reply: `The last run finished as ${String(input.action.executionStatus).replaceAll("_", " ")}.${
        items.length ? ` It targeted ${items.length} item${items.length === 1 ? "" : "s"}.` : ""
      }`,
    };
  }
  return {
    ok: true,
    command: ACTION_COMMAND.REPORT_EXECUTION,
    reply: "Nothing has been written for this action yet.",
  };
}

function runAnswer(/** @type {any} */ action, /** @type {any} */ params) {
  const kind = params?.questionKind;
  if (kind === PLAN_CHAT_INTENT.status) {
    return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanStatusReply(action) };
  }
  if (kind === PLAN_CHAT_INTENT.recap) {
    return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanRecapReply(action) };
  }
  if (kind === PLAN_CHAT_INTENT.scope) {
    return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanScopeReply(action) };
  }
  return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanRecapReply(action) };
}

/**
 * True defer: hold the action without treating it as a declined execution.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; status?: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function deferMerchantAction(prisma, input) {
  const status = input.status === "declined" ? "declined" : "deferred";
  const action = await prisma.merchantAction?.findFirst?.({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    select: { id: true, sourceRecommendationId: true, status: true },
  });
  if (!action) return { ok: false, reason: "not_found" };
  await prisma.merchantAction.updateMany({
    where: {
      id: action.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    data: { status },
  });
  if (action.sourceRecommendationId && prisma.merchantPlanRecommendation?.updateMany) {
    await prisma.merchantPlanRecommendation.updateMany({
      where: {
        id: action.sourceRecommendationId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
      data: { reviewStatus: status },
    });
  }
  if (prisma.merchantActionEvent?.create) {
    await prisma.merchantActionEvent.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        merchantActionId: action.id,
        eventType: status === "declined" ? "action_rejected" : "action_deferred",
        metadata: { actor: input.actor ?? input.merchantId },
      },
    });
  }
  return { ok: true, status };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function listActionRuntimeContext(prisma, input) {
  const [constraints, changeSet] = await Promise.all([
    listActionConstraints(prisma, input),
    getCurrentChangeSet(prisma, input),
  ]);
  return {
    constraints: constraints.map(serializeConstraint),
    currentChangeSet: changeSet ? serializeChangeSet(changeSet) : null,
  };
}

/** @param {string} text */
export function parsePlanRevision(text) {
  const normalized = normalizeChatText(text);
  const markdown =
    normalized.match(/\b(\d+(?:\.\d+)?)\s*%\s+(?:instead|rather than|markdown)\b/i) ||
    normalized.match(/\b(?:use|make (?:it|this)|at)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*%/i) ||
    normalized.match(/\bmarkdown(?: of)?\s+(\d+(?:\.\d+)?)\s*%/i);
  const cover =
    normalized.match(/\b(\d+)\s*days?\s+(?:of\s+)?cover\b/i) ||
    normalized.match(/\bcover\s+(?:of\s+)?(\d+)\s*days?\b/i);
  const maxProducts =
    normalized.match(/\b(?:top|only|just)\s+(\d+)\s+products?\b/i) ||
    normalized.match(/\bonly do(?: the)?\s+(\d+)\b/i);
  /** @type {Record<string, number>} */
  const params = {};
  if (markdown?.[1]) params.markdownPercent = Number(markdown[1]);
  if (cover?.[1]) params.coverDays = Number(cover[1]);
  if (maxProducts?.[1]) params.maxProducts = Number(maxProducts[1]);
  return Object.keys(params).length ? params : null;
}

/** @param {any} params @param {unknown} message */
function constraintsFromParams(params, message) {
  if (Array.isArray(params?.constraints) && params.constraints.length > 0) {
    return params.constraints;
  }
  if (params?.constraintKind) {
    return [
      {
        kind: params.constraintKind,
        params: {
          collectionTitle: params.collectionTitle,
          tag: params.tag,
          min: params.minInventory,
          amount: params.minPrice,
        },
        label: params.constraintLabel,
      },
    ];
  }
  return parseConstraintsFromMessage(String(message ?? ""));
}

/** @param {any} params */
function planPatchFromParams(params) {
  /** @type {Record<string, number>} */
  const patch = {};
  const markdown = Number(params?.markdownPercent);
  const cover = Number(params?.coverDays);
  const maxProducts = Number(params?.maxProducts);
  if (Number.isFinite(markdown) && markdown >= 0 && markdown <= 100) {
    patch.markdownPercent = markdown;
  }
  if (Number.isFinite(cover) && cover > 0 && cover <= 365) {
    patch.coverDays = cover;
  }
  if (Number.isInteger(maxProducts) && maxProducts > 0) {
    patch.maxProducts = maxProducts;
  }
  return patch;
}

/** @param {any} prisma @param {any} input @param {Record<string, number>} patch */
async function persistActionPlan(prisma, input, patch) {
  if (!prisma?.merchantAction?.update) return;
  const current = jsonObject(input.action?.plan);
  await prisma.merchantAction.update({
    where: { id: input.action.id },
    data: { plan: { ...current, ...patch } },
  });
}

/** @param {any} action @param {Record<string, number>} patch @param {any} changeSet */
function buildReviseReply(action, patch, changeSet) {
  const bits = [];
  if (patch.markdownPercent != null) bits.push(`markdown to ${patch.markdownPercent}%`);
  if (patch.coverDays != null) bits.push(`cover to ${patch.coverDays} days`);
  if (patch.maxProducts != null) bits.push(`scope to the top ${patch.maxProducts} products`);
  const summary = bits.length ? `Updated ${bits.join(" and ")}.` : "Updated the plan.";
  const restock = isRestockAction(action)
    ? " I’ll recalculate recommended quantities from that cover."
    : "";
  const table = changeSet?.ok ? `\n\n${formatChangeSetReply(changeSet.changeSet)}` : "";
  return `${summary}${restock}${table}`;
}

/** @param {any} action @param {any} stepStart */
function buildStartReply(action, stepStart) {
  if (stepStart.ok) {
    const step = findStep(action, stepStart.stepId) ?? action.currentStep;
    const title = step?.title ?? "the next step";
    return `Starting “${title}” now. I’ll work through this and come back with what you need to review.`;
  }
  const reason = String(stepStart.reason ?? "");
  if (reason.startsWith("action_not_startable:proposed")) {
    return "Accept the plan first — then tell me to start.";
  }
  return "I couldn’t start that step just now.";
}

/** @param {any} action @param {any} stepId */
function findStep(action, stepId) {
  const steps = [
    ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []),
    ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []),
  ];
  return steps.find((step) => step?.id === stepId) ?? null;
}

/** @param {any} step */
function isExecuteStep(step) {
  return String(step?.mode ?? "") === "execute";
}

/** @param {any} prisma @param {any} input */
async function refreshAction(prisma, input) {
  return getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
}

/** @param {string} text */
function isCreateChangeSetAsk(text) {
  return (
    /\bshow me exactly\b/i.test(text) ||
    /\bexact(?:ly)? (?:what you(?:'ll| will) change|changes)\b/i.test(text) ||
    /\bchange ?set\b/i.test(text) ||
    /\bpreview (?:the )?(?:changes|markdowns?)\b/i.test(text)
  );
}

/** @param {string} text */
function isExecutionReportAsk(text) {
  return (
    /\bwhat (?:did you|have you) (?:actually )?(?:change|write|do)\b/i.test(text) ||
    /\bwhat changed\b/i.test(text) ||
    /\bexecution (?:result|run)\b/i.test(text)
  );
}

/** @param {string} text */
function isInspectScopeAsk(text) {
  return (
    /\bwhich products (?:does|do) that leave\b/i.test(text) ||
    /\bwhat(?:'s| is) left\b/i.test(text)
  );
}

/** @param {string} text */
function isDeferCommand(text) {
  return (
    /\b(leave this|defer this|not right now|next month|later)\b/i.test(text) &&
    !isPrimarilyQuestion(text)
  );
}

/** @param {string} text */
function isRemoveConstraintCommand(text) {
  return /\b(remove|drop|clear) (that |the |this )?(constraint|exclusion|rule)\b/i.test(text);
}

/** @param {string} text */
function parseRemoveConstraint(text) {
  const kind = parseConstraintsFromMessage(text)[0]?.kind ?? null;
  return { constraintKind: kind };
}

/** @param {{ ok: boolean; changeSet?: any }} result */
function createdChangeSet(result) {
  return result.ok ? result.changeSet ?? null : null;
}

/** @param {unknown} value */
function normalizeCommandType(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw in ACTION_COMMAND) {
    return ACTION_COMMAND[/** @type {keyof typeof ACTION_COMMAND} */ (raw)];
  }
  const upper = raw.toUpperCase();
  if ((/** @type {string[]} */ (Object.values(ACTION_COMMAND))).includes(upper)) return upper;
  const aliased = COMMAND_ALIASES[raw.toLowerCase()];
  return aliased ?? null;
}

/** @param {unknown} value */
function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function stringOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
