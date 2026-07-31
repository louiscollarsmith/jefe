import assert from "node:assert/strict";
import test from "node:test";
import { beliefConfirmPriority } from "../app/lib/merchant-memory/service.server.js";
import { BELIEF_STATUS } from "../app/lib/merchant-memory/constants.server.js";

test("settled beliefs score 0 (nothing to confirm)", () => {
  assert.equal(beliefConfirmPriority(BELIEF_STATUS.merchantConfirmed, 0.9, "business.primary_currency"), 0);
  assert.equal(beliefConfirmPriority(BELIEF_STATUS.merchantCorrected, null, "products.dead_stock.trailing_90d"), 0);
  // confident inference is settled → 0
  assert.equal(beliefConfirmPriority(BELIEF_STATUS.inferred, 0.9, "business.primary_currency"), 0);
});

test("unsure beliefs score > 0", () => {
  assert.ok(beliefConfirmPriority(BELIEF_STATUS.inferred, 0.3, "business.primary_currency") > 0);
  // no confidence → treated as most uncertain, still > 0
  assert.ok(beliefConfirmPriority(BELIEF_STATUS.inferred, null, "policies.some_rule") > 0);
});

test("higher impact key ranks above lower impact (same uncertainty)", () => {
  const hi = beliefConfirmPriority(BELIEF_STATUS.inferred, 0.3, "business.primary_currency"); // impact 3
  const mid = beliefConfirmPriority(BELIEF_STATUS.inferred, 0.3, "policies.some_rule"); // impact 2 (policies.*)
  const lo = beliefConfirmPriority(BELIEF_STATUS.inferred, 0.3, "inventory.low_cover_products.trailing_30d"); // impact 1
  assert.ok(hi > mid && mid > lo);
});

test("lower confidence ranks above higher confidence (same key)", () => {
  const lessSure = beliefConfirmPriority(BELIEF_STATUS.inferred, 0.2, "business.primary_currency");
  const moreSure = beliefConfirmPriority(BELIEF_STATUS.inferred, 0.6, "business.primary_currency");
  assert.ok(lessSure > moreSure);
});
