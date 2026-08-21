// @ts-check

/**
 * Canonical action state projection. Chat, UI, and the Action Agent all consume
 * this so workflow availability is derived from facts — not stale waiting flags.
 */

import { getMerchantAction } from "./merchant-action.server.js";
import { getCurrentChangeSet } from "./action-changeset.server.js";
import {
  ACTION_STEP_STATUS,
  healInconsistentWorkflow,
  reconcileWorkflow,
} from "./action-step-lifecycle.server.js";
import {
  actionRuntimeKind,
  resolveActionContext,
} from "./resolved-action-context.server.js";
import { planSchemaForAgent } from "./action-plan-schema.server.js";
import {
  buildActionWorkspace,
  workspacePlanItems,
} from "./action-workspace.server.js";

/** @typedef {"available" | "blocked" | "running" | "complete" | "needs_input" | "needs_attention" | "needs_updating" | "skipped"} WorkState */

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   conversationId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function resolveActionState(prisma, input) {
  const baseInput = { ...input, skipWorkProjection: true };
  const action = await getMerchantAction(prisma, baseInput);
  if (!action) return null;

  const [resolved, changeSet, operationHistory] = await Promise.all([
    resolveActionContext(prisma, baseInput),
    getCurrentChangeSet(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    }),
    loadShopifyOperationHistory(prisma, input),
  ]);

  const kind = actionRuntimeKind(action);
  const workflowSteps = Array.isArray(action.workflow?.steps)
    ? action.workflow.steps
    : [];
  const displaySteps = kind === "agentic_shopify"
    ? []
    : Array.isArray(action.displaySteps)
    ? action.displaySteps
    : [];
  const steps = orderedSteps(workflowSteps.length > 0 ? workflowSteps : displaySteps).filter(
    (step) =>
      String(step?.status ?? "") !== ACTION_STEP_STATUS.superseded &&
      String(step?.status ?? "") !== "superseded",
  );
  const byId = new Map(steps.map((step) => [String(step.id), step]));
  const planVersion = resolved?.plan?.version ?? null;
  const constraintVersion = resolved?.constraintVersion ?? null;
  const inputHash = resolved?.inputHash ?? null;
  const scopeVersion = resolved?.scopeVersion ?? null;
  const evidenceVersion = resolved?.evidenceVersion ?? null;

  /** @type {any[]} */
  const work = steps.map((step) => {
    const deps = Array.isArray(step.dependsOnStepIds)
      ? step.dependsOnStepIds
      : [];
    const depsSatisfied = deps.every((/** @type {string} */ id) => {
      const dep = byId.get(String(id));
      if (!dep) return true;
      if (!isTerminal(dep)) return false;
      return !isArtifactStale(dep, {
        planVersion,
        constraintVersion,
        inputHash,
        scopeVersion,
        evidenceVersion,
      });
    });
    const stale = isArtifactStale(step, {
      planVersion,
      constraintVersion,
      inputHash,
      scopeVersion,
      evidenceVersion,
    });
    const persisted = String(step.status ?? "");

    // Blockers are a property of the dependency graph, not of which branch
    // below happens to fire. Computing them only in the `blocked` branch was
    // why a stale-but-completed step reported no prerequisites, so its own
    // stale inputs were never rebuilt and it produced yesterday's numbers.
    /** @type {any[]} */
    const blockers = depsSatisfied
      ? []
      : dependencyBlockers(deps, byId, {
          planVersion,
          constraintVersion,
          inputHash,
          scopeVersion,
          evidenceVersion,
        });

    /** @type {WorkState} */
    let state = "blocked";

    // Order matters: what a step *is* outranks what mode it was defined with.
    // Checking `evidence_required` before terminality is why a merchant's
    // uploaded file left its step reporting "needs you" forever, which in turn
    // kept every dependent blocked.
    if (persisted === ACTION_STEP_STATUS.skipped) {
      state = "skipped";
    } else if (persisted === ACTION_STEP_STATUS.running) {
      state = "running";
    } else if (persisted === ACTION_STEP_STATUS.needsAttention) {
      state = "needs_attention";
    } else if (stale || persisted === ACTION_STEP_STATUS.needsUpdating) {
      state = "needs_updating";
    } else if (isTerminal(step)) {
      // An out-of-date prerequisite makes a finished result out of date too.
      state = depsSatisfied ? "complete" : "needs_updating";
    } else if (
      persisted === ACTION_STEP_STATUS.needsMerchant ||
      step.mode === "merchant_action" ||
      step.mode === "evidence_required"
    ) {
      state = "needs_input";
    } else if (!depsSatisfied) {
      state = "blocked";
    } else if (
      persisted === ACTION_STEP_STATUS.ready ||
      persisted === ACTION_STEP_STATUS.waiting ||
      persisted === "pending" ||
      persisted === ACTION_STEP_STATUS.draft
    ) {
      state = "available";
    }

    return {
      step: {
        id: step.id,
        title: step.title ?? null,
        orderIndex: step.orderIndex ?? null,
        mode: step.mode ?? null,
        capabilityRef: step.capabilityRef ?? null,
      },
      state,
      dependsOn: deps.map((/** @type {any} */ id) => String(id)),
      validResult: step.progress ?? null,
      stale,
      blockers,
    };
  });

  const nextUsefulWork =
    work.find(
      (row) => row.state === "available" || row.state === "needs_updating",
    ) ??
    work.find((row) => row.state === "running") ??
    null;

  const artifacts = work
    .filter((row) => row.validResult?.artifactType)
    .map((row) => ({
      stepId: row.step.id,
      title: row.step.title,
      artifactType: row.validResult.artifactType,
      stale: row.stale,
      current: !row.stale && row.state === "complete",
    }));

  const baseState = {
    action: {
      id: action.id,
      title: action.title ?? null,
      status: action.status ?? null,
      actionType: action.actionType ?? null,
      kind,
      semanticAction: resolved?.semanticAction ?? semanticActionFromAction(action),
      outcome: action.outcome ?? null,
    },
    lifecycle: action.status ?? null,
    outcome: action.outcome ?? null,
    plan: resolved?.plan ?? { values: {}, version: null },
    planSchema: planSchemaForAgent(action),
    constraints: resolved?.constraints ?? [],
    constraintVersion,
    scopeVersion,
    evidenceVersion,
    scope: resolved?.scope ?? { items: [], excluded: [] },
    canonicalProposal: resolved?.canonicalProposal ?? null,
    semanticAction: resolved?.semanticAction ?? semanticActionFromAction(action),
    inputHash,
    work,
    nextUsefulWork,
    artifacts,
    operationHistory,
    currentChangeSet: changeSet
      ? {
          id: changeSet.id ?? null,
          status: changeSet.status ?? null,
          itemCount: Array.isArray(changeSet.items)
            ? changeSet.items.length
            : 0,
        }
      : null,
    currentStep: action.currentStep ?? null,
  };
  const workspace = buildActionWorkspace(action, {
    work,
    artifacts,
    currentChangeSet: baseState.currentChangeSet,
  });
  return {
    ...baseState,
    workspace,
    currentFocus: workspace?.currentFocus ?? null,
    actionState: workspace?.actionState ?? baseState.lifecycle,
  };
}

