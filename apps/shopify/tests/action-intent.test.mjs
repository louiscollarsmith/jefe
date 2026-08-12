import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_REGISTRY,
  APPLICABILITY_DIMENSIONS,
  getActionDefinition,
  getRequiredScopes,
  isActionExecuteEnabled,
  listActionCapabilities,
  validateActionIntent,
  verdictForOutcome,
} from "../app/lib/actions/action-intent.server.js";

test("getRequiredScopes returns the write scopes an action needs, [] for unknown", () => {
  assert.deepEqual(getRequiredScopes("price_markdown"), ["write_products"]);
  assert.deepEqual(getRequiredScopes("nope"), []);
});

test("registry exposes price_markdown as the first typed action", () => {
  assert.ok(ACTION_REGISTRY.price_markdown);
  assert.equal(ACTION_REGISTRY.price_markdown.reversible, true);
  assert.deepEqual(ACTION_REGISTRY.price_markdown.targetKinds, ["dead_stock"]);
});

test("getActionDefinition returns the def or null (no throw on unknown)", () => {
  assert.equal(getActionDefinition("price_markdown")?.primitive, "clearance-adapter");
  assert.equal(getActionDefinition("nope"), null);
});

test("listActionCapabilities is the LLM-facing vocabulary", () => {
  const caps = listActionCapabilities();
  const pm = caps.find((c) => c.actionType === "price_markdown");
  assert.ok(pm);
  assert.ok(pm.description.includes("cost")); // the safety framing is advertised
  assert.deepEqual(pm.targetKinds, ["dead_stock"]);
});

test("validateActionIntent accepts a well-formed intent and normalizes it", () => {
  const res = validateActionIntent({
    actionType: "price_markdown",
    targetKind: "dead_stock",
    params: { markdownPercent: 30 },
    rationale: "12 products haven't sold in 90 days.",
    junk: "ignored",
  });
  assert.equal(res.ok, true);
  assert.equal(res.intent.actionType, "price_markdown");
  assert.deepEqual(res.intent.params, { markdownPercent: 30 });
  assert.equal("junk" in res.intent, false); // normalized to the contract shape
});

test("validateActionIntent rejects malformed / unknown / unsupported intents", () => {
  assert.equal(validateActionIntent(null).ok, false);
  assert.equal(validateActionIntent("x").ok, false);
  assert.equal(validateActionIntent({}).reason, "missing_action_type");
  assert.equal(validateActionIntent({ actionType: "wire_money", targetKind: "x" }).reason, "unknown_action_type:wire_money");
  assert.equal(
    validateActionIntent({ actionType: "price_markdown", targetKind: "all_products" }).reason,
    "unsupported_target:all_products",
  );
});

// ── applicability (part 8) ───────────────────────────────────────────────────────
// Matt 2026-08-12: which businesses an action suits is a standing property of the
// action, and it must be DIMENSIONAL — a clearance markdown is sensible for lipstick
// and absurd for a car dealer, but "car dealer" is not a dimension.

test("every applicability dimension an action names exists in the shared vocabulary", () => {
  for (const [actionType, def] of Object.entries(ACTION_REGISTRY)) {
    if (!def.applicability) continue;
    for (const key of [...def.applicability.suits, ...def.applicability.unsuitedWhen]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(APPLICABILITY_DIMENSIONS, key),
        `${actionType} names unknown applicability dimension "${key}"`,
      );
    }
  }
});

test("applicability dimensions are observable — each cites the belief that evidences it", () => {
  for (const [key, dim] of Object.entries(APPLICABILITY_DIMENSIONS)) {
    assert.match(dim.evidence, /^[a-z_]+\.[a-z_0-9.]+$/, `${key} must cite a belief key`);
    assert.ok(dim.means.length > 20, `${key} must say what it means in plain terms`);
  }
});

test("an action never both suits and is unsuited by the same dimension", () => {
  for (const [actionType, def] of Object.entries(ACTION_REGISTRY)) {
    if (!def.applicability) continue;
    const overlap = def.applicability.suits.filter((s) => def.applicability.unsuitedWhen.includes(s));
    assert.deepEqual(overlap, [], `${actionType} contradicts itself on ${overlap.join(",")}`);
  }
});

