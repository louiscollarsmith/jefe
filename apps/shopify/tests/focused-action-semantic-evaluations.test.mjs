/**
 * Semantic/tool-plan evaluation suite for focused actions.
 *
 * Important: these tests are runtime-focused. The scripted provider supplies
 * the model's intended tool plan; we assert that application execution and
 * state transitions are correct regardless of the merchant's phrasing and
 * the turn ordering.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { recommendedPurchaseUnits } from "../app/lib/actions/action-capability.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";

import {
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
} from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider } from "./helpers/scripted-agent.mjs";

const unitsFor = (coverDays) =>
  recommendedPurchaseUnits({ available: 0, dailyVelocity: 0.1 }, coverDays);

function turn(prisma, message, toolCalls, finalReply = null) {
  return handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: eagerlyDoneProvider(toolCalls, finalReply),
    logger: quietLogger,
  });
}

function state(prisma) {
  return resolveActionState(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
  });
}

function stepByTitle(prisma, fragment) {
  return prisma.state.steps.find((row) => row.title.toLowerCase().includes(fragment));
}

function supplierRuns(prisma) {
  const supplierStep = stepByTitle(prisma, "supplier");
  return prisma.state.stepRuns.filter((row) => row.stepId === supplierStep.id).length;
}

test("scenario A - different wording: picnic only; show proposal only; no email", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(
    prisma,
    "Give me Picnic only and aim for about three months of stock. Where does that leave us?",
    [
      { tool: "restrict_to_products", arguments: { productTitle: "Picnic Xinomavro" } },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 0);

  const s = await state(prisma);
  assert.deepEqual(s.scope.items.map((item) => item.title), ["Picnic Xinomavro"]);
  assert.equal(s.scope.items[0].recommendedUnits, unitsFor(90));
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /\b9\b/);
});

test("scenario B - hypothetical: simulate 2 months; don't update anything", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(
    prisma,
    "If we only carried two months instead, what would I need to order? Just show me — don't update anything.",
    [{ tool: "simulate_plan", arguments: { coverDays: 60 } }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.noAction);
  assert.equal(prisma.state.action.plan.coverDays, 120, "simulation must not persist");
  assert.equal(supplierRuns(prisma), 0, "no supplier email should be generated");
  assert.equal(prisma.state.stepRuns.length, 0, "simulation must not run assist steps");
  assert.match(result.reply, /\b6\b/);
});

test("scenario C - adopt hypothetical: persist 60-day plan after a simulation", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  await turn(prisma, "What would 60 days look like? Just show me.", [
    { tool: "simulate_plan", arguments: { coverDays: 60 } },
  ]);

  const result = await turn(
    prisma,
    "Actually, let's go with that.",
    [
      { tool: "update_plan", arguments: { coverDays: 60 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(prisma.state.action.plan.coverDays, 60);
  const s = await state(prisma);
  const first = s.scope.items[0];
  assert.equal(first.recommendedUnits, unitsFor(60));
  assert.match(result.reply, /\b6\b/);
});

test("scenario D - desired outcome: create supplier note artifact", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(
    prisma,
    "I need something I can send to the supplier.",
    [{ tool: "draft_supplier_email", arguments: {} }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 1);

  const supplierStep = stepByTitle(prisma, "supplier");
  assert.equal(supplierStep.status, "completed");
  assert.equal(supplierStep.progress.artifactType, "supplier_email_draft");

  assert.match(result.reply, /Draft supplier communication/);
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /\b12\b/);
});

test("scenario E - backtrack: put Pear back; rebuild proposal; do NOT draft email", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  await turn(
    prisma,
    "Draft the supplier email for Picnic only at 90 days.",
    [
      { tool: "exclude_product", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "draft_supplier_email", arguments: {} },
    ],
    null,
  );

  const draftsBefore = supplierRuns(prisma);
  assert.equal(draftsBefore, 1);

  const result = await turn(
    prisma,
    "Scrap that draft for now. Put Pear back in and recalculate.",
    [
      { tool: "include_product_again", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "build_replenishment_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), draftsBefore, "no new supplier email should be generated");

  const s = await state(prisma);
  const titles = s.scope.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ["Pear Skin Sipon", "Picnic Xinomavro"].sort());
  assert.equal(s.scope.items[0].recommendedUnits, unitsFor(90));
});

test("scenario F - question + change: move from 60 back to 90 days", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Create persisted history for "why are we using 60 days" narrative.
  await turn(prisma, "Use 60 days.", [{ tool: "update_plan", arguments: { coverDays: 60 } }]);

  const result = await turn(
    prisma,
    "Why were we using 60 days? Put it back to 90 and show me the difference.",
    [
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.match(result.reply, /\b9\b/);

  // Validate that history is based on persisted revisions.
  const history = await turn(
    prisma,
    "What changed from the original?",
    [{ tool: "inspect_history", arguments: {} }],
    null,
  );
  assert.equal(history.outcome, TURN_OUTCOME.noAction);
  assert.match(history.reply, /\b60\b/);
  assert.match(history.reply, /\b90\b/);
});

test("scenario G - completely different ordering: simulate → persist → supplier note", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Turn 1: simulation only.
  await turn(
    prisma,
    "Before we do anything, what would 90 days look like for Picnic only?",
    [
      { tool: "restrict_to_products", arguments: { productTitle: "Picnic Xinomavro" } },
      { tool: "simulate_plan", arguments: { coverDays: 90 } },
    ],
    null,
  );

  assert.equal(prisma.state.action.plan.coverDays, 120, "simulation must not persist");
  assert.equal(supplierRuns(prisma), 0);

  // Turn 2: persist.
  const persisted = await turn(
    prisma,
    "Okay, make that the plan.",
    [{ tool: "update_plan", arguments: { coverDays: 90 } }],
    null,
  );
  assert.equal(persisted.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  // Turn 3: downstream artifact generation.
  const emailed = await turn(
    prisma,
    "Give me the supplier note.",
    [{ tool: "draft_supplier_email", arguments: {} }],
    null,
  );

  assert.equal(emailed.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 1);
  assert.match(emailed.reply, /Picnic Xinomavro/);
  assert.match(emailed.reply, /\b9\b/);
});

