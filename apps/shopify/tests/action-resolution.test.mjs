import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActionDeclinedEvent,
  buildProposalSummary,
  formatMoney,
  getActiveSuggestedAction,
  getExecutedActionFeed,
  getScopeGatedOpportunity,
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
function mockPrisma({ variants = [], inventory = [], soldLineItems = [], actionMode = null, policy = null, onCreate }) {
  return {
    variant: { findMany: async () => variants },
    inventoryLevel: { findMany: async () => inventory },
    orderLineItem: { findMany: async () => soldLineItems },
    actionAutonomyPolicy: { findUnique: async () => (actionMode || policy ? { mode: actionMode ?? "approve_execute", policy } : null) },
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
  assert.equal(row.proposalSummary.markdownPercent, 30); // the requested % (intent params)
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

test("autonomy policy: autonomous + eligible but over the £ cap → degraded to approve", async () => {
  let row = null;
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [],
    actionMode: "autonomous",
    policy: { autoMaxTrappedCapital: 500 }, // £500 auto cap; this run is £800 (10 × £80)
    onCreate: (data) => { row = data; },
  });
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock", params: { markdownPercent: 30 } },
  });
  assert.equal(res.status, "proposed");
  assert.equal(row.merchantSetting, "autonomous");
  assert.equal(row.resolvedMode, "approve"); // over-cap → ask first, not auto
  assert.equal(res.autonomy.reason, "exceeds_autonomy_policy");
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

test("close the learn loop: no explicit markdown eases from memory after 'too aggressive' declines", async () => {
  let row = null;
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [],
    onCreate: (data) => { row = data; },
  });
  // Merchant's Observe→Learn belief: past clearances were declined as too aggressive.
  prisma.merchantMemoryBelief = { findFirst: async () => ({ status: "inferred", value: { topReasonCategory: "too_aggressive", totalDeclines: 4 } }) };
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock" }, // NO markdownPercent → default adapts
  });
  assert.equal(res.status, "proposed");
  assert.equal(row.proposalSummary.markdownPercent, 20); // eased 30 → 20
  assert.equal(row.preview.changes[0].toPrice, 160); // 20% off 200, above the 80 floor
});

test("close the learn loop: an explicit markdown is respected (memory only adapts the default)", async () => {
  let row = null;
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [],
    onCreate: (data) => { row = data; },
  });
  prisma.merchantMemoryBelief = { findFirst: async () => ({ status: "inferred", value: { topReasonCategory: "too_aggressive", totalDeclines: 4 } }) };
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock", params: { markdownPercent: 40 } }, // explicit
  });
  assert.equal(res.status, "proposed");
  assert.equal(row.proposalSummary.markdownPercent, 40); // respected, not eased
});

test("close the learn loop: default stays 30 with no decline signal", async () => {
  let row = null;
  const prisma = mockPrisma({
    variants: [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }],
    inventory: [{ variantId: "v1", available: 10 }],
    soldLineItems: [],
    onCreate: (data) => { row = data; },
  });
  // No merchantMemoryBelief accessor on the mock → no learnable signal.
  const res = await proposeActionFromIntent(prisma, {
    merchantId: "m1",
    shopId: "s1",
    intent: { actionType: "price_markdown", targetKind: "dead_stock" },
  });
  assert.equal(res.status, "proposed");
  assert.equal(row.proposalSummary.markdownPercent, 30);
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
  const summary = buildProposalSummary(proposal, preview, 30);
  assert.equal(summary.variantCount, 2);
  assert.equal(summary.windowDays, 90);
  assert.equal(summary.markdownPercent, 30); // the knob the merchant edits
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
      markdownPercent: 30,
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
  assert.equal(sa.markdownPercent, 30); // the edit control's reference value
});

test("getActiveSuggestedAction returns null when nothing is proposed", async () => {
  const prisma = { actionExecution: { findFirst: async () => null } };
  assert.equal(await getActiveSuggestedAction(prisma, { merchantId: "m1", shopId: "s1" }), null);
});

test("getActiveSuggestedAction degrades gracefully on a legacy row with no proposalSummary", async () => {
  delete process.env.CLEARANCE_EXECUTE_ENABLED;
  const prisma = {
    actionExecution: {
      findFirst: async () => ({
        runId: "run-legacy",
        actionType: "price_markdown",
        resolvedMode: "approve",
        proposalSummary: null, // a row proposed before the summary was persisted
        preview: { variantCount: 2 },
      }),
    },
    actionAutonomyPolicy: { findUnique: async () => null }, // → default mode
  };
  const sa = await getActiveSuggestedAction(prisma, { merchantId: "m1", shopId: "s1", currency: "GBP" });
  assert.ok(sa, "still renders a card from the preview variant count — no crash");
  assert.equal(sa.actionRunId, "run-legacy");
  assert.match(sa.headline, /2 products/);
  // Money is unknown without a summary → the em-dash placeholder, not a wrong number.
  assert.equal(sa.keyNumbers.find((n) => n.label === "Trapped capital").value, "—");
  assert.deepEqual(sa.topItems, []); // no per-item detail without a summary
  assert.equal(sa.mode, "approve_execute"); // default dial
});

