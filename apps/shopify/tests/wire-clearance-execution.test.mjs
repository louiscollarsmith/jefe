import assert from "node:assert/strict";
import test from "node:test";
import { wireClearanceExecution } from "../app/lib/actions/wire-clearance-execution.server.js";

const SHOP = "test-shop.myshopify.com";

function makeRow(overrides = {}) {
  return {
    id: "exec-1",
    runId: "run-1",
    merchantId: "m-1",
    shopId: "s-1",
    actionType: "price_markdown",
    actionKind: "dead_stock_clearance",
    status: "proposed",
    merchantSetting: "approve_execute",
    resolvedMode: "approve",
    eligibility: { autoEligible: false, reversible: true },
    confidence: 1,
    preview: {
      changes: [{ variantId: "gid://v/1", fromPrice: 10, toPrice: 8, discountPercent: 20, title: "Widget" }],
      variantCount: 1,
      maxDiscountPercent: 20,
      refused: [],
      reversibilityPlan: [],
    },
    ...overrides,
  };
}

/** Stateful mock prisma covering approveAction + applyClearance + the offline-token load. */
function makeMockPrisma({ row, offlineToken } = {}) {
  const rows = new Map();
  const byId = new Map();
  const writes = new Map();
  let seq = 0;
  if (row) {
    rows.set(row.runId, row);
    byId.set(row.id, row);
  }
  const sessions = offlineToken
    ? [{ shop: SHOP, isOnline: false, accessToken: offlineToken, expires: new Date() }]
    : [];
  return {
    _rows: rows,
    session: {
      findFirst: async ({ where }) => {
        const m = sessions.filter((s) => s.shop === where.shop && s.isOnline === where.isOnline);
        return m[m.length - 1] ?? null;
      },
    },
    actionExecution: {
      findUnique: async ({ where }) => {
        const r = where.runId ? rows.get(where.runId) : byId.get(where.id);
        return r ? { ...r } : null;
      },
      update: async ({ where, data, select }) => {
        const r = where.runId ? rows.get(where.runId) : byId.get(where.id);
        if (!r) throw new Error("update: not found");
        Object.assign(r, data);
        if (!select) return { ...r };
        const out = {};
        for (const k of Object.keys(select)) out[k] = r[k];
        return out;
      },
      upsert: async ({ where, create, update }) => {
        let r = rows.get(where.runId);
        if (r) Object.assign(r, update);
        else {
          r = { id: `exec-${++seq}`, ...create };
          rows.set(r.runId, r);
          byId.set(r.id, r);
        }
        return { ...r };
      },
    },
    actionExecutionWrite: {
      upsert: async ({ where, create, update }) => {
        const k = JSON.stringify(where.executionId_targetRef_targetValueKey);
        let w = writes.get(k);
        if (w) Object.assign(w, update);
        else {
          w = { id: `w-${++seq}`, ...create };
          writes.set(k, w);
        }
        return { ...w };
      },
      update: async ({ where, data }) => {
        for (const w of writes.values()) if (w.id === where.id) return Object.assign(w, data), { ...w };
        throw new Error("write update: not found");
      },
    },
  };
}

/** Mock gql client (the deps.createGqlClient seam) reading/writing a shared price map. */
function makeGqlDep(priceByVariant) {
  const client = {
    request: async (query, variables) => {
      if (query.includes("productVariantsBulkUpdate")) {
        const v = variables.variants[0];
        priceByVariant.set(v.id, Number(v.price));
        return { productVariantsBulkUpdate: { productVariants: [{ id: v.id, price: v.price }], userErrors: [] } };
      }
      const id = variables.id;
      const price = priceByVariant.get(id);
      return { productVariant: price == null ? null : { id, price: String(price), product: { id: `prod-${id}` } } };
    },
  };
  return () => client;
}

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

const session = { shop: SHOP };

test("unknown run → not_found, no side effects", async () => {
  const prisma = makeMockPrisma({ row: makeRow() });
  const res = await wireClearanceExecution(prisma, session, { merchantId: "m-1", actionRunId: "nope", mode: "approve" });
  assert.equal(res.reason, "not_found");
  assert.equal(res.ok, false);
});

test("recommend-mode row never executes", async () => {
  const prisma = makeMockPrisma({ row: makeRow({ resolvedMode: "recommend" }) });
  const res = await wireClearanceExecution(prisma, session, { merchantId: "m-1", actionRunId: "run-1", mode: "approve" });
  assert.equal(res.reason, "recommend_mode");
  assert.equal(prisma._rows.get("run-1").status, "proposed"); // untouched
});

