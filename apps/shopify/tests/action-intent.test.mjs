import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_REGISTRY,
  getActionDefinition,
  getRequiredScopes,
  listActionCapabilities,
  validateActionIntent,
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
