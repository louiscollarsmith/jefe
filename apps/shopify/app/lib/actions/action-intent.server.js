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
 * @property {Record<string, number|string|boolean>} [params]  Magnitude/scope knobs the LLM or merchant suggests (e.g. { markdownPercent: 30, maxProducts: 1 }). ADVISORY — the primitive floors + validates; the LLM's number is never applied directly.
 * @property {string} [rationale]  One-line why, for the merchant.
 */

/**
 * The applicability vocabulary — the DIMENSIONS a business can have, which decide whether an
 * action makes sense for it. Deliberately dimensional, never a vertical/industry enum: the same
 * dimensions describe a lipstick brand and a car dealer, and a vertical list would be endless,
 * unobservable and wrong at the edges. Matt's principle (2026-08-12): a clearance markdown is
 * sensible for lipstick and absurd for a car dealer, and Jefe should know the difference.
 *
 * Every dimension here must be OBSERVABLE from Merchant Memory — an applicability qualifier
 * Jefe cannot evaluate is decoration. The `evidence` key names the belief that speaks to it.
 *
 * ⚠️ The EVALUATOR is not built here. This is the shared vocabulary + the per-action slot;
 * scoring a merchant against these dimensions belongs to the memory/ontology lane (chat 10 is
 * routing the fuller framing there). Until it exists, `applicability` is declared and unread.
 */
export const APPLICABILITY_DIMENSIONS = /** @type {const} */ ({
  discounting_is_normal: { evidence: "business.discount_depth.trailing_90d", means: "This merchant already discounts; a markdown is a familiar lever, not a brand break." },
  never_discounts: { evidence: "business.discount_depth.trailing_90d", means: "No meaningful discounting in the window — proposing one may contradict a deliberate pricing stance." },
  repeat_purchase: { evidence: "customers.repeat_customer_rate.all_time", means: "Customers buy again; demand-shaping actions compound." },
  high_consideration_low_volume: { evidence: "orders.average_order_value.trailing_90d", means: "Few, large, considered purchases (the car-dealer shape) — per-unit price automation is inappropriate." },
  tracked_stock: { evidence: "data.inventory_variant_coverage", means: "Inventory is tracked, so stock-based actions have something real to act on." },
  made_to_order: { evidence: "data.inventory_variant_coverage", means: "Little or no tracked stock — stock-clearing actions are meaningless." },
  costed_catalog: { evidence: "products.cost_coverage", means: "Unit costs are known, so a price floor can be computed." },
});

/**
 * @typedef {Object} ActionApplicability
 * @property {string[]} suits         Dimensions that make this action a good fit. Keys of APPLICABILITY_DIMENSIONS.
 * @property {string[]} unsuitedWhen  Dimensions that make it a bad fit — a hard "don't propose this here" signal, not a score penalty.
 */

/**
 * @typedef {Object} ActionOutcomeSpec
 * @property {string} metric        The headline field of the measured outcome the verdict keys on.
 * @property {number} windowDays    How long after `appliedAt` to wait before measuring.
 * @property {number} baseline      The value the action is trying to beat (e.g. 0 for dead stock, which sold nothing).
 * @property {{ goodAtOrAbove: number, underperformedAtOrBelow: number }} verdict  Thresholds turning the metric into good | underperformed | neutral.
 */

