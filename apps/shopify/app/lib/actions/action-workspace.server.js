// @ts-check

/**
 * Action Workspace V2 projection.
 *
 * This layer gives accepted recommendations outcome-oriented semantics without
 * discarding the legacy workflow rows that still power existing step runs.
 */

import {
  CAPABILITY_AVAILABILITY,
  INTENDED_ACTOR,
  resolveStepCapabilityTruth,
} from "./shopify-action-capabilities.server.js";

export const ACTION_WORKSPACE_VERSION = 2;

export const WORKSPACE_ITEM_KIND = Object.freeze({
  decision: "decision",
  artifact: "artifact",
  execution: "execution",
  externalWait: "external_wait",
  evidence: "evidence",
  merchantAction: "merchant_action",
  plan: "plan",
});

export const WORKSPACE_FOCUS_KIND = Object.freeze({
  failure: "failure",
  merchantAttention: "merchant_attention",
  artifactReview: "artifact_review",
  jefeWorking: "jefe_working",
  externalWait: "external_wait",
  integrationLimitation: "integration_limitation",
  optionalWork: "optional_work",
  completed: "completed",
  onTrack: "on_track",
});

const RESTOCK_EVIDENCE_REFS = new Set(["assist:inventory_review"]);

/**
 * @typedef {{
 *   id?: string | null;
 *   stepId?: string | null;
 *   title?: string | null;
 *   kind?: string | null;
 *   state?: string | null;
 *   statusReason?: string | null;
 *   description?: string | null;
 *   summary?: string | null;
 *   showInPlan?: boolean;
 *   statusLabel?: string | null;
 *   legacyMode?: string | null;
 *   capabilityRef?: string | null;
 *   intendedActor?: string | null;
 *   approvalRequired?: boolean;
 *   capabilityAvailability?: string | null;
 *   workState?: string | null;
 *   artifact?: any;
 *   orderIndex?: number | null;
 * }} WorkspaceItem
 */

/**
 * @param {any} action
 * @param {{ work?: any[]; artifacts?: any[]; currentChangeSet?: any | null }} [projection]
 */
export function buildActionWorkspace(action, projection = {}) {
  const existing = normalizeWorkspace(action?.progress?.workspace);
  const kind = actionKind(action);
  const steps = prepareWorkflowStepsForWorkspaceV2(workflowSteps(action), {
    title: action?.title,
    summary: action?.summary,
  });
  if (existing && existing.version === ACTION_WORKSPACE_VERSION && kind !== "restock") {
    return refreshWorkspace(existing, action, projection);
  }
  if (kind !== "restock") return null;

  if (steps.length === 0) {
    return existing ? refreshWorkspace(existing, action, projection) : null;
  }
  const projectedItems = steps
    .map((/** @type {any} */ step, /** @type {number} */ index) =>
      workspaceItemFromStep(step, { kind, index }),
    )
    .filter(Boolean);

  const workspace = {
    ...(existing ?? {}),
    version: ACTION_WORKSPACE_VERSION,
    schemaVersion: 1,
    source: "workflow_projection",
    kind,
    goal: safeText(action?.title, 180) || "Carry out this action.",
    items: mergeWorkspaceItems(projectedItems, existing?.items ?? []),
    artifacts: existing?.artifacts ?? [],
    currentFocus: null,
    actionState: "on_track",
    updatedAt: new Date().toISOString(),
  };
  return refreshWorkspace(workspace, action, projection);
}

/**
 * Remove recommendation-evidence-as-work from newly persisted restock workflows.
 *
 * @param {any[] | undefined | null} steps
 * @param {{ title?: string | null; summary?: string | null }} recommendation
 */
