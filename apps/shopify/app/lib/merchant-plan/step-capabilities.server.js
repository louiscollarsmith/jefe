// @ts-check

import { listActionCapabilities, validateActionIntent } from "../actions/action-intent.server.js";

export const WORKFLOW_STEP_MODES = /** @type {const} */ ({
  execute: "execute",
  assist: "assist",
  merchantAction: "merchant_action",
  evidenceRequired: "evidence_required",
});

const ASSIST_CAPABILITIES = [
  {
    ref: "assist:inventory_review",
    mode: WORKFLOW_STEP_MODES.assist,
    label: "Review low-cover inventory",
    description: "Review at-risk SKUs, stock cover, and suggested reorder quantities.",
  },
  {
    ref: "assist:replenishment_proposal",
    mode: WORKFLOW_STEP_MODES.assist,
    label: "Build replenishment proposal",
    description: "Prepare a replenishment proposal from current low-cover evidence.",
  },
  {
    ref: "assist:supplier_email_draft",
    mode: WORKFLOW_STEP_MODES.assist,
    label: "Draft supplier email",
    description: "Draft a supplier email the merchant can send outside Jefe.",
  },
  {
    ref: "assist:supplier_sms_draft",
    mode: WORKFLOW_STEP_MODES.assist,
    label: "Draft supplier SMS",
    description: "Draft a short supplier SMS or WhatsApp message for the merchant to send.",
  },
  {
    ref: "assist:supplier_phone_script",
    mode: WORKFLOW_STEP_MODES.assist,
    label: "Prepare phone script",
    description: "Prepare the exact questions or script for a supplier phone call.",
  },
  {
    ref: "assist:merchant_checklist",
    mode: WORKFLOW_STEP_MODES.assist,
    label: "Prepare checklist",
    description: "Prepare a short checklist or calculation the merchant can follow.",
  },
];

const EVIDENCE_CAPABILITIES = [
  {
    ref: "evidence:upload_stock_receipt",
    mode: WORKFLOW_STEP_MODES.evidenceRequired,
    label: "Request stock receipt upload",
    description: "Ask the merchant to upload a delivery note, invoice, or stock scan.",
  },
  {
    ref: "evidence:confirm_quantities",
    mode: WORKFLOW_STEP_MODES.evidenceRequired,
    label: "Ask for quantity confirmation",
    description: "Ask the merchant to confirm quantities before Jefe updates later steps.",
  },
  {
    ref: "evidence:paste_supplier_reply",
    mode: WORKFLOW_STEP_MODES.evidenceRequired,
    label: "Ask for supplier reply",
    description: "Ask the merchant to paste a supplier reply so Jefe can update the workflow.",
  },
];

const MERCHANT_ACTION_CAPABILITIES = [
  {
    ref: "merchant_action:external_supplier_order",
    mode: WORKFLOW_STEP_MODES.merchantAction,
    label: "Merchant places supplier order",
    description: "The merchant completes an external supplier step that Jefe cannot execute yet.",
  },
  {
    ref: "merchant_action:manual_inventory_update",
    mode: WORKFLOW_STEP_MODES.merchantAction,
    label: "Merchant updates inventory manually",
    description: "The merchant updates stock outside Jefe when no typed adapter is available.",
  },
];

export function listStepCapabilities() {
  const executable = listActionCapabilities().flatMap((capability) =>
    capability.targetKinds.map((targetKind) => ({
      ref: `execute:${capability.actionType}:${targetKind}`,
      mode: WORKFLOW_STEP_MODES.execute,
      label: capability.description,
      description: capability.description,
      actionType: capability.actionType,
      targetKind,
    })),
  );
  return [
    ...executable,
    ...ASSIST_CAPABILITIES,
    ...EVIDENCE_CAPABILITIES,
    ...MERCHANT_ACTION_CAPABILITIES,
  ];
}

/**
 * @param {unknown} ref
 * @param {unknown} requestedMode
 * @returns {{ mode: string; capabilityRef: string | null; actionIntent: import("../actions/action-intent.server.js").ActionIntent | null }}
 */
export function resolveWorkflowStepCapability(ref, requestedMode) {
  const mode = normalizeStepMode(requestedMode);
  const capabilityRef = typeof ref === "string" ? ref.trim() : "";
  if (!capabilityRef) {
    return {
      mode: mode === WORKFLOW_STEP_MODES.execute ? WORKFLOW_STEP_MODES.merchantAction : mode,
      capabilityRef: null,
      actionIntent: null,
    };
  }

  const capability = listStepCapabilities().find((item) => item.ref === capabilityRef);
  if (!capability) {
    return {
      mode: mode === WORKFLOW_STEP_MODES.evidenceRequired
        ? WORKFLOW_STEP_MODES.evidenceRequired
        : WORKFLOW_STEP_MODES.merchantAction,
      capabilityRef: null,
      actionIntent: null,
    };
  }

  if (capability.mode !== WORKFLOW_STEP_MODES.execute) {
    return { mode: capability.mode, capabilityRef: capability.ref, actionIntent: null };
  }

  const validation = validateActionIntent({
    actionType: capability.actionType,
    targetKind: capability.targetKind,
  });
  if (!validation.ok) {
    return {
      mode: WORKFLOW_STEP_MODES.merchantAction,
      capabilityRef: null,
      actionIntent: null,
    };
  }
  return {
    mode: WORKFLOW_STEP_MODES.execute,
    capabilityRef: capability.ref,
    actionIntent: validation.intent,
  };
}

/** @param {unknown} value */
export function normalizeStepMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  if (Object.values(WORKFLOW_STEP_MODES).includes(/** @type {any} */ (mode))) return mode;
  return WORKFLOW_STEP_MODES.merchantAction;
}