/**
 * @typedef {Object} ActionDefinition
 * @property {string} label
 * @property {string} description
 * @property {string[]} targetKinds  The target kinds this action can resolve.
 * @property {boolean} reversible    Whether the primitive can fully undo it (gates auto-eligibility).
 * @property {string} primitive      The typed executor that owns resolution + the write path.
 * @property {string} [executeFlag]  The env var that must equal "true" for this action to WRITE — its deliberate go-live switch (e.g. "CLEARANCE_EXECUTE_ENABLED"). Absent = not yet wired for execution.
 * @property {string[]} [requiredScopes]  Shopify OAuth scopes the merchant must have granted for this action to WRITE (e.g. ["write_products"]). The execution gate + the scope-nudge read use this; empty/absent = no write scope needed.
 * @property {ActionApplicability} [applicability]  WHICH BUSINESSES this suits, dimensionally. See APPLICABILITY_DIMENSIONS.
 * @property {ActionOutcomeSpec} [outcome]  WHAT SUCCESS IS for this action — the per-type half of the Observe→Learn contract. Each type declares its success criteria here; ONE shared executor runs them (co-locate the definition, share the runner — chat 10's ruling, so an action and its success criteria can never drift apart).
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
    executeFlag: "CLEARANCE_EXECUTE_ENABLED",
    requiredScopes: ["write_products"],
    applicability: {
      suits: ["discounting_is_normal", "tracked_stock", "costed_catalog"],
      // A car dealer, a made-to-order maker, and a brand that never discounts are all
      // businesses where this action is wrong however good the dead-stock number looks.
      unsuitedWhen: ["never_discounts", "high_consideration_low_volume", "made_to_order"],
    },
    outcome: {
      // Share of cleared variants that moved at least one unit — measureClearanceOutcome's
      // headline "did it work" signal. Dead stock sold nothing by definition, so the
      // baseline is 0 and any movement beats it.
      metric: "effectivenessRatePercent",
      windowDays: 14, // matches measureAndRecordClearanceOutcomes' default
      baseline: 0,
      // ⚠️ Thresholds are this lane's proposed defaults, not measured from real runs —
      // no clearance has been scored in production yet. Revisit once there is data.
      verdict: { goodAtOrAbove: 40, underperformedAtOrBelow: 0 },
    },
  },
};

/**
 * Turn a measured outcome into the merchant-facing verdict, against the action type's own
 * declared success criteria. The SHARED runner half of the Observe→Learn contract: every
 * action type gets scored here, none brings its own scorer. Returns "unknown" when the type
 * declares no spec or the metric is absent, so an unscored action reads as unscored rather
 * than as a failure.
 * @param {string} actionType
 * @param {Record<string, unknown> | null | undefined} outcome  a measured outcome object
 * @returns {{ verdict: "good" | "underperformed" | "neutral" | "unknown", metric: string | null, value: number | null, baseline: number | null }}
 */
export function verdictForOutcome(actionType, outcome) {
  const spec = getActionDefinition(actionType)?.outcome;
  const none = { verdict: /** @type {const} */ ("unknown"), metric: null, value: null, baseline: null };
  if (!spec || !outcome || typeof outcome !== "object") return none;
  const value = Number(outcome[spec.metric]);
  if (!Number.isFinite(value)) return none;
  const verdict =
    value >= spec.verdict.goodAtOrAbove ? /** @type {const} */ ("good")
    : value <= spec.verdict.underperformedAtOrBelow ? /** @type {const} */ ("underperformed")
    : /** @type {const} */ ("neutral");
  return { verdict, metric: spec.metric, value, baseline: spec.baseline };
}

/**
 * The Shopify OAuth scopes an action needs granted before it can WRITE. Empty when the
 * action type is unknown or needs no write scope. The execution gate prechecks these
 * (so a missing scope becomes a "grant to continue" prompt, not a failed write), and the
 * scope-nudge read uses them to surface value-gated-on-permission opportunities.
 * @param {string} actionType
 * @returns {string[]}
 */
export function getRequiredScopes(actionType) {
  const def = getActionDefinition(actionType);
  return Array.isArray(def?.requiredScopes) ? def.requiredScopes : [];
}

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
 * Engine-facts roster of registered action types — the single source of truth for any surface
 * that needs to know which autonomy dials are LIVE (e.g. the Settings roster). Deliberately no
 * `label`/order/detail — those are design copy, owned by the surface; this returns engine truth
 * only. `live` = registered here (the wired-contract: a registry entry implies its resolver +
 * primitive) AND its `executeFlag` env is exactly "true" (the deliberate go-live switch). When an
 * action graduates — a registry entry with its flag on — its dial lights up with no component edit.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ actionType: string, live: boolean, requiredScopes: string[] }>}
 */
export function listActionTypes(env = process.env) {
  return Object.entries(ACTION_REGISTRY).map(([actionType, def]) => ({
    actionType,
    live: Boolean(def.executeFlag && env[def.executeFlag] === "true"),
    requiredScopes: Array.isArray(def.requiredScopes) ? def.requiredScopes : [],
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
