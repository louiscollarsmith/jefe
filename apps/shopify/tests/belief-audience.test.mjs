import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  DETERMINISTIC_BELIEF_REGISTRY,
  BELIEF_AUDIENCES,
  beliefAudience,
  isMerchantVisibleBeliefKey,
} from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";

// Who a belief is FOR. Before this field there were two rules that disagreed:
// `isMerchantVisibleBeliefKey` excluded only `merchantVisible === false`, so all 19 ingestion
// diagnostics passed a function whose name promises they would not — and they stayed off the
// merchant's screen only because merchant-memory-view.tsx ALSO filtered `category !== "data"`.
// Delete that view filter, or add any second consumer of the gate, and 19 rows of orphan
// line-item counts appear as things Jefe "worked out" about the business.

const registry = DETERMINISTIC_BELIEF_REGISTRY;

test("every belief has a known audience", () => {
  for (const belief of registry) {
    assert.ok(
      BELIEF_AUDIENCES.includes(beliefAudience(belief.key)),
      `${belief.key} has an unrecognised audience`,
    );
  }
});

test("ingestion diagnostics are internal, and the gate refuses them", () => {
  const diagnostics = registry.filter((belief) => belief.category === "data");
  assert.ok(diagnostics.length > 0, "the data category should not vanish silently");
  for (const belief of diagnostics) {
    assert.equal(beliefAudience(belief.key), "internal", belief.key);
    // The regression this whole field exists to prevent.
    assert.equal(
      isMerchantVisibleBeliefKey(belief.key),
      false,
      `${belief.key} is one of our diagnostics and must never be merchant-visible`,
    );
  }
});

test("a held-back belief is consistently model-audience and hidden", () => {
  // The business-shape tranche USED to be the thing held back here. Founder review is done
  // (2026-08-12: the seven shapes were checked against 14 real merchants) and they are now
  // merchant-facing, so nothing is held back today — and that is allowed. What must never
  // drift is the CONSISTENCY: anything flagged not-visible has to resolve to the model
  // audience and actually be hidden, so the two ways of saying it can't disagree.
  const heldBack = registry.filter((belief) => belief.merchantVisible === false);
  for (const belief of heldBack) {
    assert.equal(beliefAudience(belief.key), "model", belief.key);
    assert.equal(isMerchantVisibleBeliefKey(belief.key), false);
  }
});

test("an unclassified belief defaults to merchant, not to hidden", () => {
  // The honest failure direction: a belief nobody classified shows up where someone will
  // notice it, rather than silently disappearing from a surface it belonged on.
  assert.equal(beliefAudience("some.key.that.does.not.exist"), "merchant");
  assert.equal(isMerchantVisibleBeliefKey("some.key.that.does.not.exist"), true);
});

test("the audience split is the one that was measured", () => {
  const tally = { merchant: 0, internal: 0, model: 0 };
  for (const belief of registry) tally[beliefAudience(belief.key)] += 1;
  // 19 ingestion diagnostics stay internal — that count is the one that must not drift
  // quietly, because a diagnostic on a merchant's screen is the failure this file exists to
  // catch. `model` holds Jefe's own telemetry: how a merchant engages with recommendations,
  // how clearances performed, why they declined. Jefe reasons with those to adapt its
  // proposals; they are not facts the merchant worked out about their business.
  //
  // merchant/model counts move as tranches are surfaced or held back (business-shape went
  // merchant-facing in bc7af2e), so assert the INVARIANT, not a snapshot.
  assert.equal(tally.internal, 19);
  assert.ok(tally.model >= 3, "Jefe's own telemetry must stay model-only");
  assert.equal(tally.internal + tally.model + tally.merchant, registry.length);
  assert.equal(
    registry.filter((belief) => isMerchantVisibleBeliefKey(belief.key)).length,
    tally.merchant,
  );
});

test("Jefe's own telemetry is model-only, not a fact about the business", () => {
  // Same category of error as the ingestion diagnostics, just subtler — it survived the
  // first audience pass because it lives under `business.*` and looks like a business fact.
  for (const key of [
    "business.recommendation_engagement.all_time",
    "business.clearance_effectiveness.all_time",
    "business.action_decline_signal.all_time",
  ]) {
    assert.equal(beliefAudience(key), "model", key);
    assert.equal(isMerchantVisibleBeliefKey(key), false, `${key} must not reach a merchant`);
  }
});

test("audience gates what Jefe SAYS, never what it can read", () => {
  // adaptMarkdownFromMemory looks action_decline_signal up by key to ease the markdown after
  // "too aggressive" declines. Reclassifying it must not have removed the belief itself.
  assert.ok(
    registry.some((b) => b.key === "business.action_decline_signal.all_time"),
    "the belief must still exist for the code that reasons with it",
  );
});

test("the memory view no longer carries its own second rule", () => {
  // The stopgap filter is gone; the loader gate is the only rule. A re-added category filter
  // here would be a second definition of merchant-facing, free to drift from the field.
  const view = fs.readFileSync(
    new URL("../app/components/merchant-memory-view.tsx", import.meta.url),
    "utf8",
  );
  // Matches the FILTER, not a mention: the comment there explains the history and names the
  // old expression, which is worth keeping.
  assert.doesNotMatch(view, /\.filter\([^)]*category !== "data"/);
});
