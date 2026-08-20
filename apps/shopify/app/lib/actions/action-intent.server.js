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
  // Both evidenced by the business-shape tranche, which is what that tranche is FOR: the
  // vocabulary's own rule is that a dimension Jefe cannot evaluate is decoration, so a new
  // one is only admissible once a belief speaks to it.
  untyped_catalogue: { evidence: "business.range_composition", means: "Sellable products carry no product type, so search, reporting and Jefe's own read of the range are all working with gaps." },
  single_product_catalogue: { evidence: "business.catalogue_shape", means: "One product — categorisation work has nothing to organise." },
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
 * @property {string} [shopifyCapabilityProviderRef]  Compatibility bridge to the discovered Shopify capability manifest. Recommendation reasoning should consume the manifest; this old action type remains the executor binding.
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
  // Settings → Autonomy already lists "Listing copy" as SOON. The badge is driven by
  // registered + execute-flag-on, so this entry alone changes NOTHING a merchant sees:
  // `LISTING_COPY_EXECUTE_ENABLED` is unset everywhere, which keeps the row on SOON and the
  // write path closed. Flipping it is the founder's call, not a side effect of this landing.
  //
  // ⚠️ SCOPED TO PRODUCT TYPE ONLY, deliberately. The panel's subtitle says "descriptions,
  // titles, product types", and those are not one job:
  //   - product type is a structured taxonomy field. Reversible to the exact previous string,
  //     no voice, no judgement, and it is the field Jefe's OWN `business.range_composition`
  //     belief is gated on (it needs a type on ≥70% of products) — so filling it in makes
  //     Jefe understand the merchant better, not just tidier.
  //   - descriptions and titles are marketing PROSE written onto a live storefront in
  //     someone's brand voice. Same adapter shape, completely different risk: a wrong price
  //     is obviously wrong, wrong copy just sounds like the merchant said it. That needs a
  //     voice decision and an approve-first period before it belongs here.
  // Widening this to prose is a deliberate later step, not a config tweak.
  listing_copy: {
    label: "Fill in missing product types",
    description:
      "Set the product type on sellable products that have none, so the catalogue is categorised for search, reporting and Jefe's own read of the range.",
    targetKinds: ["missing_product_type"],
    reversible: true,
    primitive: "listing-copy-adapter",
    shopifyCapabilityProviderRef: "shopify.product.update",
    executeFlag: "LISTING_COPY_EXECUTE_ENABLED",
    requiredScopes: ["write_products"],
    applicability: {
      // The gap itself is the qualifier — nothing to fill, nothing to propose.
      suits: ["untyped_catalogue"],
      // A single-product store gains nothing from taxonomy work. NOT listed:
      // "the merchant curates their own types" — that would be decoration, because the
      // adapter's blank-only rule already makes it unreachable, and the vocabulary's rule is
      // that a dimension Jefe cannot evaluate does not belong here.
      unsuitedWhen: ["single_product_catalogue"],
    },
    outcome: {
      // The gap is the thing: what share of sellable products still lack a type after the
      // run. Nothing else about this action is worth claiming — it does not promise sales.
      metric: "productTypeCoveragePercent",
      windowDays: 1,
      baseline: 0,
      // ⚠️ Proposed defaults, never measured — no listing-copy run has happened. The
      // clearance entry carries the same warning and it still holds: these are a starting
      // point to be replaced by real runs, not a finding.
      verdict: { goodAtOrAbove: 95, underperformedAtOrBelow: 50 },
    },
  },
  price_markdown: {
    label: "Mark down prices",
    description: "Reduce prices on a set of variants, each floored at unit cost so it never sells below cost.",
    targetKinds: ["dead_stock"],
    reversible: true,
    primitive: "clearance-adapter",
    shopifyCapabilityProviderRef: "shopify.product_variants.bulk_update",
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
  // ✅ LIVE in production since 2026-08-13 (`PRODUCT_STATUS_EXECUTE_ENABLED=true`, founder's
  // call): the Settings "Tidy-ups" dial is real and an approved tidy-up archives products for
  // the merchant. Unsetting the flag reverts to the dark path — the approval is recorded and
  // nothing is written. Default dial is `approve_execute`, so nothing archives without the
  // merchant approving it; `autonomous` is theirs to choose per action type.
  //
  // ⚠️ This flag is SHARED with the product-status adapter it drives (one adapter, one
  // switch). Verified at go-live that `applyProductStatusChange` is reachable ONLY through
  // `wireTidyUpExecution` — so today it turns on tidy-ups and nothing else. If a second
  // product-status action is ever bound, that stops being true and this flag turns it on too.
  //
  // ⚠️ Registering DOES change one merchant-visible thing, and it is not the dial: membership
  // of this registry is what `listActionCapabilities()` advertises to the plan model, and
  // membership of the BINDING table is what makes a proposal resolvable. So from the moment
  // this entry lands, Jefe can propose a tidy-up — as advice, with `executable: false` and no
  // Approve button, routed to the instruct path (no dead ends). That is the intended
  // behaviour, not a leak: nothing is written, and the proposal is only ever built from the
  // three guards in stale-listing-tidy-up.server.js. Worth stating because "dark behind a
  // flag" is easy to read as "invisible", and here it means "cannot write", not "cannot speak".
  //
  // ⚠️ Shares `PRODUCT_STATUS_EXECUTE_ENABLED` with the product-status adapter it drives,
  // deliberately. One adapter, one go-live switch: a second flag name for the same write path
  // is how a "disabled" feature turns out to have been enabled through the other door.
  //
  // ⚠️ SCOPED TO ARCHIVING UNBUYABLE PRODUCTS, deliberately. The Autonomy row's old subtitle
  // read "missing types, broken links, unclaimed refunds", and none of those three is this:
  //   - missing types is `listing_copy`, already registered and live-flagged;
  //   - broken links needs redirect data we do not ingest and a scope we were not granted;
  //   - refund writes are IRREVERSIBLE (`refundCreate`), a different risk class entirely
  //     (action-ontology-audit-2026-08-12.md §4) and a founder call, not a build task.
  // The subtitle was changed to describe what this actually does. Widening the family is
  // adding target kinds here, each with its own resolver — never loosening this one.
  // ⚠️ NOT YET LIVE. Flag-gated behind INVENTORY_TRANSFER_EXECUTE_ENABLED (default off).
  // Requires write_inventory_transfers OAuth scope (added to shopify.app.toml 2026-08-19).
  // The adapter is wired but the execute path is closed until the founder flips the flag.
  // A restock action can add this as a plan step via `add_plan_step`; until the flag is on,
  // Jefe proposes and instructs (no dead ends — the adapter's preview runs fine).
  shopify_inventory_transfer: {
    label: "Create Shopify inventory transfer",
    description:
      "Create a Shopify inventory transfer to move stock from one location to another, matching the approved replenishment quantities.",
    targetKinds: ["restock"],
    reversible: false,
    primitive: "inventory-transfer-adapter",
    shopifyCapabilityProviderRef: "shopify.inventory_transfer.create",
    executeFlag: "INVENTORY_TRANSFER_EXECUTE_ENABLED",
    requiredScopes: ["write_inventory_transfers"],
    applicability: {
      suits: ["tracked_stock"],
      unsuitedWhen: ["made_to_order"],
    },
    outcome: {
      // What fraction of line items in the transfer reached status COMPLETE (all
      // units accepted by the destination). A transfer Shopify rejects entirely
      // scores 0; a fully accepted transfer scores 100.
      // ⚠️ Proposed defaults — no transfer runs have been scored yet. Revisit once real data exists.
      metric: "transferCompletenessPercent",
      windowDays: 7,
      baseline: 0,
      verdict: { goodAtOrAbove: 95, underperformedAtOrBelow: 50 },
    },
  },
  tidy_up: {
    label: "Tidy up the storefront",
    description:
      "Archive live products that have no stock left anywhere and have sold nothing for months, so the storefront only shows what a customer can actually buy. Reversible to ACTIVE.",
    targetKinds: ["stale_listing"],
    reversible: true,
    primitive: "product-status-adapter",
    shopifyCapabilityProviderRef: "shopify.product.update",
    executeFlag: "PRODUCT_STATUS_EXECUTE_ENABLED",
    requiredScopes: ["write_products"],
    applicability: {
      // Needs real inventory to reason about: the whole judgement is "there is none left".
      suits: ["tracked_stock"],
      // ⛔ A made-to-order maker holds no stock BY DESIGN. Every one of their products looks
      // exactly like a stale listing to a stock-based test, and archiving their catalogue
      // would be the single worst thing Jefe could do to them. The resolver's own
      // known-levels guard already refuses an untracked catalogue; this says the same thing
      // one layer up, so the action is never even proposed to that shape of business.
      unsuitedWhen: ["made_to_order"],
    },
    outcome: {
      // What this action promises is a tidier storefront, so the metric is how much of the
      // live catalogue is actually buyable. It does NOT promise sales, and must not be
      // scored as though it did.
      metric: "buyableActiveProductPercent",
      windowDays: 1,
      baseline: 0,
      // ⚠️ Proposed defaults, never measured — no tidy-up run has happened. Same warning as
      // the other two entries: a starting point to be replaced by real runs, not a finding.
      verdict: { goodAtOrAbove: 95, underperformedAtOrBelow: 50 },
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

/**
 * Is THIS action type's write path switched on? Resolves the action's OWN `executeFlag` from
 * the registry — the generic form of `isClearanceExecuteEnabled()`.
 *
 * ⚠️ Use this, never a specific primitive's flag helper, anywhere the action type is dynamic.
 * `getActiveSuggestedAction` read `isClearanceExecuteEnabled()` for whatever row it loaded, so a
 * second registered action type would have been gated on `CLEARANCE_EXECUTE_ENABLED` — a flag
 * that is `true` in production. Fail-closed: an unregistered type, or one with no `executeFlag`,
 * is never executable.
 * @param {string} actionType
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isActionExecuteEnabled(actionType, env = process.env) {
  const def = getActionDefinition(actionType);
  return Boolean(def?.executeFlag && env[def.executeFlag] === "true");
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
