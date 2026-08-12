import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLEARANCE_CAPS,
  applyClearance,
  buildClearancePreview,
  computeClearanceAutoEligibility,
  enforceBlastRadiusCap,
  isClearanceExecuteEnabled,
  resolveAutonomyMode,
  revertClearance,
} from "../app/lib/actions/clearance-adapter.server.js";

// Every clearance item carries floorPrice (= unit cost) — the adapter refuses to
// write below it, so tests must provide it.
const sampleProposal = {
  items: [
    { variantId: "v1", title: "Alpha", currentPrice: 100, suggestedPrice: 70, floorPrice: 40 }, // 30% off
    { variantId: "v2", title: "Beta", currentPrice: 50, suggestedPrice: 45, floorPrice: 30 }, // 10% off
    { variantId: "v3", title: "Gamma", currentPrice: 20, suggestedPrice: 20, floorPrice: 10 }, // no markdown -> excluded
  ],
};

/** In-memory prisma double for the action-execution ledger. */
function makeMockPrisma() {
  const executions = new Map(); // runId -> row
  const writes = new Map(); // `${executionId}|${targetRef}|${targetValueKey}` -> row
  let idc = 0;
  return {
    _executions: executions,
    _writes: writes,
    actionExecution: {
      upsert: async ({ where, create }) => {
        const existing = executions.get(where.runId);
        if (existing) return existing;
        const row = { id: `exec-${++idc}`, ...create };
        executions.set(where.runId, row);
        return row;
      },
      update: async ({ where, data }) => {
        for (const row of executions.values()) if (row.id === where.id) Object.assign(row, data);
        return null;
      },
    },
    actionExecutionWrite: {
      upsert: async ({ where, create }) => {
        const k = where.executionId_targetRef_targetValueKey;
        const key = `${k.executionId}|${k.targetRef}|${k.targetValueKey}`;
        const existing = writes.get(key);
        if (existing) return existing;
        const row = { id: `w-${++idc}`, ...create };
        writes.set(key, row);
        return row;
      },
      update: async ({ where, data }) => {
        for (const row of writes.values()) if (row.id === where.id) Object.assign(row, data);
        return null;
      },
    },
  };
}

/** In-memory Shopify client double (read + write). */
function makeMockClient(initial = []) {
  const store = new Map(initial); // variantId -> price
  const calls = [];
  return {
    store,
    calls,
    getVariantPrice: async (variantId) => (store.has(variantId) ? store.get(variantId) : null),
    updateVariantPrice: async (variantId, price) => {
      store.set(variantId, price);
      calls.push({ variantId, price });
    },
  };
}

const execCtx = (over = {}) => ({
  runId: "run-1",
  merchantId: "m1",
  shopId: "s1",
  merchantSetting: "approve_execute",
  resolvedMode: "approve",
  eligibility: { reversible: true, withinCap: true, confident: true, autoEligible: true },
  confidence: 0.95,
  ...over,
});

async function withExecuteEnabled(fn) {
  const prev = process.env.CLEARANCE_EXECUTE_ENABLED;
  process.env.CLEARANCE_EXECUTE_ENABLED = "true";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLEARANCE_EXECUTE_ENABLED;
    else process.env.CLEARANCE_EXECUTE_ENABLED = prev;
  }
}

test("buildClearancePreview: markdowns only, floor-at-gate refuses below-cost + missing-floor", () => {
  const preview = buildClearancePreview({
    items: [
      ...sampleProposal.items,
      { variantId: "v4", currentPrice: 30, suggestedPrice: 12, floorPrice: 15 }, // below cost -> refused
      { variantId: "v5", currentPrice: 30, suggestedPrice: 20 }, // no floor -> refused (fail-closed)
    ],
  });
  assert.equal(preview.variantCount, 2); // v1, v2 (v3 no markdown, v4 below floor, v5 no floor)
  assert.equal(preview.maxDiscountPercent, 30);
  const reasons = Object.fromEntries(preview.refused.map((r) => [r.variantId, r.reason]));
  assert.equal(reasons.v4, "below_floor");
  assert.equal(reasons.v5, "missing_floor");
  assert.deepEqual(
    preview.reversibilityPlan.find((r) => r.variantId === "v1"),
    { variantId: "v1", restorePrice: 100 },
  );
});

test("enforceBlastRadiusCap blocks over-cap runs", () => {
  const preview = buildClearancePreview(sampleProposal);
  assert.equal(enforceBlastRadiusCap(preview).withinCap, true);
  assert.equal(enforceBlastRadiusCap(preview, { ...DEFAULT_CLEARANCE_CAPS, maxVariants: 1 }).withinCap, false);
  assert.equal(enforceBlastRadiusCap(preview, { ...DEFAULT_CLEARANCE_CAPS, maxDiscountPercent: 20 }).withinCap, false);
});

