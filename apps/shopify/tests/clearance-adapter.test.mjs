import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLEARANCE_CAPS,
  applyClearance,
  buildClearancePreview,
  computeClearanceAutoEligibility,
  enforceBlastRadiusCap,
  isClearanceExecuteEnabled,
} from "../app/lib/actions/clearance-adapter.server.js";

const sampleProposal = {
  items: [
    { variantId: "v1", title: "Alpha", currentPrice: 100, suggestedPrice: 70 }, // 30% off
    { variantId: "v2", title: "Beta", currentPrice: 50, suggestedPrice: 45 }, // 10% off
    { variantId: "v3", title: "Gamma", currentPrice: 20, suggestedPrice: 20 }, // no markdown -> excluded
  ],
};

test("buildClearancePreview computes changes + reversibility plan, markdowns only", () => {
  const preview = buildClearancePreview(sampleProposal);
  assert.equal(preview.variantCount, 2); // Gamma (no markdown) excluded
  assert.equal(preview.maxDiscountPercent, 30);
  const alpha = preview.changes.find((c) => c.variantId === "v1");
  assert.equal(alpha.fromPrice, 100);
  assert.equal(alpha.toPrice, 70);
  assert.equal(alpha.discountPercent, 30);
  assert.deepEqual(
    preview.reversibilityPlan.find((r) => r.variantId === "v1"),
    { variantId: "v1", restorePrice: 100 },
  );
});

test("enforceBlastRadiusCap blocks over-cap runs", () => {
  const preview = buildClearancePreview(sampleProposal);
  assert.equal(enforceBlastRadiusCap(preview).withinCap, true);
  const overCount = enforceBlastRadiusCap(preview, { ...DEFAULT_CLEARANCE_CAPS, maxVariants: 1 });
  assert.equal(overCount.withinCap, false);
  assert.equal(overCount.violations[0].cap, "maxVariants");
  const overDiscount = enforceBlastRadiusCap(preview, { ...DEFAULT_CLEARANCE_CAPS, maxDiscountPercent: 20 });
  assert.equal(overDiscount.withinCap, false);
  assert.equal(overDiscount.violations[0].cap, "maxDiscountPercent");
});

test("computeClearanceAutoEligibility requires reversible AND within-cap AND confident", () => {
  const preview = buildClearancePreview(sampleProposal);
  assert.equal(computeClearanceAutoEligibility(preview, 0.95).autoEligible, true);
  const lowConf = computeClearanceAutoEligibility(preview, 0.5);
  assert.equal(lowConf.autoEligible, false);
  assert.ok(lowConf.reasons.includes("below_confidence_threshold"));
  const overCap = computeClearanceAutoEligibility(preview, 0.95, { ...DEFAULT_CLEARANCE_CAPS, maxVariants: 1 });
  assert.equal(overCap.autoEligible, false);
  assert.ok(overCap.reasons.includes("over_blast_radius_cap"));
});

test("applyClearance refuses to run when disabled (no write path by default)", async () => {
  assert.equal(isClearanceExecuteEnabled(), false); // off by default
  const preview = buildClearancePreview(sampleProposal);
  await assert.rejects(
    () => applyClearance({ updateVariantPrice: async () => {} }, preview),
    /disabled/,
  );
});

test("applyClearance writes via the injected client only when enabled (mock, no real Shopify)", async () => {
  const preview = buildClearancePreview(sampleProposal);
  const calls = [];
  const mockClient = {
    updateVariantPrice: async (variantId, price) => {
      calls.push({ variantId, price });
    },
  };
  const prev = process.env.CLEARANCE_EXECUTE_ENABLED;
  try {
    process.env.CLEARANCE_EXECUTE_ENABLED = "true";
    // Even enabled, a missing client throws.
    await assert.rejects(() => applyClearance(null, preview), /injected shopifyClient/);
    // Even enabled, an over-cap run throws before any write.
    await assert.rejects(
      () => applyClearance(mockClient, preview, { caps: { ...DEFAULT_CLEARANCE_CAPS, maxVariants: 1 } }),
      /blast-radius cap/,
    );
    assert.deepEqual(calls, []); // nothing written on the rejected paths
    // Enabled + client + within cap -> applies via the mock, in order.
    const result = await applyClearance(mockClient, preview);
    assert.equal(result.appliedCount, 2);
    assert.deepEqual(calls, [
      { variantId: "v1", price: 70 },
      { variantId: "v2", price: 45 },
    ]);
  } finally {
    if (prev === undefined) delete process.env.CLEARANCE_EXECUTE_ENABLED;
    else process.env.CLEARANCE_EXECUTE_ENABLED = prev;
  }
});
