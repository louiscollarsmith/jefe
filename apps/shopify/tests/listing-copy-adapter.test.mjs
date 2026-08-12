import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LISTING_COPY_CAPS,
  isListingCopyExecuteEnabled,
  buildListingCopyPreview,
  enforceBlastRadiusCap,
  computeListingCopyAutoEligibility,
  applyListingCopyChange,
  revertListingCopyChange,
} from "../app/lib/actions/listing-copy-adapter.server.js";

// This adapter WRITES to a merchant's live catalogue. The tests that matter are the ones
// asserting what it refuses to do — filling a blank field is the easy half.

// ---- doubles (mirror tests/product-status-adapter.test.mjs) ----

function makeMockClient(initial = {}) {
  const types = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    types,
    async getProductType(id) { return types.has(id) ? types.get(id) : null; },
    async updateProductType(id, type) { calls.push({ id, type }); types.set(id, type); return { id, type }; },
  };
}

function makeMockPrisma() {
  const executions = new Map();
  const writes = new Map();
  let execN = 0;
  let writeN = 0;
  return {
    _executions: executions,
    _writes: writes,
    actionExecution: {
      async upsert({ where, create }) {
        const existing = executions.get(where.runId);
        if (existing) return existing;
        const row = { id: `exec-${++execN}`, ...create };
        executions.set(where.runId, row);
        return row;
      },
      async update({ where, data }) {
        for (const row of executions.values()) if (row.id === where.id) Object.assign(row, data);
        return null;
      },
    },
    actionExecutionWrite: {
      async upsert({ where, create }) {
        const k = where.executionId_targetRef_targetValueKey;
        const key = `${k.executionId}|${k.targetRef}|${k.targetValueKey}`;
        const existing = writes.get(key);
        if (existing) return existing;
        const row = { id: `w-${++writeN}`, ...create };
        writes.set(key, row);
        return row;
      },
      async update({ where, data }) {
        for (const row of writes.values()) if (row.id === where.id) Object.assign(row, data);
        return null;
      },
    },
  };
}

function execCtx(over = {}) {
  return {
    runId: "run-1", merchantId: "m1", shopId: "s1",
    actionType: "listing_copy", actionKind: "set_product_type",
    merchantSetting: "approve_execute", resolvedMode: "approve",
    eligibility: {}, confidence: 0.95, ...over,
  };
}

const twoBlank = () =>
  buildListingCopyPreview({
    items: [
      { productId: "p1", title: "Yuzu Tonic", currentType: "", proposedType: "Drinks" },
      { productId: "p2", title: "Cherry Cola", currentType: null, proposedType: "Drinks" },
    ],
  });

async function withFlag(value, fn) {
  const prev = process.env.LISTING_COPY_EXECUTE_ENABLED;
  if (value === undefined) delete process.env.LISTING_COPY_EXECUTE_ENABLED;
  else process.env.LISTING_COPY_EXECUTE_ENABLED = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LISTING_COPY_EXECUTE_ENABLED;
    else process.env.LISTING_COPY_EXECUTE_ENABLED = prev;
  }
}

// ---- the refusals ----

test("a product the merchant has already typed is never re-categorised", () => {
  // THE load-bearing rule. A merchant who has curated their taxonomy — even into categories
  // Jefe wouldn't have chosen — has made a decision about their own catalogue. Silently
  // rewriting it would be Jefe overruling them, and they'd have no reason to look.
  const preview = buildListingCopyPreview({
    items: [
      { productId: "p1", currentType: "Homeware", proposedType: "Drinks" },
      { productId: "p2", currentType: "  ", proposedType: "Drinks" },
    ],
  });
  assert.equal(preview.productCount, 1);
  assert.equal(preview.changes[0].productId, "p2");
  assert.deepEqual(preview.refused, [{ productId: "p1", reason: "already_typed" }]);
});

test("an over-long product type is refused as a description in the wrong field", () => {
  const preview = buildListingCopyPreview({
    items: [{ productId: "p1", currentType: "", proposedType: "A".repeat(DEFAULT_LISTING_COPY_CAPS.maxTypeLength + 1) }],
  });
  assert.equal(preview.productCount, 0);
  assert.equal(preview.refused[0].reason, "proposed_type_too_long");
});

test("empty proposals and duplicate targets are refused, not silently dropped", () => {
  const preview = buildListingCopyPreview({
    items: [
      { productId: "p1", currentType: "", proposedType: "   " },
      { productId: "p2", currentType: "", proposedType: "Drinks" },
      { productId: "p2", currentType: "", proposedType: "Snacks" },
    ],
  });
  assert.equal(preview.productCount, 1);
  assert.deepEqual(
    preview.refused.map((r) => r.reason).sort(),
    ["duplicate_target", "empty_proposed_type"],
  );
});

