// @ts-check

/**
 * Structured Action Runtime commands. UI buttons land here with an explicit
 * command. Focused chat lands here through the Action Agent's tool loop.
 * Application code validates state and executes through lifecycle /
 * Change Set / typed-adapter services. The model never mutates Shopify or
 * workflow status itself.
 */

import { logger as baseLogger } from "../observability/logger.server.js";
import {
  acceptMerchantActionPlan,
  completeCurrentActionStep,
  processReadyActionStepRuns,
  skipCurrentActionStep,
  startActionStep,
  stopActionStep,
} from "./action-step-lifecycle.server.js";
import { executeStartedAssistStepRun } from "./assist-steps/run.server.js";
import { rejectAction, reviseAction } from "./action-resolution.server.js";
import { scheduleProactivePlanAfterTerminalState } from "../merchant-plan/proactive-recommendation-trigger.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  addActionConstraint,
  expandScopeModificationToConstraints,
  listActionConstraints,
  normalizeMatch,
  parseConstraintsFromMessage,
  parseScopeModificationFromMessage,
  removeActionConstraint,
  serializeConstraint,
  normalizeChatText,
} from "./action-constraint.server.js";
import { inspectRestockEvidence, recommendedPurchaseUnits } from "./action-capability.server.js";
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
  buildPlanAdvanceReply,
  buildPlanCompleteReply,
  buildPlanDeclineReply,
  buildPlanGoBackReply,
  buildPlanGoToReply,
  buildPlanRecapReply,
  buildPlanScopeReply,
  buildPlanSkipReply,
  buildPlanStatusReply,
  buildPlanStopReply,
  currentPlanStep,
  extractPlanScopeItems,
} from "./plan-chat.server.js";
import { resolveActionContext } from "./resolved-action-context.server.js";
import { validatePlanPatch, describePlanRevision } from "./action-plan-schema.server.js";
import { reachCapability, runAssistStepById } from "./agent/assist-runner.server.js";
import { outcomeCapabilityRef, resolveActionState } from "./action-state.server.js";
import {
  advanceCurrentActionStep,
  goBackActionSteps,
  goToActionStep,
  invalidateDownstreamSteps,
  resolveStepTargetOrClarify,
} from "./action-workflow-navigation.server.js";

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
  ADVANCE_STEP: "ADVANCE_STEP",
  GO_BACK: "GO_BACK",
  GO_TO_STEP: "GO_TO_STEP",
  NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
  DEFER_ACTION: "DEFER_ACTION",
  REJECT_ACTION: "REJECT_ACTION",
  CREATE_CHANGESET: "CREATE_CHANGESET",
  APPLY_CHANGESET: "APPLY_CHANGESET",
  CONFIRM_MERCHANT_STEP: "CONFIRM_MERCHANT_STEP",
  INSPECT_SCOPE: "INSPECT_SCOPE",
  INSPECT_PROPOSAL: "INSPECT_PROPOSAL",
  REPORT_EXECUTION: "REPORT_EXECUTION",
  ACHIEVE_OUTCOME: "ACHIEVE_OUTCOME",
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
  ACTION_COMMAND.ADVANCE_STEP,
  ACTION_COMMAND.GO_BACK,
  ACTION_COMMAND.GO_TO_STEP,
  ACTION_COMMAND.DEFER_ACTION,
  ACTION_COMMAND.REJECT_ACTION,
  ACTION_COMMAND.CREATE_CHANGESET,
  ACTION_COMMAND.APPLY_CHANGESET,
  ACTION_COMMAND.CONFIRM_MERCHANT_STEP,
  ACTION_COMMAND.ACHIEVE_OUTCOME,
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
      productTitle: stringOrNull(raw.productTitle ?? raw.params?.productTitle ?? raw.params?.title),
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
    case ACTION_COMMAND.ADVANCE_STEP:
      return runAdvanceStep(prisma, { ...input, action, logger });
    case ACTION_COMMAND.GO_BACK:
      return runGoBack(prisma, { ...input, action, params, logger });
    case ACTION_COMMAND.GO_TO_STEP:
      return runGoToStep(prisma, { ...input, action, params, logger });
    case ACTION_COMMAND.NEEDS_CLARIFICATION:
      return runNeedsClarification(prisma, { ...input, action, params, logger });
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
    case ACTION_COMMAND.INSPECT_PROPOSAL:
      return runInspectProposal(prisma, { ...input, action, logger });
    case ACTION_COMMAND.REPORT_EXECUTION:
      return runReportExecution(prisma, { ...input, action, logger });
    case ACTION_COMMAND.ACHIEVE_OUTCOME:
      return runAchieveOutcome(prisma, { ...input, action, params, logger });
    default:
      return runAnswer(prisma, { ...input, action, params, logger });
  }
}