// ── outcome verdict (the shared runner over per-type success criteria) ───────────

test("verdictForOutcome scores a measured outcome against the action's own criteria", () => {
  // price_markdown keys on effectivenessRatePercent: >=40 good, <=0 underperformed.
  assert.equal(verdictForOutcome("price_markdown", { effectivenessRatePercent: 75 }).verdict, "good");
  assert.equal(verdictForOutcome("price_markdown", { effectivenessRatePercent: 40 }).verdict, "good", "boundary is inclusive");
  assert.equal(verdictForOutcome("price_markdown", { effectivenessRatePercent: 20 }).verdict, "neutral");
  assert.equal(verdictForOutcome("price_markdown", { effectivenessRatePercent: 0 }).verdict, "underperformed", "nothing moved");
});

test("verdictForOutcome carries the metric, value and baseline the raise needs to explain itself", () => {
  const scored = verdictForOutcome("price_markdown", { effectivenessRatePercent: 55 });
  assert.equal(scored.metric, "effectivenessRatePercent");
  assert.equal(scored.value, 55);
  assert.equal(scored.baseline, 0, "dead stock sold nothing, so anything beats the baseline");
});

test("verdictForOutcome returns 'unknown', never a failure, when it cannot score", () => {
  // An unscored action must never read as a BAD action.
  assert.equal(verdictForOutcome("price_markdown", null).verdict, "unknown");
  assert.equal(verdictForOutcome("price_markdown", {}).verdict, "unknown", "metric absent");
  assert.equal(verdictForOutcome("price_markdown", { effectivenessRatePercent: "abc" }).verdict, "unknown");
  assert.equal(verdictForOutcome("not_a_registered_action", { effectivenessRatePercent: 90 }).verdict, "unknown");
});

test("every registered action declares what success means for it", () => {
  // A registered action with no outcome spec can never be learned from — the
  // Observe→Learn loop would silently skip it.
  for (const [actionType, def] of Object.entries(ACTION_REGISTRY)) {
    assert.ok(def.outcome, `${actionType} has no outcome spec`);
    assert.ok(def.outcome.windowDays > 0, `${actionType} needs a measurement window`);
    assert.ok(
      def.outcome.verdict.goodAtOrAbove > def.outcome.verdict.underperformedAtOrBelow,
      `${actionType} verdict thresholds are inverted`,
    );
  }
});

// ── per-action execute flags ─────────────────────────────────────────────────────
// Every site that resolves a DYNAMIC action type must read that type's own flag.
// isClearanceExecuteEnabled() was doing this job, so a second registered type would
// have inherited CLEARANCE_EXECUTE_ENABLED — true in production.

test("isActionExecuteEnabled resolves the action's OWN flag", () => {
  assert.equal(isActionExecuteEnabled("price_markdown", { CLEARANCE_EXECUTE_ENABLED: "true" }), true);
  assert.equal(isActionExecuteEnabled("price_markdown", { CLEARANCE_EXECUTE_ENABLED: "false" }), false);
  assert.equal(isActionExecuteEnabled("price_markdown", {}), false);
  assert.equal(isActionExecuteEnabled("price_markdown", { CLEARANCE_EXECUTE_ENABLED: "1" }), false, "exact 'true' only");
});

test("isActionExecuteEnabled fails closed: another action's live flag never enables this one", () => {
  // The bug this replaces: any action type inheriting clearance's flag.
  assert.equal(
    isActionExecuteEnabled("product_status_change", { CLEARANCE_EXECUTE_ENABLED: "true" }),
    false,
    "an unregistered type is never executable, however many other flags are on",
  );
  assert.equal(isActionExecuteEnabled("", { CLEARANCE_EXECUTE_ENABLED: "true" }), false);
  assert.equal(isActionExecuteEnabled(undefined, { CLEARANCE_EXECUTE_ENABLED: "true" }), false);
});