/**
 * Compact snapshot for the LLM agent planner.
 *
 * @param {any} state
 */
export function buildAgentStateContext(state) {
  if (!state) return null;
  return {
    action: state.action,
    semanticAction: state.semanticAction
      ? {
          title: state.semanticAction.title ?? null,
          summary: state.semanticAction.summary ?? null,
          outcome: state.semanticAction.outcome ?? null,
          whyThisAction: state.semanticAction.whyThisAction ?? null,
          whyNow: state.semanticAction.whyNow ?? null,
          scope: state.semanticAction.scope ?? null,
          constraints: state.semanticAction.constraints ?? [],
          materialExpectedEffects: state.semanticAction.materialExpectedEffects ?? [],
          verificationPlan: state.semanticAction.verificationPlan ?? null,
          revision: state.semanticAction.revision ?? null,
        }
      : null,
    lifecycle: state.lifecycle,
    plan: state.plan?.values ?? {},
    planSchema: state.planSchema,
    constraints: (state.constraints ?? []).map((/** @type {any} */ row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
    })),
    scope: (state.scope?.items ?? [])
      .slice(0, 12)
      .map((/** @type {any} */ item) => ({
      title: item.title,
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      vendor: item.vendor ?? null,
      recommendedUnits: item.recommendedUnits ?? null,
      toType: item.toType ?? null,
      fromType: item.fromType ?? null,
    })),
    scopeStatus: state.scope?.status ?? null,
    originalEvidence: state.scope?.originalEvidence ?? null,
    excluded: (state.scope?.excluded ?? [])
      .slice(0, 8)
      .map((/** @type {any} */ item) => ({
      title: item.title,
      reason: item.reason ?? null,
    })),
    work: (state.work ?? []).map((/** @type {any} */ row) => ({
      stepId: row.step.id,
      title: row.step.title,
      capabilityRef: row.step.capabilityRef,
      state: row.state,
      stale: row.stale,
      blockers: row.blockers,
    })),
    artifacts: state.artifacts ?? [],
    workspace: state.workspace
      ? {
          actionState: state.workspace.actionState,
          currentFocus: state.workspace.currentFocus,
          items: (state.workspace.items ?? []).map((/** @type {any} */ item) => ({
            id: item.id,
            title: item.title,
            kind: item.kind,
            state: item.state,
            showInPlan: item.showInPlan !== false,
          })),
        }
      : null,
    outcome: compactOutcome(state.outcome ?? state.action?.outcome),
    shopifyOperations: Array.isArray(state.operationHistory)
      ? state.operationHistory
      : [],
    canonicalProposal: state.canonicalProposal
      ? {
          revision: state.canonicalProposal.revision ?? null,
          coverDays: state.canonicalProposal.coverDays ?? null,
          inputFingerprint: state.canonicalProposal.inputFingerprint ?? null,
          items: (state.canonicalProposal.items ?? []).map((/** @type {any} */ item) => ({
            title: item.title,
            recommendedUnits: item.recommendedUnits ?? null,
          })),
        }
      : null,
    currentChangeSet: state.currentChangeSet,
    currentStep: state.currentStep
      ? {
          id: state.currentStep.id ?? null,
          title: state.currentStep.title ?? null,
          status: state.currentStep.status ?? null,
          mode: state.currentStep.mode ?? null,
        }
      : null,
    outcomes: listAvailableOutcomes(state),
  };
}