/**
 * Execute a multi-operation interpreter plan in order. Sequential by default:
 * earlier successes stay if a later command is blocked. Atomic only when the
 * interpreter marks the plan atomic, or when APPLY is combined with plan
 * mutations and `explicitApply` is set.
 *
 * @param {any} prisma
 * @param {{
 *   operations: Array<{ command: string; params?: Record<string, any> }>;
 *   atomic?: boolean;
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
 */
export async function executeActionPlan(prisma, input) {
  const logger = input.logger ?? log;
  const operations = Array.isArray(input.operations) ? input.operations : [];
  if (operations.length === 0) {
    return executeActionCommand(prisma, {
      ...input,
      command: ACTION_COMMAND.ANSWER,
      params: {},
    });
  }
  if (operations.length === 1) {
    return executeActionCommand(prisma, {
      ...input,
      command: operations[0].command,
      params: operations[0].params ?? {},
    });
  }

  logger.info("action plan", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    commands: operations.map((op) => op.command),
    atomic: input.atomic === true,
  });

  /** @type {any[]} */
  const results = [];
  for (const operation of operations) {
    const result = await executeActionCommand(prisma, {
      ...input,
      command: operation.command,
      params: operation.params ?? {},
    });
    results.push(result);
    if (!result.ok || result.command === ACTION_COMMAND.NEEDS_CLARIFICATION) {
      break;
    }
  }
  return composeActionPlanResult(results);
}

/** @param {any[]} results */
function composeActionPlanResult(results) {
  const succeeded = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  const last = results[results.length - 1];
  const commands = results.map((row) => row.command);
  const primary =
    failed[0] ??
    succeeded.find((row) =>
      [
        ACTION_COMMAND.ADVANCE_STEP,
        ACTION_COMMAND.START_STEP,
        ACTION_COMMAND.GO_BACK,
        ACTION_COMMAND.GO_TO_STEP,
        ACTION_COMMAND.INSPECT_PROPOSAL,
        ACTION_COMMAND.APPLY_CHANGESET,
      ].includes(row.command),
    ) ??
    last;
  return {
    ok: failed.length === 0 && Boolean(last?.ok),
    command: primary?.command ?? ACTION_COMMAND.ANSWER,
    reason: failed[0]?.reason ?? (last?.ok ? null : last?.reason),
    reply: composeActionPlanReply(results),
    result: { operations: results },
    results,
    action: last?.action,
    changeSet: [...results].reverse().find((row) => row.changeSet)?.changeSet ?? null,
    commands,
  };
}

/** @param {any[]} results */
function composeActionPlanReply(results) {
  if (results.length === 0) return "I couldn't do that just now.";
  if (results.length === 1) return String(results[0].reply ?? "");
  const summaries = results
    .filter((row) => row.ok)
    .map((row) => firstUsefulSentence(row.reply))
    .filter(Boolean);
  const failed = results.find((row) => !row.ok);
  const parts = [...summaries];
  if (failed?.reply) parts.push(String(failed.reply));
  return parts.join(" ").trim() || String(results[results.length - 1]?.reply ?? "");
}

/** @param {unknown} reply */
function firstUsefulSentence(reply) {
  const text = String(reply ?? "").trim();
  if (!text) return "";
  const beforeTable = text.split(/\n\n/)[0] ?? text;
  const sentence = beforeTable.split(/(?<=\.)\s+/)[0] ?? beforeTable;
  return sentence.trim();
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
  const reopened = await reopenForRevision(prisma, input);
  if (!reopened.ok) {
    return { ...reopened, command: ACTION_COMMAND.REVISE_PLAN };
  }
  const rawPatch = planPatchFromParams(input.params);
  const { patch: planPatch, rejected } = validatePlanPatch(input.action, rawPatch);
  if (rejected.length > 0 && Object.keys(planPatch).length === 0) {
    const kind = isRestockAction(input.action) ? "cover days" : "markdown percent";
    return {
      ok: false,
      command: ACTION_COMMAND.REVISE_PLAN,
      reason: "invalid_plan_field",
      reply: `That parameter doesn't apply to this action. For this one, tell me the ${kind} or how many products.`,
    };
  }
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
  await invalidateDownstreamFromCurrentFocus(prisma, input);

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

/**
 * The next piece of Jefe-owned work, derived from dependencies and artifact
 * freshness rather than from a persisted cursor.
 *
 * @param {any} prisma @param {any} input
 */
async function nextJefeOwnedStepId(prisma, input) {
  const state = await resolveActionState(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    conversationId: input.conversationId ?? null,
  });
  const rows = state?.work ?? [];
  const next =
    rows.find(
      (/** @type {any} */ row) =>
        row.step.mode === "assist" && (row.state === "available" || row.state === "needs_updating"),
    ) ??
    rows.find(
      (/** @type {any} */ row) => row.state === "available" || row.state === "needs_updating",
    ) ??
    null;
  return next?.step?.id ?? null;
}