test("every change carries a restore path back to empty", () => {
  const preview = twoBlank();
  assert.equal(preview.reversibilityPlan.length, preview.productCount);
  // Undo must leave no trace — the merchant had no type before, so restoring is blank, not a
  // guess at what they might have wanted.
  for (const entry of preview.reversibilityPlan) assert.equal(entry.restoreType, "");
});

// ---- the gates ----

test("the write path is closed unless the flag is exactly 'true'", async () => {
  await withFlag(undefined, async () => {
    assert.equal(isListingCopyExecuteEnabled(), false);
    await assert.rejects(
      () => applyListingCopyChange({ prisma: makeMockPrisma(), shopifyClient: makeMockClient(), execution: execCtx() }, twoBlank()),
      /LISTING_COPY_EXECUTE_ENABLED/,
    );
  });
  await withFlag("TRUE", async () => assert.equal(isListingCopyExecuteEnabled(), false));
  await withFlag("true", async () => assert.equal(isListingCopyExecuteEnabled(), true));
});

test("an over-cap run is blocked whole, never trimmed to fit", async () => {
  const items = Array.from({ length: DEFAULT_LISTING_COPY_CAPS.maxProducts + 1 }, (_, i) => ({
    productId: `p${i}`, currentType: "", proposedType: "Drinks",
  }));
  const preview = buildListingCopyPreview({ items });
  assert.equal(enforceBlastRadiusCap(preview).withinCap, false);
  await withFlag("true", async () => {
    await assert.rejects(
      () => applyListingCopyChange({ prisma: makeMockPrisma(), shopifyClient: makeMockClient(), execution: execCtx() }, preview),
      /blast-radius cap/,
    );
  });
});

test("recommend mode never writes", async () => {
  await withFlag("true", async () => {
    await assert.rejects(
      () => applyListingCopyChange(
        { prisma: makeMockPrisma(), shopifyClient: makeMockClient(), execution: execCtx({ resolvedMode: "recommend" }) },
        twoBlank(),
      ),
      /recommend/,
    );
  });
});

test("auto-eligibility needs reversible AND within-cap AND confident", () => {
  const preview = twoBlank();
  assert.equal(computeListingCopyAutoEligibility(preview, 0.95).autoEligible, true);
  const low = computeListingCopyAutoEligibility(preview, 0.5);
  assert.equal(low.autoEligible, false);
  assert.deepEqual(low.reasons, ["below_confidence_threshold"]);
});

// ---- the write path ----

test("blank product types are filled, and the merchant's own edit mid-flight wins", async () => {
  await withFlag("true", async () => {
    const prisma = makeMockPrisma();
    // p2 was typed by the merchant between Jefe proposing and Jefe executing — the likeliest
    // race here, and the one where overwriting would be worst.
    const client = makeMockClient({ p1: "", p2: "Soft drinks" });
    const result = await applyListingCopyChange({ prisma, shopifyClient: client, execution: execCtx() }, twoBlank());

    assert.deepEqual(result.applied.map((a) => a.productId), ["p1"]);
    assert.deepEqual(result.skipped.map((s) => s.reason), ["already_typed_upstream"]);
    assert.equal(client.types.get("p2"), "Soft drinks", "the merchant's own type was overwritten");
    assert.deepEqual(client.calls, [{ id: "p1", type: "Drinks" }]);
  });
});

test("re-running an approved change writes once, not twice", async () => {
  await withFlag("true", async () => {
    const prisma = makeMockPrisma();
    const client = makeMockClient({ p1: "", p2: "" });
    const preview = twoBlank();
    await applyListingCopyChange({ prisma, shopifyClient: client, execution: execCtx() }, preview);
    const second = await applyListingCopyChange({ prisma, shopifyClient: client, execution: execCtx() }, preview);
    assert.equal(client.calls.length, 2, "a retry re-wrote the catalogue");
    assert.equal(second.applied.every((a) => a.idempotent), true);
  });
});

test("a partial failure puts back only what this run changed", async () => {
  await withFlag("true", async () => {
    const prisma = makeMockPrisma();
    const client = makeMockClient({ p1: "", p2: "" });
    let writes = 0;
    const failing = {
      ...client,
      async getProductType(id) { return client.getProductType(id); },
      async updateProductType(id, type) {
        // Fail on the second product, after the first has already been written.
        if (++writes === 2 && type !== "") throw new Error("shopify 500");
        return client.updateProductType(id, type);
      },
    };
    await assert.rejects(
      () => applyListingCopyChange({ prisma, shopifyClient: failing, execution: execCtx() }, twoBlank()),
      /shopify 500/,
    );
    assert.equal(client.types.get("p1"), "", "the first product was left changed after a failed run");
  });
});

test("revert works with the feature switched off", async () => {
  // Turning the feature off must never strand a merchant with changes they cannot undo.
  await withFlag(undefined, async () => {
    const client = makeMockClient({ p1: "Drinks" });
    const result = await revertListingCopyChange(client, [{ productId: "p1", restoreType: "" }]);
    assert.deepEqual(result.failed, []);
    assert.equal(client.types.get("p1"), "");
  });
});
