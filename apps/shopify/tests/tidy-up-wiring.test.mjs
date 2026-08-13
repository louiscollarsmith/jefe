import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_REGISTRY,
  listActionCapabilities,
  listActionTypes,
} from "../app/lib/actions/action-intent.server.js";
import { listResolvableActionTypes } from "../app/lib/actions/action-resolution.server.js";
import { listExecutableActionTypes } from "../app/lib/actions/execute-approved-action.server.js";
import { wireTidyUpExecution } from "../app/lib/actions/wire-tidy-up-execution.server.js";

// An action type lives in THREE tables that nothing forces to agree: the registry (metadata +
// the go-live flag), the binding table (can it be proposed) and the wire map (can an approval
// execute it). Registered-but-unbound is advertisable to the LLM and unresolvable; bound-but-
// unwired means the merchant taps approve and nothing happens. Both have already shipped here
// once. This test is the thing that keeps them in step.

test("every registered action type is both resolvable and executable", () => {
  const registered = Object.keys(ACTION_REGISTRY).sort();
  assert.deepEqual(listResolvableActionTypes().sort(), registered, "registry vs binding table");
  assert.deepEqual(listExecutableActionTypes().sort(), registered, "registry vs wire map");
});

test("tidy_up is registered with a reversible primitive and no new scope", () => {
  const def = ACTION_REGISTRY.tidy_up;
  assert.ok(def, "tidy_up must be registered");
  assert.equal(def.reversible, true);
  assert.deepEqual(def.targetKinds, ["stale_listing"]);
  // ⛔ write_products is already granted and already exercised by clearance. A tidy-up that
  // quietly needed a NEW scope would be a consent change disguised as a feature.
  assert.deepEqual(def.requiredScopes, ["write_products"]);
  // One adapter, one go-live switch — never a second flag name for the same write path.
  assert.equal(def.executeFlag, "PRODUCT_STATUS_EXECUTE_ENABLED");
});

test("⛔ tidy_up is DARK until the flag is exactly 'true'", () => {
  const liveWith = (env) => listActionTypes(env).find((a) => a.actionType === "tidy_up").live;
  assert.equal(liveWith({}), false, "unset must be dark");
  assert.equal(liveWith({ PRODUCT_STATUS_EXECUTE_ENABLED: "1" }), false);
  assert.equal(liveWith({ PRODUCT_STATUS_EXECUTE_ENABLED: "TRUE" }), false);
  assert.equal(liveWith({ PRODUCT_STATUS_EXECUTE_ENABLED: "true" }), true);
});

test("dark means CANNOT WRITE, not CANNOT SPEAK", () => {
  // Registering an action type does two separate things, and conflating them is how "it's
  // behind a flag" gets read as "nothing happens". With the flag off:
  //   - the dial stays SOON and no store write is possible (asserted above), AND
  //   - the model is still told the capability exists, so Jefe can PROPOSE it as advice.
  // The second half is deliberate — the no-dead-ends rule means Jefe should say a tidy-up is
  // worth doing even when it can only tell the merchant how to do it themselves.
  const advertised = listActionCapabilities().map((c) => c.actionType);
  assert.ok(
    advertised.includes("tidy_up"),
    "tidy_up must reach the model even while its write flag is off",
  );
  const capability = listActionCapabilities().find((c) => c.actionType === "tidy_up");
  assert.deepEqual(capability.targetKinds, ["stale_listing"]);
});

test("⛔ tidy_up is not suited to a made-to-order business", () => {
  // A maker who holds no stock has a catalogue that looks exactly like stale listings to a
  // stock-based test. Archiving it would be the worst thing Jefe could do to them.
  assert.ok(ACTION_REGISTRY.tidy_up.applicability.unsuitedWhen.includes("made_to_order"));
});

// ── the wire's refusals ──────────────────────────────────────────────────────────────
const session = { shop: "mock.myshopify.com" };
const deps = {
  loadOfflineToken: async () => "tok",
  createGqlClient: () => ({ async request() { return {}; } }),
};

function prismaWith(row, updates = []) {
  return {
    updates,
    actionExecution: {
      async findUnique() { return row; },
      async update(args) { updates.push(args); return { ...row, ...args.data }; },
    },
  };
}

const READY_ROW = {
  runId: "run-1",
  merchantId: "m1",
  shopId: "s1",
  actionType: "tidy_up",
  status: "proposed",
  resolvedMode: "approve",
  preview: { changes: [{ productId: "gid://shopify/Product/1", fromStatus: "ACTIVE", toStatus: "ARCHIVED" }] },
};

test("a foreign row is refused rather than run through the wrong primitive", async () => {
  const result = await wireTidyUpExecution(
    prismaWith({ ...READY_ROW, actionType: "price_markdown" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_primitive:price_markdown");
});

test("another merchant's run is not found", async () => {
  const result = await wireTidyUpExecution(
    prismaWith({ ...READY_ROW, merchantId: "someone-else" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    deps,
  );
  assert.deepEqual(result, { ok: false, executed: false, reason: "not_found" });
});

test("⛔ 'auto' cannot execute a run the merchant only authorised for approval", async () => {
  const result = await wireTidyUpExecution(
    prismaWith({ ...READY_ROW, resolvedMode: "approve" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "auto" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auto_not_authorized");
});

test("an empty preview writes nothing", async () => {
  const result = await wireTidyUpExecution(
    prismaWith({ ...READY_ROW, preview: { changes: [] } }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_preview");
});

test("⛔ flag off: the approval is RECORDED and nothing is written", async () => {
  // The safe no-op. The merchant's decision must survive the flag being off — otherwise
  // turning execution on later loses every approval made in the meantime.
  const previous = process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
  delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
  try {
    const updates = [];
    const result = await wireTidyUpExecution(
      prismaWith({ ...READY_ROW }, updates),
      session,
      { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "execution_disabled");
    assert.equal(updates.length, 1, "the proposed→approved transition is still recorded");
    assert.equal(updates[0].data.status, "approved");
  } finally {
    if (previous === undefined) delete process.env.PRODUCT_STATUS_EXECUTE_ENABLED;
    else process.env.PRODUCT_STATUS_EXECUTE_ENABLED = previous;
  }
});

test("an already-applied run is not applied twice", async () => {
  const result = await wireTidyUpExecution(
    prismaWith({ ...READY_ROW, status: "applied" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "already_applied");
});