/** @param {any} prisma @param {any} input */
async function runAchieveOutcome(prisma, input) {
  const outcome = input.params?.outcome ?? input.params?.targetHint ?? "supplier_draft";
  const capabilityRef = outcomeCapabilityRef(String(outcome).toLowerCase().replace(/\s+/g, "_"));
  if (!capabilityRef) {
    return {
      ok: false,
      command: ACTION_COMMAND.ACHIEVE_OUTCOME,
      reason: "unknown_outcome",
      reply: "I couldn't map that to a piece of work on this action.",
    };
  }
  const result = await reachCapability(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    capabilityRef,
    actor: input.actor ?? input.merchantId,
    conversationId: input.conversationId ?? null,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.ACHIEVE_OUTCOME,
    reason: result.ok ? null : result.code ?? null,
    result,
    reply: result.ok
      ? `Completed "${result.title ?? "that work"}".`
      : result.message ?? "I couldn't reach that outcome just now.",
    action: fresh ?? input.action,
  };
}

/**
 * A finished action can still be revised while nothing has been written to
 * Shopify: the merchant is iterating on documents, not rewriting history.
 * Derived staleness then marks the affected results as needing an update, so
 * "completed" simply stops being true. Once an external write has actually
 * happened, the refusal stands — that history is real.
 *
 * @param {any} prisma @param {any} input
 * @returns {Promise<{ ok: boolean; reason?: string; reply?: string; reopened?: boolean }>}
 */
async function reopenForRevision(prisma, input) {
  const action = input.action;
  if (String(action?.status ?? "") !== "completed") return { ok: true };
  if (hasExternalExecution(action)) {
    return {
      ok: false,
      reason: "action_executed",
      reply:
        "I've already applied these changes to your store, so I can't revise them retrospectively. Start a new recommendation to change things again.",
    };
  }
  await prisma.merchantAction.updateMany({
    where: { id: action.id, merchantId: input.merchantId, shopId: input.shopId },
    data: { status: "in_progress" },
  });
  action.status = "in_progress";
  return { ok: true, reopened: true };
}

/** @param {any} action */
function hasExternalExecution(action) {
  const executions = Array.isArray(action?.executions) ? action.executions : [];
  if (executions.some((/** @type {any} */ row) => String(row?.status ?? "") === "succeeded")) {
    return true;
  }
  const changeSets = Array.isArray(action?.changeSets) ? action.changeSets : [];
  return changeSets.some((/** @type {any} */ row) =>
    ["applied", "partial", "applying"].includes(String(row?.status ?? "")),
  );
}

/** @param {any} prisma @param {any} input @returns {Promise<any>} */
async function runAddConstraint(prisma, input) {
  const reopened = await reopenForRevision(prisma, input);
  if (!reopened.ok) {
    return { ...reopened, command: ACTION_COMMAND.ADD_CONSTRAINT };
  }
  if (input.params?.scopeModification) {
    return runScopeModification(prisma, input);
  }
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
  await invalidateDownstreamFromCurrentFocus(prisma, input);
  const changeSet = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor,
    logger: input.logger,
  });
  const scope = changeSet.ok
    ? `\n\n${formatChangeSetReply(createdChangeSet(changeSet), input.action)}`
    : "";
  return {
    ok: true,
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    result: { constraints: added, changeSet: createdChangeSet(changeSet) },
    reply: `${buildConstraintAddedReply(added, input.message)}${scope}`,
    changeSet: createdChangeSet(changeSet),
  };
}

/** @param {any} prisma @param {any} input @returns {Promise<any>} */
async function runScopeModification(prisma, input) {
  const reopened = await reopenForRevision(prisma, input);
  if (!reopened.ok) {
    return { ...reopened, command: ACTION_COMMAND.ADD_CONSTRAINT };
  }
  const modification = input.params?.scopeModification;
  if (!modification) {
    return {
      ok: false,
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      reason: "no_constraint",
      reply: "I understood that as a scope change, but I couldn't turn it into a precise constraint.",
    };
  }
  if (modification.intent === "include_again") {
    const constraints = await listActionConstraints(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
    });
    const wanted = normalizeMatch(modification.title);
    const match = constraints.find(
      (/** @type {any} */ row) =>
        row.kind === "exclude_product" &&
        productHintMatchesConstraint(wanted, row),
    );
    if (!match) {
      return {
        ok: false,
        command: ACTION_COMMAND.ADD_CONSTRAINT,
        reason: "not_found",
        reply: `I don't have ${modification.title} excluded on this action right now.`,
      };
    }
    await removeActionConstraint(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      constraintId: match.id,
    });
    await staleLiveChangeSets(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
    });
    await invalidateDownstreamFromCurrentFocus(prisma, input);
    const changeSet = await createActionChangeSet(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      actor: input.actor,
      logger: input.logger,
    });
    const scope = changeSet.ok
      ? `\n\n${formatChangeSetReply(createdChangeSet(changeSet), input.action)}`
      : "";
    return {
      ok: true,
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      reply: `Included ${modification.title} again.${scope}`,
      changeSet: createdChangeSet(changeSet),
    };
  }
  const candidates = await inspectRestockEvidence(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
  });
  const parsed = expandScopeModificationToConstraints(modification, candidates);
  if (parsed.length === 0) {
    return {
      ok: false,
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      reason: "no_constraint",
      reply: "I understood that as a scope change, but I couldn't match it to products on this action.",
    };
  }
  return runAddConstraint(prisma, {
    ...input,
    params: { constraints: parsed },
    message: input.message,
  });
}

