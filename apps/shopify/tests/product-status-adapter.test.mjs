import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRODUCT_STATUS_CAPS,
  isProductStatusExecuteEnabled,
  buildProductStatusPreview,
  enforceBlastRadiusCap,
  computeProductStatusAutoEligibility,
  applyProductStatusChange,
  revertProductStatusChange,
} from "../app/lib/actions/product-status-adapter.server.js";

// ---- doubles (mirror tests/clearance-adapter.test.mjs) ----

function makeMockClient(initial = {}) {
  const statuses = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    statuses,
    async getProductStatus(id) { return statuses.has(id) ? statuses.get(id) : null; },
    async updateProductStatus(id, status) { calls.push({ id, status }); statuses.set(id, status); return { id, status }; },
  };
}

function makeMockPrisma() {
  const executions = new Map(); // runId -> row
  const writes = new Map(); // `${executionId}|${targetRef}|${targetValueKey}` -> row
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
    actionType: "product_status_change", actionKind: "archive_product",
    merchantSetting: "approve_execute", resolvedMode: "approve",
    eligibility: {}, confidence: 0.95, ...over,
  };
}

function archiveTwo() {
  return buildProductStatusPreview({
    items: [
      { productId: "p1", title: "A", currentStatus: "ACTIVE", targetStatus: "ARCHIVED" },
      { productId: "p2", title: "B", currentStatus: "ACTIVE", targetStatus: "ARCHIVED" },
    ],
  });
}

async function withExecuteEnabled(fn) {
  const prev = process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
  process.env.PRODUCT_STATUS_EXECUTE_ENABLED = "true";
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
    else process.env.PRODUCT_STATUS_EXECUTE_ENABLED = prev;
  }
}

async function withExecuteDisabled(fn) {
  const prev = process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
  delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
    else process.env.PRODUCT_STATUS_EXECUTE_ENABLED = prev;
  }
}

// ---- pure functions ----

test("flag is exact-string, default off", () => {
  const prev = process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
  try {
    delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
    assert.equal(isProductStatusExecuteEnabled(), false);
    process.env.PRODUCT_STATUS_EXECUTE_ENABLED = "1";
    assert.equal(isProductStatusExecuteEnabled(), false);
    process.env.PRODUCT_STATUS_EXECUTE_ENABLED = "true";
    assert.equal(isProductStatusExecuteEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
    else process.env.PRODUCT_STATUS_EXECUTE_ENABLED = prev;
  }
});

test("preview refuses no-ops + invalid statuses + missing ids; plans reversibility", () => {
  const p = buildProductStatusPreview({
    items: [
      { productId: "p1", currentStatus: "ACTIVE", targetStatus: "ARCHIVED" },
      { productId: "p2", currentStatus: "ARCHIVED", targetStatus: "ARCHIVED" }, // noop
      { productId: "p3", currentStatus: "ACTIVE", targetStatus: "BOGUS" }, // invalid
      { productId: null, currentStatus: "ACTIVE", targetStatus: "ARCHIVED" }, // no id
    ],
  });
  assert.equal(p.productCount, 1);
  assert.equal(p.changes[0].productId, "p1");
  assert.deepEqual(p.reversibilityPlan, [{ productId: "p1", restoreStatus: "ACTIVE" }]);
  assert.equal(p.refused.length, 2);
});

test("enforceBlastRadiusCap blocks over-cap, passes within", () => {
  assert.equal(enforceBlastRadiusCap(archiveTwo()).withinCap, true);
  const over = buildProductStatusPreview({ items: Array.from({ length: DEFAULT_PRODUCT_STATUS_CAPS.maxProducts + 1 }, (_, i) => ({ productId: `p${i}`, currentStatus: "ACTIVE", targetStatus: "ARCHIVED" })) });
  const r = enforceBlastRadiusCap(over);
  assert.equal(r.withinCap, false);
  assert.equal(r.violations[0].cap, "maxProducts");
});

test("auto-eligibility = reversible ∧ within-cap ∧ confident", () => {
  const p = archiveTwo();
  assert.equal(computeProductStatusAutoEligibility(p, 0.95).autoEligible, true);
  assert.deepEqual(computeProductStatusAutoEligibility(p, 0.5).reasons, ["below_confidence_threshold"]);
});

// ---- apply: guards ----

test("disabled: apply throws (flag off is the default)", async () => {
  await withExecuteDisabled(async () => {
    await assert.rejects(
      () => applyProductStatusChange({ prisma: makeMockPrisma(), shopifyClient: makeMockClient(), execution: execCtx() }, archiveTwo()),
      /disabled/,
    );
  });
});

test("recommend mode refuses to execute", async () => {
  await withExecuteEnabled(async () => {
    await assert.rejects(
      () => applyProductStatusChange({ prisma: makeMockPrisma(), shopifyClient: makeMockClient({ p1: "ACTIVE", p2: "ACTIVE" }), execution: execCtx({ resolvedMode: "recommend" }) }, archiveTwo()),
      /recommend/,
    );
  });
});

test("missing prisma ledger / missing client are refused", async () => {
  await withExecuteEnabled(async () => {
    await assert.rejects(() => applyProductStatusChange({ prisma: {}, shopifyClient: makeMockClient(), execution: execCtx() }, archiveTwo()), /ledger/);
    await assert.rejects(() => applyProductStatusChange({ prisma: makeMockPrisma(), shopifyClient: {}, execution: execCtx() }, archiveTwo()), /shopifyClient/);
  });
});

test("over-cap blocks BEFORE any store write", async () => {
  await withExecuteEnabled(async () => {
    const over = buildProductStatusPreview({ items: Array.from({ length: DEFAULT_PRODUCT_STATUS_CAPS.maxProducts + 1 }, (_, i) => ({ productId: `p${i}`, currentStatus: "ACTIVE", targetStatus: "ARCHIVED" })) });
    const client = makeMockClient();
    await assert.rejects(() => applyProductStatusChange({ prisma: makeMockPrisma(), shopifyClient: client, execution: execCtx() }, over), /blast-radius/);
    assert.deepEqual(client.calls, [], "no writes when cap exceeded");
  });
});

// ---- apply: behavior ----

test("happy path: writes the store + ledger, both applied", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma();
    const client = makeMockClient({ p1: "ACTIVE", p2: "ACTIVE" });
    const res = await applyProductStatusChange({ prisma, shopifyClient: client, execution: execCtx() }, archiveTwo());
    assert.equal(res.ok, true);
    assert.equal(res.status, "applied");
    assert.equal(res.appliedCount, 2);
    assert.equal(client.statuses.get("p1"), "ARCHIVED");
    assert.equal(client.statuses.get("p2"), "ARCHIVED");
    assert.equal(prisma._executions.get("run-1").status, "applied");
    assert.equal([...prisma._writes.values()].filter((w) => w.status === "applied").length, 2);
  });
});