/** @param {any} prisma @param {{ merchantId: string; shopId: string; actionId: string }} input */
async function loadShopifyOperationHistory(prisma, input) {
  if (!prisma?.shopifyOperationCall?.findMany) return [];
  try {
    const rows = await prisma.shopifyOperationCall.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        merchantActionId: input.actionId,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map(serializeShopifyOperationCall).reverse();
  } catch {
    return [];
  }
}

/** @param {any} row */
function serializeShopifyOperationCall(row) {
  return {
    id: row.id ?? null,
    operationName: row.operationName ?? null,
    operationKind: row.operationKind ?? null,
    status: row.status ?? null,
    gatewayDecision: row.gatewayDecision ?? null,
    acceptedActionRevision: row.acceptedActionRevision ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    purpose: row.purpose ?? "",
    expectedEffect: row.expectedEffect ?? "",
    resourceIds: Array.isArray(row.resourceIds) ? row.resourceIds.slice(0, 20) : [],
    responseSummary: compactValue(row.responseSummary),
    error: row.error ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt ?? null,
  };
}

/** @param {unknown} value */
function compactOutcome(value) {
  const outcome = jsonObject(value);
  const verification = jsonObject(outcome.verification);
  return {
    verified: verification.verified === true,
    progressSummary:
      typeof outcome.progressSummary === "string"
        ? outcome.progressSummary
        : null,
    verification: Object.keys(verification).length > 0
      ? {
          verified: verification.verified === true,
          evidence: Array.isArray(verification.evidence)
            ? verification.evidence.slice(0, 8)
            : [],
          remaining: Array.isArray(verification.remaining)
            ? verification.remaining.slice(0, 8)
            : [],
        }
      : null,
  };
}

/** @param {unknown} value @returns {unknown} */
function compactValue(value) {
  if (!value || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 12).map(compactValue);
  return Object.fromEntries(
    Object.entries(/** @type {Record<string, unknown>} */ (value))
      .slice(0, 16)
      .map(([key, item]) => [key, compactValue(item)]),
  );
}