/** @param {any[]} added @param {string | null | undefined} message */
function buildConstraintAddedReply(added, message) {
  const scopeMod = parseScopeModificationFromMessage(String(message ?? ""));
  if (scopeMod?.intent === "include_only") {
    const excluded = added
      .map((item) => item.label?.replace(/^Exclude\s+/i, "") ?? item.params?.title)
      .filter(Boolean);
    const included = scopeMod.title;
    if (excluded.length === 1) {
      return `Got it — I'll only include ${included} in this action. ${excluded[0]} is excluded.`;
    }
    if (excluded.length > 1) {
      return `Got it — I'll only include ${included} in this action. Excluded: ${excluded.join(", ")}.`;
    }
    return `Got it — I'll only include ${included} in this action.`;
  }
  if (added.length === 1) {
    return `Saved this constraint on this action: ${added[0].label}.`;
  }
  return `Saved these constraints on this action: ${added.map((item) => item.label).join("; ")}.`;
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

  // Jefe-owned work runs by step id off derived availability. The old path
  // asked the persisted cursor for permission, which is why "Start this"
  // refused work whose prerequisites were already complete.
  const targetStepId = input.params?.stepId ?? (await nextJefeOwnedStepId(prisma, input));
  if (targetStepId) {
    const assistRun = await runAssistStepById(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
      stepId: targetStepId,
      actor: input.actor ?? input.merchantId,
      conversationId: input.conversationId ?? null,
      logger: input.logger,
    });
    if (assistRun.ok || assistRun.code !== "NOT_JEFE_OWNED") {
      const refreshed = await refreshAction(prisma, input);
      return {
        ok: Boolean(assistRun.ok),
        command: ACTION_COMMAND.START_STEP,
        reason: assistRun.ok ? null : assistRun.code ?? null,
        result: assistRun,
        reply: assistRun.ok
          ? assistRun.chatReply ?? `Completed "${assistRun.title ?? "that step"}".`
          : assistRun.message ?? "I couldn't start that.",
        action: refreshed ?? input.action,
      };
    }
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
        resolvedContext: stepStart.resolvedContext ?? null,
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
async function runAdvanceStep(prisma, input) {
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
        command: ACTION_COMMAND.ADVANCE_STEP,
        reason: accepted.reason,
        reply: buildPlanAcceptReply(input.action, accepted),
      };
    }
  }
  const result = await advanceCurrentActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.ADVANCE_STEP,
    reason: result.reason ?? null,
    result,
    reply: buildPlanAdvanceReply(fresh ?? input.action, result),
    action: fresh ?? input.action,
  };
}

/** @param {any} prisma @param {any} input */
async function runGoBack(prisma, input) {
  const result = await goBackActionSteps(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    steps: input.params?.steps ?? 1,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  await clearPendingNavigation(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.GO_BACK,
    reason: result.ok ? null : result.reason,
    result,
    reply: buildPlanGoBackReply(fresh ?? input.action, result),
    action: fresh ?? input.action,
  };
}

/** @param {any} prisma @param {any} input */
async function runGoToStep(prisma, input) {
  const steps = uniqueStepsById([
    ...(Array.isArray(input.action?.workflow?.steps) ? input.action.workflow.steps : []),
    ...(Array.isArray(input.action?.displaySteps) ? input.action.displaySteps : []),
  ]);
  let targetStepId = input.params?.stepId ?? null;
  if (!targetStepId && input.params?.targetHint) {
    const resolved = resolveStepTargetOrClarify(steps, input.params.targetHint);
    if (resolved.ambiguous) {
      await persistPendingNavigation(prisma, input, {
        intent: ACTION_COMMAND.GO_TO_STEP,
        question: resolved.question,
        candidates: resolved.candidates,
      });
      return {
        ok: true,
        command: ACTION_COMMAND.NEEDS_CLARIFICATION,
        reply: resolved.question,
        action: input.action,
      };
    }
    targetStepId = resolved.step?.id ?? null;
  }
  if (!targetStepId) {
    return {
      ok: false,
      command: ACTION_COMMAND.GO_TO_STEP,
      reason: "step_not_found",
      reply: "I couldn't figure out which step you meant.",
    };
  }
  const result = await goToActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    targetStepId,
    actor: input.actor ?? input.merchantId,
    logger: input.logger,
  });
  const fresh = await refreshAction(prisma, input);
  await clearPendingNavigation(prisma, input);
  return {
    ok: Boolean(result.ok),
    command: ACTION_COMMAND.GO_TO_STEP,
    reason: result.ok ? null : result.reason,
    result,
    reply: buildPlanGoToReply(fresh ?? input.action, result),
    action: fresh ?? input.action,
  };
}