export function prepareWorkflowStepsForWorkspaceV2(steps, recommendation = {}) {
  const rows = Array.isArray(steps) ? steps : [];
  const hasInventoryTransfer = rows.some(isInventoryTransferExecuteStep);
  const restock = isRestockText(
    `${recommendation.title ?? ""} ${recommendation.summary ?? ""} ${rows
      .map((step) => `${step?.title ?? ""} ${step?.capabilityRef ?? ""}`)
      .join(" ")}`,
  );
  if (!restock) return rows;
  let preparedRows = hasInventoryTransfer
    ? removeInventoryTransferMerchantWork(rows)
    : rows;
  const hasProposal = preparedRows.some(
    (/** @type {any} */ step) => step?.capabilityRef === "assist:replenishment_proposal",
  );
  if (!hasProposal) return preparedRows;

  const removed = new Set(
    preparedRows
      .filter((/** @type {any} */ step) =>
        RESTOCK_EVIDENCE_REFS.has(String(step?.capabilityRef ?? "")),
      )
      .map((/** @type {any} */ step) => String(step?.id ?? ""))
      .filter(Boolean),
  );
  if (removed.size === 0) return preparedRows;

  return preparedRows
    .filter((/** @type {any} */ step) => !removed.has(String(step?.id ?? "")))
    .map((/** @type {any} */ step) => ({
      ...step,
      dependsOnStepIds: /** @type {any[]} */ (Array.isArray(step?.dependsOnStepIds)
        ? step.dependsOnStepIds
        : []
      ).filter((/** @type {any} */ id) => !removed.has(String(id))),
    }));
}

/**
 * @param {any} workspace
 * @param {any} action
 * @param {{ work?: any[]; artifacts?: any[]; currentChangeSet?: any | null }} projection
 */
export function refreshWorkspace(workspace, action, projection = {}) {
  const workByStepId = new Map(
    (projection.work ?? []).map((row) => [String(row?.step?.id ?? ""), row]),
  );
  /** @type {WorkspaceItem[]} */
  const existingItems = Array.isArray(workspace.items) ? workspace.items : [];
  const items = existingItems.map((item) =>
    refreshWorkspaceItem(item, {
      action,
      work: workByStepId.get(String(item.stepId ?? "")) ?? null,
      changeSet: projection.currentChangeSet ?? null,
    }),
  );
  const artifacts = artifactIndexFromItems(items, projection.artifacts ?? []);
  const refreshed = {
    ...workspace,
    version: ACTION_WORKSPACE_VERSION,
    items,
    artifacts,
    actionState: resolveWorkspaceActionState({ ...workspace, items }, action),
    updatedAt: new Date().toISOString(),
  };
  return {
    ...refreshed,
    currentFocus: resolveWorkspaceFocus(refreshed, action),
  };
}