test("compare-and-set: a drifted product is skipped, not overwritten (partially_applied)", async () => {
  await withExecuteEnabled(async () => {
    const client = makeMockClient({ p1: "ACTIVE", p2: "DRAFT" }); // p2 drifted off ACTIVE
    const res = await applyProductStatusChange({ prisma: makeMockPrisma(), shopifyClient: client, execution: execCtx() }, archiveTwo());
    assert.equal(res.status, "partially_applied");
    assert.equal(res.appliedCount, 1);
    assert.equal(res.skippedCount, 1);
    assert.equal(res.skipped[0].reason, "status_drift");
    assert.equal(client.statuses.get("p2"), "DRAFT", "drifted product untouched");
  });
});

test("second run under the same runId is idempotent (no re-write)", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma();
    const client = makeMockClient({ p1: "ACTIVE", p2: "ACTIVE" });
    await applyProductStatusChange({ prisma, shopifyClient: client, execution: execCtx() }, archiveTwo());
    const callsAfterFirst = client.calls.length;
    const second = await applyProductStatusChange({ prisma, shopifyClient: client, execution: execCtx() }, archiveTwo());
    assert.ok(second.applied.every((a) => a.idempotent), "all marked idempotent");
    assert.equal(client.calls.length, callsAfterFirst, "no new store writes on re-run");
  });
});

test("mid-run failure auto-reverts already-applied changes + marks the run reverted", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma();
    const client = makeMockClient({ p1: "ACTIVE", p2: "ACTIVE" });
    const base = client.updateProductStatus.bind(client);
    client.updateProductStatus = async (id, status) => {
      if (id === "p2" && status === "ARCHIVED") throw new Error("boom");
      return base(id, status);
    };
    const res = await applyProductStatusChange({ prisma, shopifyClient: client, execution: execCtx() }, archiveTwo());
    assert.equal(res.ok, false);
    assert.equal(res.revertedCount, 1, "p1 rolled back");
    assert.equal(client.statuses.get("p1"), "ACTIVE", "p1 restored to prior status");
    assert.equal(prisma._executions.get("run-1").status, "reverted");
  });
});

// ---- revert (un-gated) ----

test("revert requires the injected client", async () => {
  await assert.rejects(() => revertProductStatusChange(null, []), /injected shopifyClient/);
});

test("revert restores prior status + skips malformed plan entries", async () => {
  const client = makeMockClient({ p1: "ARCHIVED" });
  const r = await revertProductStatusChange(client, [
    { productId: "p1", restoreStatus: "ACTIVE" },
    { productId: null, restoreStatus: "ACTIVE" },
    { productId: "p2", restoreStatus: "BOGUS" },
  ]);
  assert.equal(r.restoredCount, 1);
  assert.equal(r.skippedCount, 2);
  assert.equal(client.statuses.get("p1"), "ACTIVE");
});

test("revert works even with the execute flag unset (undo is never trappable)", async () => {
  await withExecuteDisabled(async () => {
    const client = makeMockClient({ p1: "ARCHIVED" });
    const r = await revertProductStatusChange(client, [{ productId: "p1", restoreStatus: "ACTIVE" }]);
    assert.equal(r.restoredCount, 1);
    assert.equal(client.statuses.get("p1"), "ACTIVE");
  });
});