/** @param {any} prisma @param {any} input */
async function runNeedsClarification(prisma, input) {
  await persistPendingNavigation(prisma, input, {
    intent: input.params?.intent ?? ACTION_COMMAND.GO_TO_STEP,
    question: input.params?.question ?? "Which step did you mean?",
    candidates: input.params?.candidates ?? [],
  });
  return {
    ok: true,
    command: ACTION_COMMAND.NEEDS_CLARIFICATION,
    reply: input.params?.question ?? "Which step did you mean?",
    action: input.action,
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
    const restock = isRestockAction(input.action);
    return {
      ok: false,
      command: ACTION_COMMAND.CREATE_CHANGESET,
      reason: result.reason,
      reply:
        result.reason === "no_preview"
          ? restock
            ? "I don’t have restock evidence loaded yet, so I can’t show recommended quantities. Once inventory cover is in Merchant Memory I can build the proposal without writing to Shopify."
            : "I don’t have an exact mutation list yet. Accept the plan and I can build one from the live proposal."
          : "I couldn’t build an exact change set just now.",
    };
  }
  const restock = result.changeSet?.actionType === "restock" || isRestockAction(input.action);
  return {
    ok: true,
    command: ACTION_COMMAND.CREATE_CHANGESET,
    changeSet: result.changeSet,
    reply: restock
      ? `${formatChangeSetReply(result.changeSet)}\n\nThese are recommended order quantities, not Shopify writes. Say go ahead when you want me to use this proposal for the current step.`
      : `${formatChangeSetReply(result.changeSet)}\n\nSay go ahead when you want me to apply this exact set.`,
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
    // The change set is approved but no live session was available to write
    // with. The worker may still pick it up; until a run actually records a
    // result, this turn has written nothing and must not say otherwise.
    const started = await runStartStep(prisma, input);
    const latest = await getLatestChangeSet(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.action.id,
    });
    const wrote = ["applied", "partial"].includes(String(latest?.status ?? ""));
    if (wrote) {
      return {
        ...started,
        ok: true,
        command: ACTION_COMMAND.APPLY_CHANGESET,
        changeSet: serializeChangeSet(latest),
        reply: formatExecutionResultReply(serializeChangeSet(latest)),
      };
    }
    return {
      ok: false,
      command: ACTION_COMMAND.APPLY_CHANGESET,
      reason: "execution_unavailable",
      changeSet: latest ? serializeChangeSet(latest) : applied.changeSet,
      reply:
        "The change set is approved, but I couldn't reach your store to apply it. Nothing has been written — ask me again in a moment.",
    };
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

/** @param {any} prisma @param {any} input */
async function runAnswer(prisma, input) {
  if (input.params?.simulate) {
    return runSimulate(prisma, input);
  }
  const kind = input.params?.questionKind;
  const action = input.action;
  if (kind === PLAN_CHAT_INTENT.status) {
    return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanStatusReply(action) };
  }
  if (kind === PLAN_CHAT_INTENT.recap) {
    return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanRecapReply(action) };
  }
  if (kind === PLAN_CHAT_INTENT.scope) {
    return runInspectScope(prisma, input);
  }
  if (kind === "constraints") {
    return runReportConstraints(prisma, input);
  }
  return answerFocusedAction(prisma, input);
}