/** @param {any} state */
export function listAvailableOutcomes(state) {
  const kind = state?.action?.kind ?? "generic";
  /** @type {string[]} */
  const outcomes = ["inspect_scope", "inspect_proposal"];
  if (kind === "restock") {
    outcomes.push(
      "inventory_review",
      "replenishment_proposal",
      "supplier_draft",
    );
  }
  if (kind === "markdown") {
    outcomes.push("changeset_preview", "apply_changes");
  }
  if (kind === "listing_copy") {
    outcomes.push(
      "product_type_discovery",
      "changeset_preview",
      "apply_changes",
    );
  }
  if (kind === "agentic_shopify") {
    outcomes.push(
      "semantic_action_review",
      "semantic_scope_review",
      "expected_shopify_effects",
      "post_acceptance_verification",
    );
  }
  return outcomes;
}

/**
 * @param {any} state
 * @param {string} outcome
 */
export function findStepForOutcome(state, outcome) {
  const ref = outcomeCapabilityRef(outcome);
  if (!ref) return null;
  const row = (state?.work ?? []).find(
    (/** @type {any} */ item) => item.step.capabilityRef === ref,
  );
  return row?.step ?? null;
}

/** @param {string} outcome */
export function outcomeCapabilityRef(outcome) {
  /** @type {Record<string, string>} */
  const map = {
    inventory_review: "assist:inventory_review",
    replenishment_proposal: "assist:replenishment_proposal",
    supplier_draft: "assist:supplier_email_draft",
    supplier_communication: "assist:supplier_email_draft",
    supplier_email: "assist:supplier_email_draft",
    cost_analysis: "assist:cost_analysis",
    analysis: "assist:cost_analysis",
  };
  return map[outcome] ?? null;
}

/**
 * Whether a projected work row still needs Jefe to run (or re-run) assist execution.
 *
 * @param {{ state?: WorkState; stale?: boolean } | null | undefined} workRow
 */
export function workNeedsExecution(workRow) {
  if (!workRow) return true;
  if (workRow.state === "skipped") return false;
  if (workRow.state === "complete" && !workRow.stale) return false;
  return true;
}

/** @param {any} step @param {{ planVersion?: string | null; constraintVersion?: string | null; inputHash?: string | null; scopeVersion?: string | null; evidenceVersion?: string | null }} versions */
export function isArtifactStale(step, versions) {
  const progress = step?.progress;
  if (!progress || typeof progress !== "object" || !progress.artifactType)
    return false;
  if (
    progress.inputHash &&
    versions.inputHash &&
    progress.inputHash !== versions.inputHash
  ) {
    return true;
  }
  if (
    progress.planVersion &&
    versions.planVersion &&
    progress.planVersion !== versions.planVersion
  ) {
    return true;
  }
  if (
    progress.constraintVersion &&
    versions.constraintVersion &&
    progress.constraintVersion !== versions.constraintVersion
  ) {
    return true;
  }
  if (
    progress.scopeVersion &&
    versions.scopeVersion &&
    progress.scopeVersion !== versions.scopeVersion
  ) {
    return true;
  }
  if (
    progress.evidenceVersion &&
    versions.evidenceVersion &&
    progress.evidenceVersion !== versions.evidenceVersion
  ) {
    return true;
  }
  return false;
}

/** @param {string[]} deps @param {Map<string, any>} byId @param {any} versions */
function dependencyBlockers(deps, byId, versions) {
  return deps
    .map((id) => byId.get(String(id)))
    .filter((step) => {
      if (!step) return false;
      if (!isTerminal(step)) return true;
      return isArtifactStale(step, versions);
    })
    .map((step) => ({
      type: isArtifactStale(step, versions)
        ? "STEP_RESULT_STALE"
        : "STEP_RESULT_REQUIRED",
      stepId: step.id,
      title: step.title ?? null,
      reason: isArtifactStale(step, versions)
        ? `"${step.title ?? step.id}" needs updating after your latest changes.`
        : `"${step.title ?? step.id}" must complete first.`,
    }));
}