/** @param {any} workspace @param {any} action */
export function resolveWorkspaceFocus(workspace, action = {}) {
  /** @type {WorkspaceItem[]} */
  const items = Array.isArray(workspace?.items) ? workspace.items : [];
  const failed = items.find((item) =>
    ["failed", "blocked", "needs_attention"].includes(String(item.state ?? "")),
  );
  if (failed) {
    return focus("failure", failed, {
      eyebrow: "Needs attention",
      headline: safeText(failed.title, 160) || "Action problem",
      reason:
        failed.statusReason ||
        failed.description ||
        "Jefe hit a problem on this action.",
    });
  }

  const limitation = items.find((item) =>
    ["integration_limitation", "integration_not_available"].includes(String(item.state ?? "")),
  );
  if (limitation) {
    return focus("integration_limitation", limitation, {
      eyebrow: "Limitation",
      headline: safeText(limitation.title, 160) || "Integration limitation",
      reason:
        limitation.capabilityAvailability === "UNSUPPORTED_BY_PROVIDER"
          ? "Shopify doesn't currently expose this operation through the public app API."
          : limitation.description || "Jefe cannot execute this through the integration yet.",
    });
  }

  const merchant = items.find((item) =>
    ["needs_merchant", "approval_required"].includes(String(item.state ?? "")),
  );
  if (merchant) {
    return focus("merchant_attention", merchant, {
      eyebrow: "Needs you",
      headline: safeText(merchant.title, 160) || "Needs your input",
      reason: merchant.description || "This needs your input before it moves.",
    });
  }

  const artifact = items.find(
    (item) =>
      item.kind === WORKSPACE_ITEM_KIND.artifact &&
      ["ready", "draft", "stale"].includes(String(item.state ?? "")),
  );
  if (artifact) {
    return focus("artifact_review", artifact, {
      eyebrow: artifact.state === "stale" ? "Needs update" : "Ready for review",
      headline: safeText(artifact.title, 160) || "Review the draft",
      reason: artifact.summary || artifact.description || "A draft is ready.",
    });
  }

  const running = items.find((item) =>
    ["running", "queued"].includes(String(item.state ?? "")),
  );
  if (running) {
    return focus("jefe_working", running, {
      eyebrow: "Jefe is working",
      headline: safeText(running.title, 160) || "Jefe is working",
      reason: running.description || "Jefe is working on this now.",
    });
  }

  const waiting = items.find(
    (item) =>
      item.kind === WORKSPACE_ITEM_KIND.externalWait &&
      ["waiting", "active"].includes(String(item.state ?? "")),
  );
  if (waiting) {
    return focus("external_wait", waiting, {
      eyebrow: "Waiting",
      headline: safeText(waiting.title, 160) || "Waiting on external progress",
      reason: waiting.summary || waiting.description || "Waiting on external progress.",
    });
  }

  if (String(action?.status ?? "") === "completed") {
    return {
      kind: WORKSPACE_FOCUS_KIND.completed,
      priority: 70,
      eyebrow: "Completed",
      headline: safeText(action?.title, 160) || "Action completed",
      reason: "The outcome for this action is complete.",
      itemId: null,
      stepId: null,
    };
  }

  const optional = items.find((item) =>
    ["draft", "not_created", "manual", "integration_not_available", "integration_limitation", "current"].includes(
      String(item.state ?? ""),
    ),
  );
  if (optional) {
    return focus("optional_work", optional, {
      eyebrow: "Current focus",
      headline: safeText(optional.title, 160) || "Current focus",
      reason: optional.summary || optional.description || "This is the next useful part of the action.",
    });
  }

  return {
    kind: WORKSPACE_FOCUS_KIND.onTrack,
    priority: 80,
    eyebrow: "On track",
    headline: "Nothing needs your attention right now.",
    reason: "Jefe will surface the next useful thing when reality changes.",
    itemId: null,
    stepId: null,
  };
}

/**
 * @param {any} workspace
 */
export function workspacePlanItems(workspace) {
  /** @type {WorkspaceItem[]} */
  const items = Array.isArray(workspace?.items) ? workspace.items : [];
  return items
    .filter((item) => item.showInPlan !== false)
    .map((item, index) => ({
      id: item.stepId ?? item.id,
      label: item.title || `Item ${index + 1}`,
      title: item.title || `Item ${index + 1}`,
      description: item.description ?? null,
      status: null,
      statusLabel: item.statusLabel ?? stateLabel(item),
      mode: item.legacyMode ?? null,
      capabilityRef: item.capabilityRef ?? null,
      intendedActor: item.intendedActor ?? null,
      approvalRequired: item.approvalRequired === true,
      itemKind: item.kind,
      workspaceState: item.state,
      workState: item.workState ?? item.state,
      workStale: item.state === "stale",
      done: ["agreed", "sent", "succeeded", "completed"].includes(
        String(item.state ?? ""),
      ),
      progress: item.artifact ?? {},
      attention: {},
      orderIndex: item.orderIndex ?? index,
    }));
}

/** @param {any} workspace */
export function normalizeWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    return null;
  }
  if (Number(workspace.version) !== ACTION_WORKSPACE_VERSION) return null;
  return {
    ...workspace,
    items: Array.isArray(workspace.items) ? workspace.items : [],
    artifacts: Array.isArray(workspace.artifacts) ? workspace.artifacts : [],
  };
}