/** @param {any} prisma @param {any} input */
async function runSimulate(prisma, input) {
  const resolved = await resolveActionContext(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    conversationId: input.conversationId ?? null,
    logger: input.logger,
  });
  const currentCover = Number(resolved?.plan?.values?.coverDays ?? input.action?.plan?.coverDays);
  const coverDays = Number(input.params?.coverDays);
  const markdown = Number(input.params?.markdownPercent);
  const items = Array.isArray(resolved?.scope?.items) ? resolved.scope.items : [];
  if (Number.isFinite(coverDays) && coverDays > 0) {
    const lines = items.map((/** @type {any} */ item) => {
      const units = recommendedPurchaseUnits(
        {
          available: item.available ?? item.inventory ?? 0,
          dailyVelocity: item.dailyVelocity,
        },
        coverDays,
      );
      const title = item.title ?? item.productTitle ?? "Item";
      return units == null ? `• ${title}` : `• ${title} = ${units}`;
    });
    const kept = Number.isFinite(currentCover)
      ? ` The current plan is still ${currentCover} days.`
      : " I haven't changed the current plan.";
    const body = lines.length > 0 ? `\n${lines.join("\n")}` : "";
    return {
      ok: true,
      command: ACTION_COMMAND.ANSWER,
      reply: `If we used ${coverDays} days:${body}.${kept}`,
    };
  }
  if (Number.isFinite(markdown) && markdown >= 0) {
    return {
      ok: true,
      command: ACTION_COMMAND.ANSWER,
      reply: `A ${markdown}% markdown would change the current proposal. I haven't applied that yet.`,
    };
  }
  return {
    ok: true,
    command: ACTION_COMMAND.ANSWER,
    reply: "I can show a hypothetical, but I need a cover period or markdown percent to calculate from.",
  };
}

/** @param {any} prisma @param {any} input */
async function runInspectProposal(prisma, input) {
  const current = await getCurrentChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  if (current) {
    const serialized = serializeChangeSet(current);
    return {
      ok: true,
      command: ACTION_COMMAND.INSPECT_PROPOSAL,
      changeSet: serialized,
      reply: formatChangeSetReply(serialized),
    };
  }
  const created = await createActionChangeSet(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    logger: input.logger,
  });
  if (created.ok) {
    const items = Array.isArray(created.changeSet?.items) ? created.changeSet.items : [];
    const excluded = Array.isArray(created.changeSet?.excluded) ? created.changeSet.excluded : [];
    if (items.length > 0 || excluded.length > 0) {
      return {
        ok: true,
        command: ACTION_COMMAND.INSPECT_PROPOSAL,
        changeSet: created.changeSet,
        reply: formatChangeSetReply(created.changeSet),
      };
    }
  }
  const step = currentPlanStep(input.action);
  const stepTitle = step?.title ?? "the current step";
  const restock = isRestockAction(input.action);
  const reply = restock
    ? `I haven't built the replenishment proposal yet. The current step is "${stepTitle}". Once that's complete, I'll calculate the proposed reorder quantities.`
    : `I haven't built the proposal yet. The current step is "${stepTitle}". Once that's complete, I'll show you the exact changes.`;
  return {
    ok: true,
    command: ACTION_COMMAND.INSPECT_PROPOSAL,
    reason: /** @type {any} */ (created).reason ?? "no_proposal",
    reply,
  };
}

/** @param {any} prisma @param {any} input */
async function runReportConstraints(prisma, input) {
  const constraints = await listActionConstraints(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
  });
  const excluded = constraints.filter((/** @type {any} */ row) => row.kind === "exclude_product");
  if (excluded.length === 0) {
    return {
      ok: true,
      command: ACTION_COMMAND.ANSWER,
      reply: "You haven't excluded anything on this action yet.",
    };
  }
  const lines = excluded
    .map((/** @type {any} */ row) => row.label?.replace(/^Exclude\s+/i, "") ?? row.params?.title)
    .filter(Boolean);
  return {
    ok: true,
    command: ACTION_COMMAND.ANSWER,
    reply:
      lines.length === 1
        ? `You excluded ${lines[0]}.`
        : `You excluded:\n${lines.map((/** @type {any} */ line) => `• ${line}`).join("\n")}`,
  };
}

