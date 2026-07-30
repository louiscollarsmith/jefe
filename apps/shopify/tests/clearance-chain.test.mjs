import assert from "node:assert/strict";
import test from "node:test";
import { sizeClearanceMarkdowns } from "../app/lib/actions/dead-stock-clearance.server.js";
import {
  applyClearance,
  buildClearancePreview,
  computeClearanceAutoEligibility,
  enforceBlastRadiusCap,
  revertClearance,
} from "../app/lib/actions/clearance-adapter.server.js";

// End-to-end proof of the action thesis: belief-shaped dead stock -> sized
// markdowns -> preview -> blast-radius cap -> auto-eligibility -> apply (mock) ->
// revert (mock). No DB, no real Shopify — pure functions + an in-memory store.
//
// It guards the field-name contract between the decision engine
// (sizeClearanceMarkdowns output) and the execution adapter (buildClearancePreview
// input): a silent rename on either side would make the whole chain produce zero
// price changes, and only a test that spans both modules would catch it. It also
// proves the uniquely-Jefe safety — the unit-cost floor — survives all the way to
// the price that would be written.

test("dead stock -> markdown -> preview -> gate -> apply -> revert composes end to end", async () => {
  // Raw dead stock (what buildDeadStockClearanceProposal assembles from memory).
  const deadStock = [
    { productId: "p1", variantId: "v1", title: "Trapped Parka", unitsOnHand: 12, currentPrice: 200, unitCost: 80 },
    // 30% off would breach cost (100 -> 70 < 90 cost) -> must floor at 90, not 70.
    { productId: "p2", variantId: "v2", title: "Old Boots", unitsOnHand: 5, currentPrice: 100, unitCost: 90 },
    // Already at cost -> excluded from the markdown set, only counted.
    { productId: "p3", variantId: "v3", title: "At-cost Tee", unitsOnHand: 8, currentPrice: 20, unitCost: 20 },
  ];

  // 1) Decision engine sizes safe markdowns (floored at unit cost).
  const sized = sizeClearanceMarkdowns(deadStock, { defaultDiscountPercent: 30 });
  assert.equal(sized.belowCostCount, 1); // the at-cost tee
  assert.equal(sized.deadStockVariantCount, 2);
  const boots = sized.items.find((i) => i.variantId === "v2");
  assert.equal(boots.suggestedPrice, 90); // floored at cost, NOT 70
  assert.equal(boots.floorPrice, 90);

  // 2) Adapter consumes the SAME proposal object — the contract that matters.
  const preview = buildClearancePreview(sized);
  assert.equal(preview.variantCount, 2); // both genuine markdowns survived
  const parka = preview.changes.find((c) => c.variantId === "v1");
  assert.equal(parka.fromPrice, 200);
  assert.equal(parka.toPrice, 140); // 30% off, comfortably above its 80 cost
  // The cost-floored markdown made it through to the price that would be written.
  const bootsChange = preview.changes.find((c) => c.variantId === "v2");
  assert.equal(bootsChange.toPrice, 90);

  // 3) Gate: within cap + confident -> auto-eligible.
  assert.equal(enforceBlastRadiusCap(preview).withinCap, true);
  assert.equal(computeClearanceAutoEligibility(preview, 0.95).autoEligible, true);

  // 4) Apply against an in-memory store, then revert -> back to the originals.
  const store = new Map([["v1", 200], ["v2", 100]]);
  const client = {
    updateVariantPrice: async (id, price) => {
      store.set(id, price);
    },
  };
  const prev = process.env.CLEARANCE_EXECUTE_ENABLED;
  try {
    process.env.CLEARANCE_EXECUTE_ENABLED = "true";
    const applied = await applyClearance(client, preview);
    assert.equal(applied.appliedCount, 2);
    assert.equal(store.get("v1"), 140);
    assert.equal(store.get("v2"), 90);
    await revertClearance(client, applied.reversibilityPlan);
    assert.equal(store.get("v1"), 200); // fully reversible
    assert.equal(store.get("v2"), 100);
  } finally {
    if (prev === undefined) delete process.env.CLEARANCE_EXECUTE_ENABLED;
    else process.env.CLEARANCE_EXECUTE_ENABLED = prev;
  }
});