/** @param {any[]} rows */
function removeInventoryTransferMerchantWork(rows) {
  const removedIds = new Set(
    rows
      .filter((/** @type {any} */ step) => step?.capabilityRef === "merchant_action:external_purchase_order")
      .map((/** @type {any} */ step) => String(step?.id ?? ""))
      .filter(Boolean),
  );
  const retained = rows.filter((/** @type {any} */ step) => !removedIds.has(String(step?.id ?? "")));
  const byId = new Map(retained.map((/** @type {any} */ step) => [String(step?.id ?? ""), step]));
  return retained.map((/** @type {any} */ step) => {
    const deps = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
    const dependsOnStepIds = deps.filter((/** @type {any} */ id) => {
      const depId = String(id);
      if (removedIds.has(depId)) return false;
      const dependency = byId.get(depId);
      if (!dependency) return false;
      if (isInventoryTransferExecuteStep(step)) {
        return [
          "assist:replenishment_proposal",
          "evidence:confirm_quantities",
        ].includes(String(dependency?.capabilityRef ?? ""));
      }
      return true;
    });
    return { ...step, dependsOnStepIds };
  });
}

/**
 * @param {any} step
 * @param {{ kind: string; index: number }} input
 */
function workspaceItemFromStep(step, input) {
  const semanticKey = semanticKeyForStep(step);
  const capabilityRef = safeText(step?.capabilityRef, 140) || null;
  const title = workspaceTitle(step, semanticKey);
  const common = {
    id: semanticKey,
    semanticKey,
    stepId: step?.id ?? null,
    orderIndex: Number.isFinite(Number(step?.orderIndex))
      ? Number(step.orderIndex)
      : input.index,
    title,
    description: safeText(step?.description, 260) || title,
    statusReason: safeText(step?.statusReason, 240) || null,
    legacyStatus: step?.status ?? null,
    legacyMode: step?.mode ?? null,
    capabilityRef,
    dataDependencies: Array.isArray(step?.dependsOnStepIds)
      ? step.dependsOnStepIds
      : [],
    navigationDependencies: [],
    showInPlan: true,
    artifact: jsonObject(step?.progress),
  };

  if (input.kind === "restock" && capabilityRef === "assist:inventory_review") {
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.evidence,
      state: "available",
      showInPlan: false,
      statusLabel: "Evidence",
    };
  }
  if (capabilityRef === "assist:replenishment_proposal") {
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.decision,
      state: "draft",
      statusLabel: "Draft",
      artifactKind: "replenishment_proposal",
    };
  }
  if (/supplier_email|supplier_sms|supplier_phone|supplier/.test(capabilityRef ?? "")) {
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.artifact,
      state: "not_created",
      statusLabel: "Not created",
      artifactKind:
        capabilityRef === "assist:supplier_email_draft"
          ? "supplier_email_draft"
          : "supplier_communication",
    };
  }
  if (/purchase order|\bpo\b/i.test(`${step?.title ?? ""} ${capabilityRef ?? ""}`)) {
    const capability = resolveStepCapabilityTruth(step);
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.execution,
      state:
        capability?.availability === CAPABILITY_AVAILABILITY.available ||
        capabilityRef?.startsWith("execute:")
          ? "ready"
          : "integration_limitation",
      statusLabel:
        capability?.availability === CAPABILITY_AVAILABILITY.available ||
        capabilityRef?.startsWith("execute:")
          ? "Ready"
          : "Integration limitation",
      artifactKind: "purchase_order",
      intendedActor: capability?.intendedActor ?? INTENDED_ACTOR.jefe,
      capabilityAvailability:
        capability?.availability ?? CAPABILITY_AVAILABILITY.unsupportedByJefe,
      capabilityTruth: capability,
    };
  }
  if (/fulfil|fulfill|waiting on supplier|supplier wait/i.test(step?.title ?? "")) {
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.externalWait,
      state: "waiting",
      statusLabel: "Waiting",
    };
  }
  if (/receive|arrived|stock arrived|goods received/i.test(step?.title ?? "")) {
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.evidence,
      state: "needs_merchant",
      statusLabel: "Needs confirmation",
    };
  }
  if (step?.mode === "execute") {
    const capability = resolveStepCapabilityTruth(step);
    const approvalRequired =
      capability?.approvalPolicy?.startsWith("MERCHANT_REQUIRED") === true;
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.execution,
      state: approvalRequired ? "approval_required" : "ready",
      statusLabel: approvalRequired ? "Approval required" : "Ready",
      intendedActor: capability?.intendedActor ?? INTENDED_ACTOR.jefe,
      approvalRequired,
      capabilityAvailability:
        capability?.availability ?? CAPABILITY_AVAILABILITY.available,
      capabilityTruth: capability,
    };
  }
  if (step?.mode === "merchant_action" || step?.mode === "evidence_required") {
    return {
      ...common,
      kind: WORKSPACE_ITEM_KIND.merchantAction,
      state: "needs_merchant",
      statusLabel: "Needs you",
    };
  }
  return {
    ...common,
    kind: WORKSPACE_ITEM_KIND.plan,
    state: "draft",
    statusLabel: "Planned",
  };
}