test("computeClearanceAutoEligibility requires reversible AND within-cap AND confident", () => {
  const preview = buildClearancePreview(sampleProposal);
  assert.equal(computeClearanceAutoEligibility(preview, 0.95).autoEligible, true);
  const lowConf = computeClearanceAutoEligibility(preview, 0.5);
  assert.equal(lowConf.autoEligible, false);
  assert.ok(lowConf.reasons.includes("below_confidence_threshold"));
  const overCap = computeClearanceAutoEligibility(preview, 0.95, { ...DEFAULT_CLEARANCE_CAPS, maxVariants: 1 });
  assert.ok(overCap.reasons.includes("over_blast_radius_cap"));
});

test("resolveAutonomyMode: 3 modes (recommend/approve_execute/autonomous); the gate floors autonomous", () => {
  const eligible = { autoEligible: true, reversible: true };
  assert.equal(resolveAutonomyMode("recommend", eligible).mode, "recommend");
  assert.equal(resolveAutonomyMode("approve_execute", eligible).mode, "approve");
  assert.equal(resolveAutonomyMode("autonomous", eligible).mode, "auto");
  // autonomous but not structurally eligible -> degrades to approve, never silent-auto
  assert.equal(resolveAutonomyMode("autonomous", { autoEligible: false, reversible: true }).mode, "approve");
  assert.equal(resolveAutonomyMode("autonomous", { autoEligible: true, reversible: false }).mode, "approve"); // irreversible floor
});

test("applyClearance refuses in 'recommend' mode (advisory never executes)", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    await assert.rejects(
      () =>
        applyClearance(
          { prisma: makeMockPrisma(), shopifyClient: makeMockClient([["v1", 100]]), execution: execCtx({ resolvedMode: "recommend" }) },
          preview,
        ),
      /recommend/,
    );
  });
});

test("applyClearance refuses when disabled (no write path by default)", async () => {
  assert.equal(isClearanceExecuteEnabled(), false);
  const preview = buildClearancePreview(sampleProposal);
  await assert.rejects(
    () => applyClearance({ prisma: makeMockPrisma(), shopifyClient: makeMockClient(), execution: execCtx() }, preview),
    /disabled/,
  );
});

test("applyClearance: enabled requires injected prisma + read/write client; over-cap blocks before any write", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    await assert.rejects(
      () => applyClearance({ prisma: null, shopifyClient: makeMockClient(), execution: execCtx() }, preview),
      /prisma/,
    );
    await assert.rejects(
      () => applyClearance({ prisma: makeMockPrisma(), shopifyClient: { updateVariantPrice: async () => {} }, execution: execCtx() }, preview),
      /getVariantPrice/,
    );
    const client = makeMockClient([["v1", 100], ["v2", 50]]);
    await assert.rejects(
      () => applyClearance({ prisma: makeMockPrisma(), shopifyClient: client, execution: execCtx() }, preview, { caps: { ...DEFAULT_CLEARANCE_CAPS, maxVariants: 1 } }),
      /blast-radius cap/,
    );
    assert.deepEqual(client.calls, []); // nothing written on any rejected path
  });
});

test("applyClearance: applies within cap, writes the store + the ledger", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    const prisma = makeMockPrisma();
    const client = makeMockClient([["v1", 100], ["v2", 50]]);
    const result = await applyClearance({ prisma, shopifyClient: client, execution: execCtx() }, preview);
    assert.equal(result.ok, true);
    assert.equal(result.status, "applied");
    assert.equal(result.appliedCount, 2);
    assert.deepEqual(client.calls, [{ variantId: "v1", price: 70 }, { variantId: "v2", price: 45 }]);
    const parent = [...prisma._executions.values()][0];
    assert.equal(parent.status, "applied");
    assert.equal(parent.actionType, "price_markdown");
    assert.equal([...prisma._writes.values()].filter((w) => w.status === "applied").length, 2);
  });
});

test("applyClearance: compare-and-set skips a variant whose live price drifted from the preview", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    const prisma = makeMockPrisma();
    const client = makeMockClient([["v1", 105], ["v2", 50]]); // v1 drifted from previewed 100
    const result = await applyClearance({ prisma, shopifyClient: client, execution: execCtx() }, preview);
    assert.equal(result.status, "partially_applied");
    assert.equal(result.appliedCount, 1);
    assert.equal(result.skipped[0].reason, "price_drift");
    assert.deepEqual(client.calls, [{ variantId: "v2", price: 45 }]); // v1 never written
    assert.equal([...prisma._writes.values()].find((w) => w.targetRef === "v1").status, "skipped_drift");
  });
});

test("applyClearance: a second run of the same runId is idempotent (no double-write)", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    const prisma = makeMockPrisma();
    const client = makeMockClient([["v1", 100], ["v2", 50]]);
    const ctx = execCtx();
    await applyClearance({ prisma, shopifyClient: client, execution: ctx }, preview);
    client.calls.length = 0;
    const second = await applyClearance({ prisma, shopifyClient: client, execution: ctx }, preview);
    assert.deepEqual(client.calls, []); // nothing re-written
    assert.ok(second.applied.every((a) => a.idempotent));
  });
});