test("getExecutedActionFeed returns the 'what Jefe did' history with formatted outcomes", async () => {
  const prisma = {
    actionExecution: {
      findMany: async () => [
        {
          runId: "run-a",
          actionType: "price_markdown",
          status: "applied",
          appliedAt: new Date("2026-07-10T00:00:00.000Z"),
          revertedAt: null,
          preview: { variantCount: 12 },
          proposalSummary: { variantCount: 12, markdownPercent: 30 },
          outcome: { variantsCleared: 12, variantsSold: 9, unitsMoved: 20, revenueRecovered: 810, effectivenessRatePercent: 75 },
          outcomeStatus: "measured",
        },
        {
          runId: "run-b",
          actionType: "price_markdown",
          status: "applied",
          appliedAt: new Date("2026-07-11T00:00:00.000Z"),
          revertedAt: null,
          preview: { variantCount: 3 },
          proposalSummary: { variantCount: 3, markdownPercent: 20 },
          outcome: null,
          outcomeStatus: "pending",
        },
      ],
    },
  };
  const feed = await getExecutedActionFeed(prisma, { merchantId: "m1", shopId: "s1", currency: "GBP" });
  assert.equal(feed.length, 2);
  // Measured entry: short applied-change headline + formatted outcome.
  assert.equal(feed[0].actionRunId, "run-a");
  assert.equal(feed[0].actionType, "price_markdown");
  assert.equal(feed[0].headline, "Marked 12 products down for clearance (−30%)");
  assert.equal(feed[0].appliedAt, "2026-07-10T00:00:00.000Z");
  assert.equal(feed[0].outcome.measured, true);
  assert.equal(feed[0].outcome.revenueRecovered, "£810");
  assert.equal(feed[0].outcome.unitsMoved, 20);
  assert.match(feed[0].outcome.summary, /9 of 12 cleared products sold/);
  // Applied but not yet scored → outcome.measured false (surface shows "tracking…").
  assert.equal(feed[1].outcome.measured, false);
});

function scopeNudgePrisma({ scope, sold = [] }) {
  return {
    variant: { findMany: async () => [{ id: "v1", productId: "p1", price: 200, unitCost: 80, product: { title: "Parka" } }] },
    inventoryLevel: { findMany: async () => [{ variantId: "v1", available: 10 }] },
    orderLineItem: { findMany: async () => sold },
    shop: { findUnique: async () => ({ shopDomain: "s.myshopify.com" }) },
    session: { findFirst: async () => ({ scope }) },
  };
}

test("getScopeGatedOpportunity: valuable clearance + missing write scope → value-first nudge", async () => {
  const nudge = await getScopeGatedOpportunity(scopeNudgePrisma({ scope: "read_products,read_orders" }), {
    merchantId: "m1",
    shopId: "s1",
    currency: "GBP",
  });
  assert.ok(nudge, "returns a nudge when real value is gated on a missing scope");
  assert.deepEqual(nudge.missingScopes, ["write_products"]);
  assert.equal(nudge.actionType, "price_markdown");
  assert.equal(nudge.productCount, 1);
  assert.equal(nudge.trappedCapital, "£800"); // 10 units × £80 cost
  assert.match(nudge.headline, /£800 tied up in 1 product/);
  assert.match(nudge.headline, /grant "Edit products"/);
});

test("getScopeGatedOpportunity: scope already granted → null (nothing to nudge)", async () => {
  const nudge = await getScopeGatedOpportunity(scopeNudgePrisma({ scope: "read_products,write_products" }), {
    merchantId: "m1",
    shopId: "s1",
  });
  assert.equal(nudge, null);
});

test("getScopeGatedOpportunity: no opportunity → null even if scope is missing", async () => {
  // Sold in window → not dead stock → no proposable action → no nudge.
  const nudge = await getScopeGatedOpportunity(scopeNudgePrisma({ scope: "read_products", sold: [{ variantId: "v1" }] }), {
    merchantId: "m1",
    shopId: "s1",
  });
  assert.equal(nudge, null);
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
  assert.equal(created.proposalSummary.markdownPercent, 50); // revised knob persisted on the new row
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
