import assert from "node:assert/strict";
import test from "node:test";
import {
  proposeActionFromIntent,
  rejectAction,
  toSuggestedAction,
} from "../app/lib/actions/action-resolution.server.js";

// Minimal execution-row stub for approve/reject (findUnique + update).
function mockExecPrisma(row) {
  let current = row;
  return {
    actionExecution: {
      findUnique: async () => (current ? { ...current } : null),
      update: async ({ data }) => {
        current = { ...current, ...data };
        return { ...current };
      },
    },
  };
}

// A tiny prisma stub: canned reads for buildDeadStockClearanceProposal's 3 queries
// + a capturing actionExecution.create. No DB needed — proves the full orchestration.
function mockPrisma({ variants = [], inventory = [], soldLineItems = [], actionMode = null, onCreate }) {
  return {
    variant: { findMany: async () => variants },
    inventoryLevel: { findMany: async () => inventory },
    orderLineItem: { findMany: async () => soldLineItems },
    actionAutonomyPolicy: { findUnique: async () => (actionMode ? { mode: actionMode } : null) },
    actionExecution: {
      create: async ({ data }) => {
        onCreate?.(data);
        return { id: "exec-1", runId: data.runId, resolvedMode: data.resolvedMode };
      },
    },
  };
}

test("toSuggestedAction shapes render-ready structured data (money in keyNumbers, advisory)", () => {
  const sa = toSuggestedAction({
    proposal: { windowDays: 90, totalTrappedCapital: 800, totalProjectedRecovery: 1400 },
    preview: { variantCount: 1, changes: [{ variantId: "v1", title: "Parka", fromPrice: 200, toPrice: 140, discountPercent: 30 }] },
    runId: "run-1",
    executable: false,
  });
  assert.equal(sa.actionRunId, "run-1");
  assert.equal(sa.executable, false);
  assert.deepEqual(sa.keyNumbers.find((n) => n.label === "Trapped capital"), { label: "Trapped capital", value: 800 });
  assert.equal(sa.topItems[0].detail, "200 → 140 (−30%)");
});

test("proposeActionFromIntent rejects an invalid intent before touching the DB", async () => {
  let created = false;
  const prisma = mockPrisma({ onCreate: () => { created = true; } });
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "wire_money", targetKind: "bank" },
  });
  assert.equal(res.status, "invalid");
  assert.equal(res.reason, "unknown_action_type:wire_money");
  assert.equal(created, false); // never proposed a bogus action
});

test("proposeActionFromIntent: intent -> deterministic proposal -> proposed row + SuggestedAction", async () => {
  let row = null;
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [], // no sales in window -> dead stock
    onCreate: (data) => { row = data; },
  });

  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock", params: { markdownPercent: 30 } },
  });

  assert.equal(res.status, "proposed");
  // The proposed ledger row is created generically + safely:
  assert.equal(row.actionType, "price_markdown");
  assert.equal(row.actionKind, "dead_stock_clearance");
  assert.equal(row.status, "proposed");
  assert.equal(row.merchantSetting, "approve_execute"); // v1 default (propose + execute-on-approve)
  assert.equal(row.resolvedMode, "approve"); // merchant approves; not auto until they opt in
  assert.equal(row.preview.variantCount, 1);
  assert.equal(row.preview.changes[0].toPrice, 140); // 30% off 200, above the 80 floor
  assert.equal(row.preview.changes[0].floorPrice, 80);
  // The card data: advisory (executable false), money in keyNumbers, carries the runId.
  assert.equal(res.suggestedAction.executable, false);
  assert.equal(res.suggestedAction.actionRunId, row.runId);
  assert.equal(res.suggestedAction.keyNumbers.find((n) => n.label === "Projected recovery").value, 1400);
});

test("the merchant's dial drives the mode: autonomous + eligible -> resolvedMode auto", async () => {
  let row = null;
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [],
    actionMode: "autonomous", // merchant opted into auto for this action-type
    onCreate: (data) => { row = data; },
  });
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock", params: { markdownPercent: 30 } },
  });
  assert.equal(res.status, "proposed");
  assert.equal(row.merchantSetting, "autonomous");
  assert.equal(row.resolvedMode, "auto"); // reversible + capped + confident + merchant=autonomous
});

test("proposeActionFromIntent returns no_opportunity when there's no dead stock", async () => {
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [{ variantId: "v1" }], // sold in window -> not dead
  });
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock" },
  });
  assert.equal(res.status, "no_opportunity");
});

test("rejectAction refuses a non-proposed or wrong-merchant action (no write)", async () => {
  const applied = mockExecPrisma({ id: "e1", runId: "r1", merchantId: "m1", status: "applied" });
  assert.equal((await rejectAction(applied, { merchantId: "m1", actionRunId: "r1" })).status, "not_proposable");
  const wrong = mockExecPrisma({ id: "e1", runId: "r1", merchantId: "m1", status: "proposed" });
  assert.equal((await rejectAction(wrong, { merchantId: "intruder", actionRunId: "r1" })).status, "not_found");
});

test("rejectAction drops a proposed action: proposed -> rejected", async () => {
  const prisma = mockExecPrisma({ id: "e1", runId: "r1", merchantId: "m1", status: "proposed" });
  const res = await rejectAction(prisma, { merchantId: "m1", actionRunId: "r1" });
  assert.equal(res.status, "rejected");
  assert.equal(res.execution.status, "rejected");
});