/** @param {any} prisma @param {any} input */
async function answerFocusedAction(prisma, input) {
  const resolved = await resolveActionContext(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    conversationId: input.conversationId ?? null,
    logger: input.logger,
  });
  const text = normalizeChatText(input.message ?? "");

  // Lifecycle contradiction explanation: if the merchant asks about waiting steps
  // and the actual persisted state has a completed-prerequisite/still-waiting
  // inconsistency, name the contradiction directly instead of giving a generic recap.
  if (/\b(waiting|blocked|stuck|why.{0,20}step|which step)\b/i.test(text)) {
    const allSteps = [
      ...(Array.isArray(input.action?.workflow?.steps) ? input.action.workflow.steps : []),
      ...(Array.isArray(input.action?.displaySteps) ? input.action.displaySteps : []),
    ];
    const byId = new Map(allSteps.map((s) => [String(s.id), s]));
    const contradictions = allSteps.filter((step) => {
      if (String(step.status ?? "") !== "waiting") return false;
      const deps = Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [];
      return deps.length > 0 && deps.every((/** @type {string} */ id) =>
        ["completed", "skipped", "superseded"].includes(String(byId.get(String(id))?.status ?? "")),
      );
    });
    if (contradictions.length > 0) {
      const lines = contradictions.map((step) => {
        const deps = (Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [])
          .map((/** @type {string} */ id) => byId.get(String(id)))
          .filter(Boolean);
        const depNames = deps.map((/** @type {any} */ d) => `"${d.title ?? d.id}"`).join(" and ");
        return (
          `"${step.title ?? step.id}" is currently marked as waiting. ` +
          `It depends on ${depNames}, which ${deps.length === 1 ? "is" : "are"} already complete — ` +
          `so that state is inconsistent. I'll repair it automatically next time you interact with the action.`
        );
      });
      return { ok: true, command: ACTION_COMMAND.ANSWER, reply: lines.join("\n\n") };
    }
  }

  // Answer focused factual questions from structured Action Runtime state.
  // Never fall back to a generic recap for questions about plan parameters,
  // proposal contents, scope, or execution history that the action already holds.

  if (resolved) {
    const planValues = resolved.plan?.values ?? {};
    const coverDays = planValues.coverDays ?? null;
    const markdownPercent = planValues.markdownPercent ?? null;
    const scopeItems = Array.isArray(resolved.scope?.items) ? resolved.scope.items : [];
    const excluded = Array.isArray(resolved.scope?.excluded) ? resolved.scope.excluded : [];

    // Cover-period / replenishment window questions
    if (
      /\b(cover|window|period|days?|how long|replenishment window|days? of (cover|stock))\b/i.test(text) &&
      !/\bproduct|which|scope|what.?s included\b/i.test(text)
    ) {
      if (coverDays != null) {
        const lines = [];
        lines.push(`${coverDays} days of cover.`);
        if (scopeItems.length > 0) {
          const ordered = scopeItems.slice(0, 6).map((item) => {
            const title = item.title ?? item.productTitle ?? null;
            const units = item.recommendedUnits ?? item.after ?? null;
            return title && units != null ? `${title}: ${units} units` : title;
          }).filter(Boolean);
          if (ordered.length > 0) {
            lines.push(`Current recommendation: ${ordered.join(", ")}.`);
          }
        }
        return { ok: true, command: ACTION_COMMAND.ANSWER, reply: lines.join(" ") };
      }
    }

    // Markdown percent questions
    if (/\b(markdown|discount|percent|%|price drop)\b/i.test(text) && markdownPercent != null) {
      return {
        ok: true,
        command: ACTION_COMMAND.ANSWER,
        reply: `The current markdown target is ${markdownPercent}%.`,
      };
    }

    // Why questions — grounded in plan parameters and scope
    if (/\bwhy\b/i.test(text)) {
      const parts = [];
      if (coverDays != null) parts.push(`Cover target: ${coverDays} days.`);
      if (markdownPercent != null) parts.push(`Markdown target: ${markdownPercent}%.`);
      if (scopeItems.length > 0) {
        const titles = scopeItems.slice(0, 6).map((/** @type {any} */ item) => item.title).filter(Boolean);
        if (titles.length) {
          parts.push(`In scope: ${titles.join(", ")}${scopeItems.length > 6 ? ` (+${scopeItems.length - 6} more)` : ""}.`);
        }
      }
      if (excluded.length > 0) {
        const exTitles = excluded.slice(0, 4).map((/** @type {any} */ item) => item.title ?? item.reason).filter(Boolean);
        if (exTitles.length) parts.push(`Excluded: ${exTitles.join(", ")}.`);
      }
      if (resolved.constraints?.length) {
        parts.push(
          `Constraints: ${resolved.constraints.map((/** @type {any} */ row) => row.label ?? row.kind).join("; ")}.`,
        );
      }
      if (parts.length > 0) {
        return { ok: true, command: ACTION_COMMAND.ANSWER, reply: parts.join(" ") };
      }
    }
  }

  return { ok: true, command: ACTION_COMMAND.ANSWER, reply: buildPlanRecapReply(input.action) };
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
  if (status === "declined") {
    scheduleProactivePlanAfterTerminalState(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      trigger: "recommendation_declined",
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
    normalized.match(/\bcover\s+(?:of\s+)?(\d+)\s*days?\b/i) ||
    normalized.match(/\b(?:use|make it|actually use|change (?:cover )?to)\s+(\d+)\s*days?\b/i);
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
          title: params.productTitle ?? params.constraintLabel,
          productId: params.productId,
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
  const summary = describePlanRevision(action, patch);
  const restock = isRestockAction(action)
    ? " I'll recalculate recommended quantities from that cover."
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
  if (reason.startsWith("step_not_ready:running")) {
    return "This step is already running.";
  }
  if (reason.startsWith("step_not_ready:needs_attention")) {
    const step = action.currentStep;
    const title = step?.title ?? "This step";
    const detail = step?.attention?.reason ?? step?.statusReason ?? null;
    return detail
      ? `"${title}" needs attention before it can restart: ${detail}`
      : `"${title}" needs attention before it can restart. Check the details and try again.`;
  }
  if (reason.startsWith("step_not_ready:needs_updating")) {
    const step = action.currentStep;
    const title = step?.title ?? "This step";
    return `"${title}" needs rebuilding because an earlier step or the plan changed. Revise and rebuild before starting.`;
  }
  if (reason.startsWith("step_not_ready:waiting")) {
    const step = action.currentStep;
    const title = step?.title ?? "This step";
    const allSteps = [
      ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []),
      ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []),
    ];
    const deps = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
    if (deps.length > 0) {
      const depTitles = deps
        .map((/** @type {string} */ id) => allSteps.find((/** @type {any} */ s) => s.id === id))
        .filter(Boolean)
        .filter((/** @type {any} */ s) => !["completed", "skipped"].includes(String(s.status ?? "")))
        .map((/** @type {any} */ s) => `"${s.title ?? s.label}"`)
        .slice(0, 2);
      if (depTitles.length > 0) {
        return `"${title}" is waiting for ${depTitles.join(" and ")} to complete first.`;
      }
    }
    return `"${title}" is waiting on an earlier step to complete first.`;
  }
  if (reason === "no_current_step") {
    return "There is no step ready to start right now.";
  }
  if (reason === "not_current_step") {
    return "That step is not the active one. Finish the current step first, or navigate to the one you want.";
  }
  if (reason === "claim_race") {
    return "Another process just claimed that step. Refresh and try again.";
  }
  return "I couldn’t start that step just now.";
}

