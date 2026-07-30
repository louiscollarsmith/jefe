import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActionDeclinedEvent,
  buildProposalSummary,
  formatMoney,
  getActiveSuggestedAction,
  proposeActionFromIntent,
  rejectAction,
  reviseAction,
  toSuggestedAction,
} from "../app/lib/actions/action-resolution.server.js";

// Minimal execution-row stub for reject (findUnique + update + the activity-event
// sink track() writes the decline signal to).
function mockExecPrisma(row) {
  let current = row;
  const events = [];
  return {
    _events: events,
    actionExecution: {
      findUnique: async () => (current ? { ...current } : null),
      update: async ({ data }) => {
        current = { ...current, ...data };
        return { ...current };
      },
    },
    activityEvent: { create: async ({ data }) => { events.push(data); } },
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
  // Money summary persisted on the row so the card renders without a re-query.
  assert.equal(row.proposalSummary.variantCount, 1);
  assert.equal(row.proposalSummary.totalTrappedCapital, 800); // 10 units × £80 cost
  assert.equal(row.proposalSummary.totalProjectedRecovery, 1400); // 10 units × £140
  assert.deepEqual(row.proposalSummary.topItems[0], { title: "Parka", unitsOnHand: 10, trappedCapital: 800 });
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

test("buildActionDeclinedEvent captures the split decline reason as a PII-safe signal", () => {
  const ev = buildActionDeclinedEvent(
    { merchantId: "m1", shopId: "s1", actionType: "price_markdown", runId: "r1" },
    { reasonCategory: "too_aggressive", reasonText: "margins are already thin" },
  );
  assert.equal(ev.type, "merchant_action_declined");
  assert.equal(ev.topic, "action_feedback");
  assert.equal(ev.properties.actionType, "price_markdown");
  assert.equal(ev.properties.reasonCategory, "too_aggressive");
  assert.equal(ev.properties.reasonText, "margins are already thin");
  assert.equal(ev.properties.runId, "r1");
  assert.match(ev.summary, /too_aggressive/); // category leads the summary label
  // Legacy plain-string reason still accepted → mapped to reasonText (category null).
  const legacy = buildActionDeclinedEvent(
    { merchantId: "m1", actionType: "price_markdown", runId: "r1" },
    "not_now",
  );
  assert.equal(legacy.properties.reasonCategory, null);
  assert.equal(legacy.properties.reasonText, "not_now");
  // No reason → still a valid signal, both null.
  const none = buildActionDeclinedEvent({ merchantId: "m1", actionType: "price_markdown", runId: "r1" });
  assert.equal(none.properties.reasonCategory, null);
  assert.equal(none.properties.reasonText, null);
});

test("formatMoney renders the shop currency the card shows as-is", () => {
  assert.equal(formatMoney(810, "GBP"), "£810");
  assert.equal(formatMoney(1400.5, "USD"), "$1,401"); // rounded, en-GB grouping
  assert.equal(formatMoney(2500, "EUR"), "€2,500");
  assert.equal(formatMoney(99, "SEK"), "SEK 99"); // unknown code → prefixed
  assert.equal(formatMoney(null, "GBP"), "—");
  assert.equal(formatMoney(undefined), "—");
});

test("buildProposalSummary totals only surviving items + carries units/trapped for topItems", () => {
  const proposal = {
    windowDays: 90,
    items: [
      { variantId: "v1", title: "Parka", unitsOnHand: 10, trappedCapital: 800, projectedRecovery: 1400 },
      { variantId: "v2", title: "Boots", unitsOnHand: 4, trappedCapital: 200, projectedRecovery: 320 },
      { variantId: "v3", title: "Hat (below floor)", unitsOnHand: 3, trappedCapital: 90, projectedRecovery: 60 },
    ],
  };
  // Preview kept v1 + v2, refused v3 (below floor) — totals must match the shown set.
  const preview = { variantCount: 2, changes: [{ variantId: "v1" }, { variantId: "v2" }] };
  const summary = buildProposalSummary(proposal, preview);
  assert.equal(summary.variantCount, 2);
  assert.equal(summary.windowDays, 90);
  assert.equal(summary.totalTrappedCapital, 1000); // 800 + 200, NOT +90
  assert.equal(summary.totalProjectedRecovery, 1720); // 1400 + 320
  assert.equal(summary.topItems.length, 2);
  assert.deepEqual(summary.topItems[0], { title: "Parka", unitsOnHand: 10, trappedCapital: 800 });
});

test("getActiveSuggestedAction: latest proposed row → formatted card (advisory while flag off)", async () => {
  delete process.env.CLEARANCE_EXECUTE_ENABLED; // deterministic: write path off
  const row = {
    runId: "run-9",
    actionType: "price_markdown",
    resolvedMode: "approve",
    proposalSummary: {
      windowDays: 90,
      variantCount: 2,
      totalTrappedCapital: 1000,
      totalProjectedRecovery: 1720,
      topItems: [{ title: "Parka", unitsOnHand: 10, trappedCapital: 810 }],
    },
    preview: { variantCount: 2 },
  };
  const prisma = {
    actionExecution: { findFirst: async () => ({ ...row }) },
    actionAutonomyPolicy: { findUnique: async () => ({ mode: "approve_execute" }) },
  };
  const sa = await getActiveSuggestedAction(prisma, { merchantId: "m1", shopId: "s1", currency: "GBP" });
  assert.equal(sa.actionRunId, "run-9");
  assert.equal(sa.actionType, "price_markdown");
  assert.equal(sa.mode, "approve_execute"); // current dial (getActionMode), not the snapshot
  assert.equal(sa.executable, false); // write path off → advisory, no live Approve
  assert.match(sa.headline, /2 products/);
  assert.match(sa.headline, /90 days/);
  assert.equal(sa.keyNumbers.find((n) => n.label === "Trapped capital").value, "£1,000");
  assert.equal(sa.keyNumbers.find((n) => n.label === "Projected recovery").value, "£1,720");
  assert.equal(sa.keyNumbers.find((n) => n.label === "Products").value, "2");
  assert.equal(sa.topItems[0].detail, "10 units · £810 tied up");
});

test("getActiveSuggestedAction returns null when nothing is proposed", async () => {
  const prisma = { actionExecution: { findFirst: async () => null } };
  assert.equal(await getActiveSuggestedAction(prisma, { merchantId: "m1", shopId: "s1" }), null);
});

test("reviseAction re-proposes at the new markdown + supersedes the original", async () => {
  const original = {
    id: "e-old",
    runId: "run-old",
    merchantId: "m1",
    shopId: "s1",
    status: "proposed",
    actionType: "price_markdown",
    actionKind: "dead_stock_clearance",
    merchantSetting: "approve_execute",
  };
  let created = null;
  let supersededRunId = null;
  const prisma = {
    variant: { findMany: async () => [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }] },
    inventoryLevel: { findMany: async () => [{ variantId: "v1", available: 10 }] },
    orderLineItem: { findMany: async () => [] },
    actionAutonomyPolicy: { findUnique: async () => ({ mode: "approve_execute" }) },
    actionExecution: {
      findUnique: async () => ({ ...original }),
      create: async ({ data }) => {
        created = data;
        return { id: "e-new", runId: data.runId, resolvedMode: data.resolvedMode };
      },
      update: async ({ where, data }) => {
        if (data.status === "superseded") supersededRunId = where.runId;
        return { runId: where.runId, ...data };
      },
    },
  };
  const res = await reviseAction(prisma, { merchantId: "m1", actionRunId: "run-old", params: { markdownPercent: 50 } });
  assert.equal(res.status, "revised");
  assert.equal(res.superseded, "run-old");
  assert.equal(supersededRunId, "run-old"); // the original is superseded, not left active
  assert.equal(created.actionType, "price_markdown");
  assert.equal(created.merchantSetting, "approve_execute"); // the merchant's dial is preserved
  assert.equal(created.preview.changes[0].toPrice, 100); // 50% off 200 = 100, above the 80 floor
});

test("reviseAction refuses a non-proposed run or the wrong merchant (no re-propose)", async () => {
  const proposedRow = {
    id: "e1", runId: "r1", merchantId: "m1", status: "proposed",
    actionType: "price_markdown", actionKind: "dead_stock_clearance", merchantSetting: "approve_execute",
  };
  const approved = { actionExecution: { findUnique: async () => ({ ...proposedRow, status: "approved" }) } };
  assert.equal(
    (await reviseAction(approved, { merchantId: "m1", actionRunId: "r1", params: { markdownPercent: 40 } })).status,
    "not_revisable",
  );
  const wrong = { actionExecution: { findUnique: async () => ({ ...proposedRow }) } };
  assert.equal(
    (await reviseAction(wrong, { merchantId: "intruder", actionRunId: "r1", params: { markdownPercent: 40 } })).status,
    "not_found",
  );
});