test("applyClearance: a mid-run write failure auto-reverts everything applied so far", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    const prisma = makeMockPrisma();
    const store = new Map([["v1", 100], ["v2", 50]]);
    const client = {
      store,
      getVariantPrice: async (id) => (store.has(id) ? store.get(id) : null),
      updateVariantPrice: async (id, price) => {
        if (id === "v2") throw new Error("shopify 500");
        store.set(id, price);
      },
    };
    const result = await applyClearance({ prisma, shopifyClient: client, execution: execCtx() }, preview);
    assert.equal(result.ok, false);
    assert.match(result.error, /shopify 500/);
    assert.equal(store.get("v1"), 100); // applied then auto-reverted
    assert.equal(result.revertedCount, 1);
    assert.equal([...prisma._executions.values()][0].status, "reverted");
  });
});

test("revertClearance requires an injected client (cannot fire unwired)", async () => {
  const preview = buildClearancePreview(sampleProposal);
  await assert.rejects(() => revertClearance(null, preview.reversibilityPlan), /injected shopifyClient/);
});

test("revertClearance restores prices from the plan, skipping malformed entries", async () => {
  const client = makeMockClient();
  const result = await revertClearance(client, [
    { variantId: "v1", restorePrice: 100 },
    { variantId: "v2", restorePrice: 50 },
    { variantId: "v3", restorePrice: 0 }, // non-positive -> skipped
    { restorePrice: 20 }, // no variantId -> skipped
  ]);
  assert.equal(result.restoredCount, 2);
  assert.equal(result.skippedCount, 2);
  assert.deepEqual(client.calls, [{ variantId: "v1", price: 100 }, { variantId: "v2", price: 50 }]);
});

test("revert is NOT gated on the enable flag (undo must not be trappable)", async () => {
  const prev = process.env.CLEARANCE_EXECUTE_ENABLED;
  try {
    delete process.env.CLEARANCE_EXECUTE_ENABLED;
    assert.equal(isClearanceExecuteEnabled(), false);
    const client = makeMockClient();
    const result = await revertClearance(client, [{ variantId: "v1", restorePrice: 100 }]);
    assert.equal(result.restoredCount, 1);
  } finally {
    if (prev === undefined) delete process.env.CLEARANCE_EXECUTE_ENABLED;
    else process.env.CLEARANCE_EXECUTE_ENABLED = prev;
  }
});

test("apply -> revert round-trips the store back to original prices", async () => {
  await withExecuteEnabled(async () => {
    const preview = buildClearancePreview(sampleProposal);
    const prisma = makeMockPrisma();
    const client = makeMockClient([["v1", 100], ["v2", 50]]);
    await applyClearance({ prisma, shopifyClient: client, execution: execCtx() }, preview);
    assert.equal(client.store.get("v1"), 70);
    assert.equal(client.store.get("v2"), 45);
    const reverted = await revertClearance(client, preview.reversibilityPlan);
    assert.equal(reverted.restoredCount, 2);
    assert.equal(client.store.get("v1"), 100);
    assert.equal(client.store.get("v2"), 50);
  });
});

// ── the cap must fail closed on a field it cannot read ───────────────────────────
// `undefined > 25` is false, so a preview missing variantCount used to pass the
// blast-radius cap unmeasured — exactly the shape a foreign preview has.

test("enforceBlastRadiusCap refuses a preview whose blast radius it cannot measure", () => {
  const foreign = { changes: [{ productId: "p1" }], productCount: 1 }; // a product-status-shaped preview
  const result = enforceBlastRadiusCap(/** @type {any} */ (foreign));
  assert.equal(result.withinCap, false, "an uncheckable cap must never read as a passed cap");
  assert.deepEqual(result.violations.map((v) => v.reason), ["uncheckable", "uncheckable"]);
});

test("enforceBlastRadiusCap still passes a well-formed in-bounds clearance preview", () => {
  const ok = enforceBlastRadiusCap(/** @type {any} */ ({ variantCount: 3, maxDiscountPercent: 30 }));
  assert.equal(ok.withinCap, true);
  assert.deepEqual(ok.violations, []);
});

test("enforceBlastRadiusCap still names a genuine over-cap violation", () => {
  const over = enforceBlastRadiusCap(/** @type {any} */ ({ variantCount: 9999, maxDiscountPercent: 30 }));
  assert.equal(over.withinCap, false);
  assert.equal(over.violations[0].cap, "maxVariants");
  assert.equal(over.violations[0].actual, 9999);
});

test("an empty preview (zero variants) is measurable and within cap", () => {
  const empty = enforceBlastRadiusCap(/** @type {any} */ ({ variantCount: 0, maxDiscountPercent: 0 }));
  assert.equal(empty.withinCap, true, "zero is a real measurement, not a missing one");
});
