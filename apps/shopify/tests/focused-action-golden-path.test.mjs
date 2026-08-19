/**
 * Replenishment golden path — one continuous conversation over one action.
 *
 * Fixture arithmetic (checkable by hand): 0 on hand, 0.1 units/day.
 *   120-day cover → 12 units · 90 → 9 · 60 → 6.
 *
 * The model's decision for each turn is scripted; what is under test is
 * everything after it — that the work runs, that downstream results rebuild
 * themselves when inputs change, and that the answer states what happened.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { recommendedPurchaseUnits } from "../app/lib/actions/action-capability.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";
import { MERCHANT, SHOP, buildActionFixture, quietLogger } from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider, scriptedProvider } from "./helpers/scripted-agent.mjs";

const unitsFor = (coverDays) =>
  recommendedPurchaseUnits({ available: 0, dailyVelocity: 0.1 }, coverDays);

function turn(prisma, message, toolCalls, finalReply = "Done.") {
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

test("fixture arithmetic is deterministic", () => {
  assert.equal(unitsFor(120), 12);
  assert.equal(unitsFor(90), 9);
  assert.equal(unitsFor(60), 6);
});

test("golden path: eight turns on one replenishment action", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  /* -- Turn 1 — three intentions, one message ----------------------------- */
  const t1 = await turn(
    prisma,
    "120 days feels like too much. Only replenish Picnic Xinomavro, use 90 days instead, and show me the proposal.",
    [
      { tool: "restrict_to_products", arguments: { productTitle: "Picnic Xinomavro" } },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "build_replenishment_proposal", arguments: {} },
    ],
  );

  assert.equal(t1.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  const s1 = await state(prisma);
  assert.deepEqual(
    s1.scope.items.map((item) => item.title),
    ["Picnic Xinomavro"],
  );
  assert.equal(s1.scope.items[0].recommendedUnits, 9);
  assert.deepEqual(
    s1.scope.excluded.map((item) => item.title),
    ["Pear Skin Sipon"],
  );

  // The answer communicates all three facts and is not a bare acknowledgement.
  assert.notEqual(t1.reply.trim(), "Done.");
  assert.match(t1.reply, /Pear Skin Sipon/);
  assert.match(t1.reply, /90/);
  assert.match(t1.reply, /Picnic Xinomavro/);
  assert.match(t1.reply, /\b9\b/);

  /* -- Turn 2 — "Why 9?" answered from live state ------------------------- */
  const t2 = await turn(prisma, "Why 9?", [{ tool: "inspect_current_proposal", arguments: {} }], null);
  assert.equal(t2.outcome, TURN_OUTCOME.noAction, "reading is not doing");
  assert.match(t2.reply, /\b9\b/);
  assert.match(t2.reply, /90/);
  assert.doesNotMatch(t2.reply, /^Done/i);

  /* -- Turn 3 — hypothetical must not mutate ------------------------------ */
  const t3 = await turn(
    prisma,
    "What would 60 days look like? Don't change it yet.",
    [{ tool: "simulate_plan", arguments: { coverDays: 60 } }],
    null,
  );
  assert.match(t3.reply, /\b6\b/);
  assert.equal(prisma.state.action.plan.coverDays, 90, "simulation must not persist");
  assert.equal(t3.outcome, TURN_OUTCOME.noAction);

  /* -- Turn 4 — what is actually saved ------------------------------------ */
  const t4 = await turn(
    prisma,
    "What cover are we actually using?",
    [{ tool: "get_action_state", arguments: {} }],
    "You're on a 90-day cover target.",
  );
  assert.match(t4.reply, /90/);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  /* -- Turn 5 — revise, then a downstream outcome, in one message --------- */
  const proposalStepBefore = stepByTitle(prisma, "proposal");
  assert.equal(proposalStepBefore.status, "completed");

  const t5 = await turn(
    prisma,
    "Yeah, use 60 and draft the supplier email.",
    [
      { tool: "update_plan", arguments: { coverDays: 60 } },
      { tool: "draft_supplier_email", arguments: {} },
    ],
  );

  assert.equal(prisma.state.action.plan.coverDays, 60);
  assert.equal(t5.outcome, TURN_OUTCOME.success);

  const s5 = await state(prisma);
  assert.equal(s5.scope.items[0].recommendedUnits, 6);

  // The proposal was stale after the plan change and rebuilt itself — the
  // merchant never navigated back to it.
  const draftStep = stepByTitle(prisma, "supplier");
  assert.equal(draftStep.status, "completed");
  assert.equal(draftStep.progress.artifactType, "supplier_email_draft");
  const draftBody = JSON.stringify(draftStep.progress);
  assert.match(draftBody, /Picnic Xinomavro/);
  assert.match(draftBody, /\b6\b/);
  assert.doesNotMatch(draftBody, /Pear Skin Sipon/);

  /* -- Turn 6 — put Pear back; everything downstream rebuilds ------------- */
  const t6 = await turn(
    prisma,
    "Actually put Pear back in and redo it.",
    [
      { tool: "include_product_again", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "draft_supplier_email", arguments: {} },
    ],
  );

  assert.equal(t6.outcome, TURN_OUTCOME.success);
  const s6 = await state(prisma);
  assert.deepEqual(
    s6.scope.items.map((item) => `${item.title}:${item.recommendedUnits}`).sort(),
    ["Pear Skin Sipon:6", "Picnic Xinomavro:6"],
  );
  const redraft = JSON.stringify(stepByTitle(prisma, "supplier").progress);
  assert.match(redraft, /Pear Skin Sipon/);
  assert.match(redraft, /Picnic Xinomavro/);

  /* -- Turn 7 — history comes from structured revisions -------------------- */
  const t7 = await turn(
    prisma,
    "What changed from the original?",
    [{ tool: "inspect_history", arguments: {} }],
    null,
  );
  assert.match(t7.reply, /90/);
  assert.match(t7.reply, /60/);
  assert.match(t7.reply, /Picnic Xinomavro/);

  /* -- Turn 8 — negation is respected ------------------------------------- */
  const draftsBefore = prisma.state.stepRuns.filter(
    (row) => row.stepId === stepByTitle(prisma, "supplier").id,
  ).length;

  const t8 = await turn(
    prisma,
    "Don't draft anything else. Go back to 90 days and leave Pear out again, then show me the proposal.",
    [
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "exclude_product", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
  );

  assert.equal(prisma.state.action.plan.coverDays, 90);
  const s8 = await state(prisma);
  assert.deepEqual(
    s8.scope.items.map((item) => `${item.title}:${item.recommendedUnits}`),
    ["Picnic Xinomavro:9"],
  );
  assert.match(t8.reply, /Picnic Xinomavro/);
  assert.match(t8.reply, /\b9\b/);

  const draftsAfter = prisma.state.stepRuns.filter(
    (row) => row.stepId === stepByTitle(prisma, "supplier").id,
  ).length;
  assert.equal(draftsAfter, draftsBefore, "no supplier email should have been generated");
});

