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
  // 19 ingestion diagnostics stay internal. `model` is now 0: the business-shape tranche was
  // the only thing in it, and it went merchant-facing after the founder reviewed it against
  // real stores (2026-08-12). The internal count is the one that must not drift quietly — a
  // diagnostic leaking onto a merchant's screen is the failure this file exists to catch.
  assert.equal(tally.internal, 19);
  assert.equal(tally.model, 0);
  assert.equal(tally.merchant, registry.length - 19);
  assert.equal(
    registry.filter((belief) => isMerchantVisibleBeliefKey(belief.key)).length,
    tally.merchant,
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
