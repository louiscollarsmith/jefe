// @ts-check

// The action-intent contract — the typed seam between LLM advice and typed
// execution primitives. The LLM (the plan-recommendation, reading Merchant Memory)
// emits an action-intent from a FIXED vocabulary — the Action Capability Registry;
// a typed primitive then executes it with deterministic, safety-floored parameters
// it computes ITSELF (never the LLM). This is the one generic path every action
// flows through — no per-action service, no LLM-authored prices.
//
// Split of responsibility:
//   - LLM   → picks an actionType + targetKind + a rough magnitude (advisory).
//   - here  → the registry: the typed vocabulary + validation (pure).
//   - primitive → resolves the concrete target from memory, computes the exact
//                 deterministic params (e.g. floored prices), previews, executes.

/**
 * @typedef {Object} ActionIntent
 * @property {string} actionType  The primitive to run, keyed in ACTION_REGISTRY (e.g. "price_markdown").
 * @property {string} targetKind  What it targets, e.g. "dead_stock" — resolved to concrete records by the primitive.
 * @property {Record<string, number|string|boolean>} [params]  Magnitude/knobs the LLM suggests (e.g. { markdownPercent: 30 }). ADVISORY — the primitive floors + validates; the LLM's number is never applied directly.
 * @property {string} [rationale]  One-line why, for the merchant.
 */

/**
 * @typedef {Object} ActionDefinition
 * @property {string} label
 * @property {string} description
 * @property {string[]} targetKinds  The target kinds this action can resolve.
 * @property {boolean} reversible    Whether the primitive can fully undo it (gates auto-eligibility).
 * @property {string} primitive      The typed executor that owns resolution + the write path.
 */

/**
 * The Action Capability Registry — the typed vocabulary of what Jefe can do.
 * Entries are METADATA only; the deterministic resolution + execution live in the
 * primitive, not here. Adding an action = one entry here + its primitive — never a
 * bespoke service.
 * @type {Record<string, ActionDefinition>}
 */
export const ACTION_REGISTRY = {
  price_markdown: {
    label: "Mark down prices",
    description: "Reduce prices on a set of variants, each floored at unit cost so it never sells below cost.",
    targetKinds: ["dead_stock"],
    reversible: true,
    primitive: "clearance-adapter",
  },
};

/** @param {string} actionType */
export function getActionDefinition(actionType) {
  return Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, actionType)
    ? ACTION_REGISTRY[actionType]
    : null;
}

/** The vocabulary an LLM prompt advertises: actionType + the targetKinds it supports. */
export function listActionCapabilities() {
  return Object.entries(ACTION_REGISTRY).map(([actionType, def]) => ({
    actionType,
    description: def.description,
    targetKinds: def.targetKinds,
  }));
}

/**
 * Validate an LLM-proposed action-intent against the registry. Structural only —
 * the primitive still re-validates safety invariants (floor, cap) at execution.
 * @param {any} intent
 * @returns {{ ok: true, intent: ActionIntent } | { ok: false, reason: string }}
 */
export function validateActionIntent(intent) {
  if (!intent || typeof intent !== "object") return { ok: false, reason: "not_an_object" };
  if (typeof intent.actionType !== "string") return { ok: false, reason: "missing_action_type" };
  const def = getActionDefinition(intent.actionType);
  if (!def) return { ok: false, reason: `unknown_action_type:${intent.actionType}` };
  if (typeof intent.targetKind !== "string" || !def.targetKinds.includes(intent.targetKind)) {
    return { ok: false, reason: `unsupported_target:${intent.targetKind}` };
  }
  return {
    ok: true,
    intent: {
      actionType: intent.actionType,
      targetKind: intent.targetKind,
      params: intent.params && typeof intent.params === "object" ? intent.params : undefined,
      rationale: typeof intent.rationale === "string" ? intent.rationale : undefined,
    },
  };
}