/** @param {any[]} steps */
function uniqueStepsById(steps) {
  const seen = new Set();
  return steps.filter((step) => {
    const id = String(step?.id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** @param {string} hint @param {any} constraint */
function productHintMatchesConstraint(hint, constraint) {
  const wanted = normalizeMatch(hint);
  if (!wanted) return false;
  const title = normalizeMatch(
    constraint?.params?.title ?? String(constraint?.label ?? "").replace(/^exclude\s+/i, ""),
  );
  if (!title) return false;
  return title === wanted || title.includes(wanted) || wanted.includes(title);
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

/**
 * True when the merchant is asking a store-wide question that should not be
 * answered from the focused action by default.
 * @param {string} message
 */
export function isExplicitGeneralStoreQuestion(message) {
  const text = normalizeChatText(message);
  if (!text) return false;
  const generalPatterns = [
    /\bhow many products (?:do i|does my store|are there)\b/i,
    /\btotal (?:number of )?products\b/i,
    /\boverall (?:store|business|catalogue|catalog)\b/i,
    /\bacross (?:my |the )?(?:whole )?(?:store|catalogue|catalog|business)\b/i,
    /\bstore(?:wide|-wide)\b/i,
    /\bmy entire (?:catalogue|catalog|store)\b/i,
    /\ball (?:my )?products (?:in the store|overall|in total)\b/i,
  ];
  if (!generalPatterns.some((pattern) => pattern.test(text))) return false;
  if (/\b(this|the|current) (?:action|plan|step|proposal|replenishment)\b/i.test(text)) {
    return false;
  }
  if (/\b(?:proposing|replenish|restock|markdown|in scope)\b/i.test(text)) {
    return false;
  }
  return true;
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

/** @param {any} prisma @param {any} input @param {any} pending */
async function persistPendingNavigation(prisma, input, pending) {
  if (!prisma?.merchantAction?.update) return;
  const progress = jsonObject(input.action?.progress);
  await prisma.merchantAction.update({
    where: { id: input.action.id },
    data: { progress: { ...progress, pendingNavigation: pending } },
  });
}

/** @param {any} prisma @param {any} input */
async function clearPendingNavigation(prisma, input) {
  if (!prisma?.merchantAction?.update) return;
  const progress = jsonObject(input.action?.progress);
  if (!progress.pendingNavigation) return;
  const rest = { ...progress };
  delete rest.pendingNavigation;
  await prisma.merchantAction.update({
    where: { id: input.action.id },
    data: { progress: rest },
  });
}

/** @param {any} prisma @param {any} input */
async function invalidateDownstreamFromCurrentFocus(prisma, input) {
  const steps = [
    ...(Array.isArray(input.action?.workflow?.steps) ? input.action.workflow.steps : []),
    ...(Array.isArray(input.action?.displaySteps) ? input.action.displaySteps : []),
  ];
  const current =
    steps.find((step) =>
      ["ready", "running", "needs_merchant", "needs_attention", "needs_updating"].includes(
        String(step?.status ?? ""),
      ),
    ) ?? null;
  if (!current?.id) return;
  const workflowId =
    input.action?.workflow?.id ??
    steps[0]?.workflowId ??
    null;
  if (!workflowId) return;
  await invalidateDownstreamSteps(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.action.id,
    workflowId,
    fromStepId: current.id,
    logger: input.logger,
  });
}