/**
 * @param {any} item
 * @param {{ action: any; work: any | null; changeSet?: any | null }} input
 */
function refreshWorkspaceItem(item, input) {
  const workState = input.work?.state ?? null;
  const stale = input.work?.stale === true;
  const artifact = jsonObject(input.work?.validResult ?? item.artifact);
  let state = item.state ?? "draft";

  if (workState === "running") state = "running";
  else if (workState === "needs_attention") state = "needs_attention";
  else if (stale) state = item.kind === WORKSPACE_ITEM_KIND.artifact ? "stale" : "stale";
  else if (workState === "complete") {
    if (item.kind === WORKSPACE_ITEM_KIND.decision) state = "current";
    else if (item.kind === WORKSPACE_ITEM_KIND.artifact) state = "ready";
    else state = "completed";
  } else if (workState === "needs_input") state = "needs_merchant";
  else if (workState === "available" && item.kind === WORKSPACE_ITEM_KIND.artifact)
    state = artifact.artifactType ? "ready" : "not_created";

  if (
    item.kind === WORKSPACE_ITEM_KIND.merchantAction &&
    item.semanticKey === "create_purchase_order"
  ) {
    state = input.changeSet?.status === "approved" ? "approval_required" : state;
  }
  if (
    item.semanticKey === "create_purchase_order" &&
    ["UNSUPPORTED_BY_PROVIDER", "UNSUPPORTED_BY_JEFE", "PROVIDER_PREVIEW"].includes(
      String(item.capabilityAvailability ?? ""),
    )
  ) {
    state = "integration_limitation";
  }
  if (item.kind === WORKSPACE_ITEM_KIND.execution && item.approvalRequired === true) {
    const executionStatus = normalizeToken(
      input.action?.currentExecution?.status ?? input.action?.executionStatus,
    );
    if (["applied", "partially_applied"].includes(executionStatus)) {
      state = "completed";
    } else if (executionStatus === "approved") {
      state = "running";
    } else if (
      ["", "proposed"].includes(executionStatus) &&
      ["ready", "available", "approval_required"].includes(state)
    ) {
      state = "approval_required";
    }
  }

  return {
    ...item,
    state,
    workState: workState ?? item.workState ?? null,
    statusLabel: stateLabel({ ...item, state }),
    artifact,
    summary: artifact.summary ?? item.summary ?? null,
    sourceInputHash: artifact.inputHash ?? null,
  };
}

/** @param {any[]} projectedItems @param {any[]} existingItems */
function mergeWorkspaceItems(projectedItems, existingItems) {
  const byStepId = new Map(
    existingItems
      .filter((item) => item?.stepId)
      .map((item) => [String(item.stepId), item]),
  );
  const bySemanticKey = new Map(
    existingItems
      .filter((item) => item?.semanticKey)
      .map((item) => [String(item.semanticKey), item]),
  );
  return projectedItems.map((item) => {
    const prior =
      byStepId.get(String(item.stepId ?? "")) ??
      bySemanticKey.get(String(item.semanticKey ?? "")) ??
      null;
    if (!prior) return item;
    const resetApprovalExecution =
      item.kind === WORKSPACE_ITEM_KIND.execution && item.approvalRequired === true;
    return {
      ...prior,
      ...item,
      state: resetApprovalExecution ? item.state : (prior.state ?? item.state),
      workState: resetApprovalExecution
        ? (item.workState ?? null)
        : (prior.workState ?? item.workState ?? null),
      artifact: jsonObject(prior.artifact ?? item.artifact),
      summary: prior.summary ?? item.summary ?? null,
      statusLabel: item.statusLabel ?? prior.statusLabel ?? null,
    };
  });
}