test("full regression conversation: proposal → simulate → email → history → proposal only", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const supplierStep = stepByTitle(prisma, "supplier");
  const supplierRuns = () =>
    prisma.state.stepRuns.filter((row) => row.stepId === supplierStep.id).length;

  /* -- Turn 1: proposal only (merchant did NOT ask for email) ------------ */
  const t1 = await turn(
    prisma,
    "Only replenish Picnic Xinomavro, use 90 days instead of 120, and show me the proposal.",
    [
      { tool: "restrict_to_products", arguments: { productTitle: "Picnic Xinomavro" } },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "build_replenishment_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(t1.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  const s1 = await state(prisma);
  assert.deepEqual(
    s1.scope.items.map((item) => item.title),
    ["Picnic Xinomavro"],
  );
  assert.equal(s1.scope.items[0].recommendedUnits, unitsFor(90));
  assert.equal(s1.scope.excluded[0].title, "Pear Skin Sipon");
  assert.equal(supplierRuns(), 0, "no supplier email should be generated yet");
  assert.doesNotMatch(String(t1.reply), /Hi,|Could we please place|Please confirm lead time/i);

  /* -- Turn 2: hypothetical must not persist --------------------------- */
  const t2 = await turn(
    prisma,
    "What would 60 days look like? Don't change it.",
    [{ tool: "simulate_plan", arguments: { coverDays: 60 } }],
    null,
  );

  assert.match(t2.reply, /\b6\b/);
  assert.equal(prisma.state.action.plan.coverDays, 90, "simulation must not persist");
  assert.equal(supplierRuns(), 0, "still no email yet");

  /* -- Turn 3: persist + draft email (explicit request) ---------------- */
  const t3 = await turn(
    prisma,
    "Use 60 and draft the supplier email.",
    [
      { tool: "update_plan", arguments: { coverDays: 60 } },
      { tool: "draft_supplier_email", arguments: {} },
    ],
  );

  assert.equal(t3.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 60);
  assert.equal(supplierRuns(), 1);

  const supplierAfterT3 = stepByTitle(prisma, "supplier");
  const draftBody3 = JSON.stringify(supplierAfterT3.progress);
  assert.match(draftBody3, /Picnic Xinomavro/);
  assert.match(draftBody3, /\b6\b/);
  assert.doesNotMatch(draftBody3, /Pear Skin Sipon/);

  /* -- Turn 4: put Pear back and redo proposal + email ---------------- */
  const t4 = await turn(
    prisma,
    "Put Pear back in and redo the proposal and email.",
    [
      { tool: "include_product_again", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "draft_supplier_email", arguments: {} },
    ],
  );

  assert.equal(t4.outcome, TURN_OUTCOME.success);
  const s4 = await state(prisma);
  assert.deepEqual(
    s4.scope.items.map((item) => `${item.title}:${item.recommendedUnits}`).sort(),
    ["Pear Skin Sipon:6", "Picnic Xinomavro:6"],
  );
  const draftBody4 = JSON.stringify(stepByTitle(prisma, "supplier").progress);
  assert.match(draftBody4, /Pear Skin Sipon/);
  assert.match(draftBody4, /Picnic Xinomavro/);

  /* -- Turn 5: what should I do next? (no generic fallback) ---------- */
  const t5 = await turn(prisma, "What should I do next?", [], null);
  assert.doesNotMatch(t5.reply, /I haven't changed anything/i);
  assert.match(t5.reply, /send|supplier/i);

  /* -- Turn 6: coherent, grounded history ------------------------------ */
  const t6 = await turn(
    prisma,
    "What changed from the original?",
    [{ tool: "inspect_history", arguments: {} }],
    null,
  );
  assert.match(t6.reply, /120/);
  assert.match(t6.reply, /90/);
  assert.match(t6.reply, /60/);
  assert.match(t6.reply, /Pear Skin Sipon/);
  assert.match(t6.reply, /Picnic Xinomavro/);

  /* -- Turn 7: proposal-only again; no email, even if model asks ---- */
  const draftsBeforeT7 = supplierRuns();
  const t7 = await turn(
    prisma,
    "Go back to 90 days, remove Pear, update the proposal, but don't draft another email.",
    [
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "exclude_product", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "build_replenishment_proposal", arguments: {} },
    ],
    null,
  );

  const s7 = await state(prisma);
  assert.equal(s7.plan.coverDays ?? prisma.state.action.plan.coverDays, 90);
  assert.deepEqual(
    s7.scope.items.map((item) => `${item.title}:${item.recommendedUnits}`),
    ["Picnic Xinomavro:9"],
  );
  assert.equal(supplierRuns(), draftsBeforeT7, "no new supplier email should be generated");
  assert.doesNotMatch(t7.reply, /Hi,|Could we please place|Please confirm lead time/i);

  const supplierArtifacts7 = (await state(prisma)).artifacts.filter(
    (a) => String(a?.artifactType ?? "") === "supplier_email_draft",
  );
  assert.ok(
    supplierArtifacts7.length > 0 && supplierArtifacts7.some((a) => a.current === false),
    "supplier email artifact must be marked stale (not current) after proposal scope changes",
  );
});

test("a downstream outcome runs its own prerequisites from a cold start", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Nothing has run. The merchant asks for the last artifact in the chain.
  const result = await turn(prisma, "Just give me the supplier email.", [
    { tool: "draft_supplier_email", arguments: {} },
  ]);

  assert.equal(result.outcome, TURN_OUTCOME.success);
  for (const title of ["inventory", "proposal", "supplier"]) {
    assert.equal(
      stepByTitle(prisma, title).status,
      "completed",
      `${title} step should have run`,
    );
  }
  assert.doesNotMatch(result.reply, /step \d|hasn't started|start step/i);
});

test("completed prerequisites never leave a dependent stuck waiting", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  await turn(prisma, "Build the proposal.", [
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);

  const projected = await state(prisma);
  const rows = Object.fromEntries(projected.work.map((row) => [row.step.title, row.state]));
  assert.equal(rows["Review low-cover inventory"], "complete");
  assert.equal(rows["Build replenishment proposal"], "complete");
  assert.equal(
    rows["Draft supplier communication"],
    "available",
    "its prerequisite is complete, so it is available — not blocked",
  );
});

test("the proposal is inspectable before any step has ever run", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await turn(
    prisma,
    "What's the proposal?",
    [{ tool: "inspect_current_proposal", arguments: {} }],
    null,
  );
  assert.match(result.reply, /Pear Skin Sipon/);
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /12/);
  assert.equal(prisma.state.stepRuns.length, 0, "inspecting must not run work");
});

test("a store-wide question hands back to general chat without losing focus", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await handleFocusedActionMessage(prisma, {
    message: "How many products do I sell overall?",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: scriptedProvider([{ done: true, routing: "general_store", toolCalls: [] }]),
    logger: quietLogger,
  });
  assert.equal(result.routing, "general_store");
  assert.equal(result.reply, "");
});
