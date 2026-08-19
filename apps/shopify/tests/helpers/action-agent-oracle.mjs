/**
 * Test-double Action Agent. Maps the legacy interpreter oracle into agent tool
 * turns so golden-path tests exercise the same runtime path as production.
 */

import { ACTION_COMMAND } from "../../app/lib/actions/action-command.server.js";
import { oracleInterpretJson } from "./action-interpreter-oracle.mjs";

/** @type {Record<string, string>} */
const COMMAND_TO_TOOL = {
  [ACTION_COMMAND.REVISE_PLAN]: "update_plan",
  [ACTION_COMMAND.ADD_CONSTRAINT]: "add_constraint",
  [ACTION_COMMAND.REMOVE_CONSTRAINT]: "remove_constraint",
  [ACTION_COMMAND.INSPECT_SCOPE]: "inspect_scope",
  [ACTION_COMMAND.INSPECT_PROPOSAL]: "inspect_proposal",
  [ACTION_COMMAND.REPORT_EXECUTION]: "report_execution",
  [ACTION_COMMAND.ACCEPT_PLAN]: "accept_plan",
  [ACTION_COMMAND.CREATE_CHANGESET]: "create_changeset",
  [ACTION_COMMAND.APPLY_CHANGESET]: "apply_changeset",
  [ACTION_COMMAND.ACHIEVE_OUTCOME]: "achieve_outcome",
  [ACTION_COMMAND.ANSWER]: "answer",
  [ACTION_COMMAND.ADVANCE_STEP]: "advance_step",
  [ACTION_COMMAND.GO_BACK]: "go_back",
  [ACTION_COMMAND.GO_TO_STEP]: "go_to_step",
  [ACTION_COMMAND.SKIP_STEP]: "skip_step",
  [ACTION_COMMAND.START_STEP]: "start_step",
};

/**
 * Unified oracle for focused-action tests. Returns agent turns when the prompt
 * includes availableTools; otherwise returns legacy interpreter JSON.
 */
export function createOracleActionProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "action-agent-oracle",
    async generateStructuredJson({ prompt }) {
      const payload = typeof prompt === "string" ? JSON.parse(prompt) : prompt;
      if (Array.isArray(payload.availableTools)) {
        return {
          json: oracleAgentTurn(payload),
          provider: "test",
          model: "action-agent-oracle",
        };
      }
      return {
        json: oracleInterpretJson(String(payload.merchantMessage ?? ""), {
          pendingClarification: payload.pendingClarification ?? null,
          action: payload.focusedAction ?? {},
          currentChangeSet: payload.focusedAction?.currentChangeSet ?? null,
        }),
        provider: "test",
        model: "action-interpreter-oracle",
      };
    },
  };
}

/** @param {any} payload */
function oracleAgentTurn(payload) {
  const observations = Array.isArray(payload.priorObservations) ? payload.priorObservations : [];
  if (observations.length > 0) {
    const last = observations[observations.length - 1];
    return {
      done: true,
      finalReply: String(last?.summary ?? last?.reply ?? "Done."),
      confidence: 0.9,
    };
  }

  const message = String(payload.merchantMessage ?? "");
  const actionState = payload.actionState ?? {};
  const currentStep =
    actionState.currentStep ??
    actionState.work?.find((/** @type {any} */ row) => row.state === "available") ??
    null;
  const snapshot = {
    pendingClarification: payload.pendingClarification ?? null,
    action: {
      ...(actionState.action ?? {}),
      status: actionState.lifecycle ?? actionState.action?.status ?? null,
      currentStep: currentStep
        ? {
            id: currentStep.stepId ?? currentStep.id ?? null,
            title: currentStep.title ?? null,
            status: currentStep.status ?? (currentStep.state === "available" ? "ready" : currentStep.state),
            mode: currentStep.mode ?? null,
          }
        : null,
    },
    currentChangeSet: actionState.currentChangeSet ?? null,
  };
  const plan = oracleInterpretJson(message, snapshot);

  if (plan.routing === "general_store") {
    return { done: true, routing: "general_store", confidence: 0.9 };
  }
  if (plan.requiresClarification) {
    return {
      done: true,
      requiresClarification: true,
      clarificationQuestion: plan.clarificationQuestion ?? "Which did you mean?",
      confidence: 0.9,
    };
  }

  const toolCalls = (plan.operations ?? [])
    .map((/** @type {any} */ op) => operationToToolCall(op))
    .filter(Boolean);

  if (toolCalls.length === 0) {
    return { done: true, finalReply: "Done.", confidence: 0.9 };
  }

  return { done: false, toolCalls, confidence: 0.9 };
}

/** @param {{ command: string; arguments?: Record<string, any>; params?: Record<string, any> }} op */
function operationToToolCall(op) {
  const command = String(op.command ?? "");
  let tool = COMMAND_TO_TOOL[command] ?? null;
  const args = { ...(op.arguments ?? op.params ?? {}) };

  if (command === ACTION_COMMAND.START_STEP) {
    tool = "start_step";
  }
  if (command === ACTION_COMMAND.GO_BACK) {
    tool = "go_back";
  }
  if (command === ACTION_COMMAND.GO_TO_STEP) {
    tool = "go_to_step";
  }
  if (command === ACTION_COMMAND.SKIP_STEP) {
    tool = "skip_step";
  }
  if (command === ACTION_COMMAND.ADVANCE_STEP) {
    tool = "advance_step";
  }
  if (command === ACTION_COMMAND.ANSWER && args.simulate) {
    tool = "simulate_plan";
  }
  if (!tool) return null;
  return { tool, arguments: args };
}

/** @param {Record<string, any>} args */
function inferOutcomeFromCommandArgs(args) {
  const hint = String(args.targetHint ?? args.outcome ?? "").toLowerCase();
  if (/supplier|email|message/.test(hint)) return "supplier_draft";
  if (/proposal|replenish/.test(hint)) return "replenishment_proposal";
  if (/inventory|review/.test(hint)) return "inventory_review";
  return "replenishment_proposal";
}