/** @param {any[]} items @param {any[]} projectedArtifacts */
function artifactIndexFromItems(items, projectedArtifacts) {
  const artifacts = [];
  for (const item of items) {
    const artifact = jsonObject(item.artifact);
    const artifactType = artifact.artifactType ?? item.artifactKind ?? null;
    if (!artifactType) continue;
    if (!artifact.artifactType && !item.artifactKind) continue;
    artifacts.push({
      id: `${item.semanticKey}:${artifactType}`,
      itemId: item.id,
      stepId: item.stepId,
      kind: artifactType,
      state: item.state,
      current: ["current", "ready", "agreed"].includes(String(item.state ?? "")),
      stale: item.state === "stale",
      revision: {
        inputHash: artifact.inputHash ?? null,
        planVersion: artifact.planVersion ?? null,
        scopeVersion: artifact.scopeVersion ?? null,
        evidenceVersion: artifact.evidenceVersion ?? null,
        createdAt: artifact.generatedAt ?? artifact.createdAt ?? null,
      },
      summary: artifact.summary ?? null,
    });
  }
  for (const artifact of projectedArtifacts) {
    if (!artifacts.some((row) => row.stepId === artifact.stepId)) {
      artifacts.push({
        id: `${artifact.stepId}:${artifact.artifactType}`,
        itemId: artifact.stepId,
        stepId: artifact.stepId,
        kind: artifact.artifactType,
        state: artifact.stale ? "stale" : artifact.current ? "ready" : "draft",
        current: artifact.current === true,
        stale: artifact.stale === true,
        revision: {},
        summary: null,
      });
    }
  }
  return artifacts;
}

/** @param {any} workspace @param {any} action */
function resolveWorkspaceActionState(workspace, action) {
  /** @type {WorkspaceItem[]} */
  const items = Array.isArray(workspace?.items) ? workspace.items : [];
  if (String(action?.status ?? "") === "completed") return "completed";
  if (items.some((item) => ["failed", "needs_attention"].includes(String(item.state ?? ""))))
    return "needs_attention";
  if (items.some((item) => ["needs_merchant", "approval_required"].includes(String(item.state ?? ""))))
    return "needs_merchant";
  if (items.some((item) => ["integration_limitation", "integration_not_available"].includes(String(item.state ?? ""))))
    return "limited";
  if (items.some((item) => ["running", "queued"].includes(String(item.state ?? ""))))
    return "jefe_working";
  if (
    items.some(
      (item) =>
        item.kind === WORKSPACE_ITEM_KIND.externalWait &&
        ["waiting", "active"].includes(String(item.state ?? "")),
    )
  ) {
    return "waiting_external";
  }
  return "on_track";
}

/** @param {string} kind @param {any} item @param {{ eyebrow: string; headline: string; reason: string }} text */
function focus(kind, item, text) {
  const priority = {
    failure: 10,
    merchant_attention: 20,
    artifact_review: 30,
    jefe_working: 40,
    external_wait: 50,
    integration_limitation: 55,
    optional_work: 60,
  }[kind] ?? 80;
  return {
    kind,
    priority,
    eyebrow: text.eyebrow,
    headline: text.headline,
    reason: text.reason,
    itemId: item.id ?? null,
    stepId: item.stepId ?? null,
    itemKind: item.kind ?? null,
  };
}