test("mode=auto is refused when the merchant setting didn't resolve to auto", async () => {
  const prisma = makeMockPrisma({ row: makeRow({ resolvedMode: "approve" }) });
  const res = await wireClearanceExecution(prisma, session, { merchantId: "m-1", actionRunId: "run-1", mode: "auto" });
  assert.equal(res.reason, "auto_not_authorized");
  assert.equal(prisma._rows.get("run-1").status, "proposed");
});

test("empty preview is refused", async () => {
  const prisma = makeMockPrisma({ row: makeRow({ preview: { changes: [], variantCount: 0 } }) });
  const res = await wireClearanceExecution(prisma, session, { merchantId: "m-1", actionRunId: "run-1", mode: "approve" });
  assert.equal(res.reason, "empty_preview");
});

test("flag OFF: records approval but writes nothing", async () => {
  const prisma = makeMockPrisma({ row: makeRow(), offlineToken: "tok" });
  const prices = new Map([["gid://v/1", 10]]);
  const res = await wireClearanceExecution(
    prisma,
    session,
    { merchantId: "m-1", actionRunId: "run-1", mode: "approve" },
    { createGqlClient: makeGqlDep(prices) },
  );
  assert.equal(res.executed, false);
  assert.equal(res.reason, "execution_disabled");
  assert.equal(prisma._rows.get("run-1").status, "approved"); // approval recorded
  assert.equal(prices.get("gid://v/1"), 10); // unchanged
});

test("flag ON + approve: executes the markdown", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma({ row: makeRow(), offlineToken: "tok" });
    const prices = new Map([["gid://v/1", 10]]);
    const res = await wireClearanceExecution(
      prisma,
      session,
      { merchantId: "m-1", actionRunId: "run-1", mode: "approve" },
      { createGqlClient: makeGqlDep(prices) },
    );
    assert.equal(res.executed, true);
    assert.equal(res.ok, true);
    assert.equal(res.status, "applied");
    assert.equal(res.appliedCount, 1);
    assert.equal(prices.get("gid://v/1"), 8); // the store was written
    assert.equal(prisma._rows.get("run-1").status, "applied");
    assert.equal(prisma._rows.get("run-1").approvedBy, "m-1");
  });
});

test("flag ON + auto (authorized): executes with approvedBy=auto", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma({ row: makeRow({ resolvedMode: "auto" }), offlineToken: "tok" });
    const prices = new Map([["gid://v/1", 10]]);
    const res = await wireClearanceExecution(
      prisma,
      session,
      { merchantId: "m-1", actionRunId: "run-1", mode: "auto" },
      { createGqlClient: makeGqlDep(prices) },
    );
    assert.equal(res.status, "applied");
    assert.equal(prisma._rows.get("run-1").approvedBy, "auto");
  });
});

test("flag ON: compare-and-set skips on price drift", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma({ row: makeRow(), offlineToken: "tok" });
    const prices = new Map([["gid://v/1", 99]]); // live ≠ preview fromPrice (10)
    const res = await wireClearanceExecution(
      prisma,
      session,
      { merchantId: "m-1", actionRunId: "run-1", mode: "approve" },
      { createGqlClient: makeGqlDep(prices) },
    );
    assert.equal(res.executed, true);
    assert.equal(res.skippedCount, 1);
    assert.equal(res.appliedCount, 0);
    assert.equal(prices.get("gid://v/1"), 99); // never written
  });
});

test("flag ON: idempotent re-fire returns already_applied", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma({ row: makeRow(), offlineToken: "tok" });
    const prices = new Map([["gid://v/1", 10]]);
    const deps = { createGqlClient: makeGqlDep(prices) };
    const first = await wireClearanceExecution(prisma, session, { merchantId: "m-1", actionRunId: "run-1", mode: "approve" }, deps);
    assert.equal(first.status, "applied");
    const second = await wireClearanceExecution(prisma, session, { merchantId: "m-1", actionRunId: "run-1", mode: "approve" }, deps);
    assert.equal(second.executed, false);
    assert.equal(second.reason, "already_applied");
  });
});

test("flag ON: missing offline token throws (no silent write)", async () => {
  await withExecuteEnabled(async () => {
    const prisma = makeMockPrisma({ row: makeRow() }); // no offlineToken seeded
    await assert.rejects(
      () =>
        wireClearanceExecution(
          prisma,
          session,
          { merchantId: "m-1", actionRunId: "run-1", mode: "approve" },
          { createGqlClient: makeGqlDep(new Map([["gid://v/1", 10]])) },
        ),
      /offline Shopify session token/,
    );
  });
});