/** @param {any} step */
function isTerminal(step) {
  if (!step) return true;
  const status = String(step.status ?? "");
  return (
    status === ACTION_STEP_STATUS.completed ||
    status === ACTION_STEP_STATUS.skipped ||
    status === ACTION_STEP_STATUS.superseded
  );
}

/** @param {any[]} steps */
function orderedSteps(steps) {
  const seen = new Set();
  return [...steps]
    .filter((step) => {
      const id = String(step?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort(
      (left, right) =>
        Number(left.orderIndex ?? 0) - Number(right.orderIndex ?? 0),
    );
}

/**
 * Attach derived workflow projection to a serialized merchant action for UI/chat.
 *
 * @param {any} serialized
 * @param {any} state
 */
export function applyWorkProjectionToAction(serialized, state) {
  if (!serialized || !state) return serialized;
  const workByStepId = new Map(
    (state.work ?? []).map((/** @type {any} */ row) => [
      String(row.step.id),
      row,
    ]),
  );
  /** @param {any[]} steps */
  const mergeSteps = (steps) =>
    (Array.isArray(steps) ? steps : []).map((step) => {
      if (!step || typeof step === "string") return step;
      const work = workByStepId.get(String(step.id ?? ""));
      if (!work) return step;
      return {
        ...step,
        workState: work.state,
        workStale: work.stale === true,
        blockers: work.blockers ?? [],
        done:
          work.state === "complete" ||
          work.state === "skipped" ||
          step.done === true,
      };
    });

  serialized.workProjection = {
    work: state.work ?? [],
    nextUsefulWork: state.nextUsefulWork ?? null,
    artifacts: state.artifacts ?? [],
    planSchema: state.planSchema ?? null,
  };
  if (state.workspace) {
    serialized.workspace = state.workspace;
    serialized.currentFocus = state.currentFocus ?? state.workspace.currentFocus;
    serialized.actionState = state.actionState ?? state.workspace.actionState;
    serialized.displaySteps = workspacePlanItems(state.workspace);
  }
  serialized.displaySteps = mergeSteps(serialized.displaySteps);
  if (serialized.workflow?.steps) {
    serialized.workflow = {
      ...serialized.workflow,
      steps: mergeSteps(serialized.workflow.steps),
    };
  }
  if (serialized.currentStep && typeof serialized.currentStep === "object") {
    const work = workByStepId.get(String(serialized.currentStep.id ?? ""));
    if (work) {
      serialized.currentStep = {
        ...serialized.currentStep,
        workState: work.state,
        workStale: work.stale === true,
        blockers: work.blockers ?? [],
      };
    }
  }
  if (state.nextUsefulWork?.step && !serialized.currentStep) {
    serialized.currentStep = {
      ...state.nextUsefulWork.step,
      workState: state.nextUsefulWork.state,
      status: mapWorkStateToPersistedStatus(state.nextUsefulWork.state),
    };
  }
  return serialized;
}

/** @param {string} workState */
function mapWorkStateToPersistedStatus(workState) {
  if (workState === "running") return "running";
  if (workState === "complete") return "completed";
  if (workState === "needs_input") return "needs_merchant";
  if (workState === "needs_attention") return "needs_attention";
  if (workState === "needs_updating") return "needs_updating";
  if (workState === "skipped") return "skipped";
  return "ready";
}

/** @param {any} action */
function semanticActionFromAction(action) {
  const progress = jsonObject(action?.progress);
  const plan = jsonObject(action?.plan);
  const fromProgress = jsonObject(jsonObject(progress.agentic).semanticAction);
  if (Object.keys(fromProgress).length > 0) return fromProgress;
  const fromPlan = jsonObject(jsonObject(plan.agentic).semanticAction);
  return Object.keys(fromPlan).length > 0 ? fromPlan : null;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Repair workflow before goal-oriented execution.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function refreshWorkflowState(prisma, input) {
  await healInconsistentWorkflow(prisma, input);
  const action = await getMerchantAction(prisma, input);
  const workflowId =
    action?.workflow?.id ??
    action?.sourceRecommendation?.workflows?.[0]?.id ??
    null;
  if (!workflowId) return action;
  await reconcileWorkflow(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    workflowId,
  });
  return getMerchantAction(prisma, input);
}