/** @param {any} item */
function stateLabel(item) {
  const state = String(item?.state ?? "");
  /** @type {Record<string, string>} */
  const labels = {
    draft: "Draft",
    current: "Current",
    agreed: "Agreed",
    stale: "Needs update",
    not_created: "Not created",
    ready: "Ready",
    sent: "Sent",
    running: "Running",
    queued: "Queued",
    completed: "Complete",
    needs_merchant: "Needs you",
    needs_attention: "Needs attention",
    integration_not_available: "Manual for now",
    integration_limitation: "Integration limitation",
    manual: "Manual",
    waiting: "Waiting",
    active: "Active",
    approval_required: "Approval required",
  };
  return labels[state] ?? state.replace(/_/g, " ");
}

/** @param {any} action */
function workflowSteps(action) {
  return [
    ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []),
    ...(Array.isArray(action?.sourceRecommendation?.workflow?.steps)
      ? action.sourceRecommendation.workflow.steps
      : []),
    ...(Array.isArray(action?.sourceRecommendation?.workflows?.[0]?.steps)
      ? action.sourceRecommendation.workflows[0].steps
      : []),
    ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []),
  ]
    .filter((step, index, all) => {
      if (!step || typeof step !== "object") return false;
      if (String(step.status ?? "") === "superseded") return false;
      const id = String(step.id ?? "");
      return !id || all.findIndex((candidate) => String(candidate?.id ?? "") === id) === index;
    })
    .sort((a, b) => Number(a.orderIndex ?? 0) - Number(b.orderIndex ?? 0));
}

/** @param {any} action */
function actionKind(action) {
  const type = String(action?.actionType ?? "");
  if (type === "price_markdown") return "markdown";
  if (type === "listing_copy") return "listing_copy";
  const haystack = [
    action?.title,
    action?.summary,
    ...(workflowSteps(action) ?? []).map(
      (step) => `${step?.title ?? ""} ${step?.capabilityRef ?? ""}`,
    ),
  ]
    .join(" ")
    .toLowerCase();
  if (isRestockText(haystack)) return "restock";
  return "generic";
}

/** @param {string} text */
function isRestockText(text) {
  return /\b(restock|replenish(?:ment)?|reorder|stock cover|supplier order|purchase order|\bpo\b)\b/i.test(
    text,
  );
}

/** @param {any} step */
function isInventoryTransferExecuteStep(step) {
  return (
    step?.mode === "execute" &&
    step?.capabilityRef === "execute:shopify_inventory_transfer:restock"
  );
}

/** @param {unknown} value */
function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** @param {any} step */
function semanticKeyForStep(step) {
  const capabilityRef = String(step?.capabilityRef ?? "");
  const title = String(step?.title ?? "");
  if (capabilityRef === "assist:inventory_review") return "review_low_cover_inventory";
  if (capabilityRef === "assist:replenishment_proposal")
    return "replenishment_proposal";
  if (capabilityRef === "assist:supplier_email_draft")
    return "supplier_communication";
  if (capabilityRef === "merchant_action:external_purchase_order")
    return "create_purchase_order";
  if (/purchase order|\bpo\b/i.test(`${title} ${capabilityRef}`))
    return "create_purchase_order";
  if (/fulfil|fulfill|waiting on supplier|supplier wait/i.test(title))
    return "supplier_fulfilment";
  if (/receive|arrived|stock arrived|goods received/i.test(title))
    return "receive_stock";
  return slug(title || capabilityRef || "workspace_item");
}

/** @param {any} step @param {string} semanticKey */
function workspaceTitle(step, semanticKey) {
  const explicit = safeText(step?.title, 120);
  if (semanticKey === "replenishment_proposal") return "Replenishment proposal";
  if (semanticKey === "supplier_communication") return "Supplier communication";
  if (semanticKey === "create_purchase_order") return "Create purchase order";
  if (semanticKey === "supplier_fulfilment") return "Supplier fulfilment";
  if (semanticKey === "receive_stock") return "Receive stock";
  return explicit;
}

/** @param {unknown} value */
function slug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/** @param {unknown} value @param {number} max */
function safeText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
