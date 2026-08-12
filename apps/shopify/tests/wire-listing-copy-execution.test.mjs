import assert from "node:assert/strict";
import test from "node:test";
import { wireListingCopyExecution } from "../app/lib/actions/wire-listing-copy-execution.server.js";

// The wire layer is where a merchant's approval turns into a store write. Its job is mostly
// to REFUSE: wrong primitive, wrong mode, wrong state. The clearance wire had a real bug here
// once — a foreign action row reached its adapter because nothing checked the action type —
// so those refusals are what these tests are for.

function makeRow(over = {}) {
  return {
    runId: "run-1", merchantId: "m1", shopId: "s1",
    actionType: "listing_copy", actionKind: "set_product_type",
    status: "proposed", resolvedMode: "approve", merchantSetting: "approve_execute",
    eligibility: {}, confidence: 0.95,
    preview: {
      changes: [{ productId: "p1", title: "Cider", fromType: "", toType: "Beer" }],
      productCount: 1,
      refused: [],
      reversibilityPlan: [{ productId: "p1", restoreType: "" }],
    },
    ...over,
  };
}

function makePrisma(row) {
  const updates = [];
  return {
    updates,
    actionExecution: {
      async findUnique() { return row; },
      async update({ data }) { updates.push(data); Object.assign(row, data); return row; },
      async upsert({ create }) { return { id: "exec-1", ...create }; },
    },
    actionExecutionWrite: {
      async upsert({ create }) { return { id: "w-1", ...create }; },
      async update() { return null; },
    },
    session: { async findFirst() { return { accessToken: "tok" }; } },
  };
}

const session = { shop: "mock.myshopify.com" };
const deps = {
  loadOfflineToken: async () => "tok",
  createGqlClient: () => ({ async request() { return {}; } }),
};

async function withFlag(value, fn) {
  const prev = process.env.LISTING_COPY_EXECUTE_ENABLED;
  if (value === undefined) delete process.env.LISTING_COPY_EXECUTE_ENABLED;
  else process.env.LISTING_COPY_EXECUTE_ENABLED = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LISTING_COPY_EXECUTE_ENABLED;
    else process.env.LISTING_COPY_EXECUTE_ENABLED = prev;
  }
}

test("a clearance row can never be executed by the listing-copy wire", async () => {
  // The exact bug the clearance wire had: a foreign row whose preview also has `.changes`
  // passed every check and reached the wrong adapter, stopping only on a chance NOT NULL
  // constraint. Refusing by action type is the fix, and it belongs on BOTH wires.
  const row = makeRow({ actionType: "price_markdown" });
  const result = await wireListingCopyExecution(makePrisma(row), session, {
    merchantId: "m1", actionRunId: "run-1", mode: "approve",
  }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_primitive:price_markdown");
});

test("another merchant's run is not found, not executed", async () => {
  const result = await wireListingCopyExecution(makePrisma(makeRow()), session, {
    merchantId: "someone-else", actionRunId: "run-1", mode: "approve",
  }, deps);
  assert.equal(result.reason, "not_found");
});

test("asking for autonomous on an approve-only row is refused", async () => {
  // The merchant's dial is authoritative. A caller must never widen what they authorised.
  const result = await wireListingCopyExecution(makePrisma(makeRow({ resolvedMode: "approve" })), session, {
    merchantId: "m1", actionRunId: "run-1", mode: "auto",
  }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auto_not_authorized");
});

test("recommend mode never writes", async () => {
  const result = await wireListingCopyExecution(makePrisma(makeRow({ resolvedMode: "recommend" })), session, {
    merchantId: "m1", actionRunId: "run-1", mode: "approve",
  }, deps);
  assert.equal(result.reason, "recommend_mode");
});

test("an empty preview is refused rather than executed as a no-op", async () => {
  const row = makeRow({ preview: { changes: [], productCount: 0, refused: [], reversibilityPlan: [] } });
  const result = await wireListingCopyExecution(makePrisma(row), session, {
    merchantId: "m1", actionRunId: "run-1", mode: "approve",
  }, deps);
  assert.equal(result.reason, "empty_preview");
});

test("with the flag off the approval is recorded and nothing is written", async () => {
  await withFlag(undefined, async () => {
    const row = makeRow();
    const prisma = makePrisma(row);
    const result = await wireListingCopyExecution(prisma, session, {
      merchantId: "m1", actionRunId: "run-1", mode: "approve",
    }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "execution_disabled");
    // The merchant's approval must survive the flag being off — otherwise flipping it on
    // later silently loses what they already agreed to.
    assert.equal(row.status, "approved");
  });
});

test("an already-applied run is not re-executed", async () => {
  await withFlag("true", async () => {
    const result = await wireListingCopyExecution(makePrisma(makeRow({ status: "applied" })), session, {
      merchantId: "m1", actionRunId: "run-1", mode: "approve",
    }, deps);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "already_applied");
  });
});

test("a rejected run is not executable", async () => {
  const result = await wireListingCopyExecution(makePrisma(makeRow({ status: "rejected" })), session, {
    merchantId: "m1", actionRunId: "run-1", mode: "approve",
  }, deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not_executable:rejected/);
});

test("listing_copy is a resolvable primitive, so the generic propose path can reach it", async () => {
  // Registering in ACTION_REGISTRY is not enough — `proposeActionFromIntent` dispatches on the
  // PRIMITIVE BINDING table, and a type with no binding returns "no_resolver" and can never be
  // proposed. That gap is exactly why the live Settings dial did nothing.
  const { listResolvableActionTypes } = await import("../app/lib/actions/action-resolution.server.js");
  assert.ok(
    listResolvableActionTypes().includes("listing_copy"),
    "listing_copy has no primitive binding — the dial would be inert",
  );
  // Importing that module also runs the binding-completeness guard, which throws on a partial
  // binding rather than letting it silently inherit clearance's behaviour.
});
