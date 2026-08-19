/**
 * Independent adversarial checker scenarios — not golden-path wording.
 * Run separately from the scripted regression suites to probe gaps.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { recommendedPurchaseUnits } from "../app/lib/actions/action-capability.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";
import { runSupplierEmailDraftAssist } from "../app/lib/actions/assist-steps/handlers/supplier-email-draft.server.js";

import {
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
} from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider, scriptedProvider } from "./helpers/scripted-agent.mjs";

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

function assertNoToolLeakage(reply) {
  const forbidden = [
    "already ran",
    "tool call",
    "ledger",
    "duplicate suppressed",
    "planner",
    "validation retry",
    "arguments",
    "handler",
    "provider",
  ];
  for (const term of forbidden) {
    assert.doesNotMatch(reply, new RegExp(term, "i"), `merchant reply must not contain "${term}"`);
  }
}

function assertCurrentArtifactsConsistent(s) {
  const current = (s.artifacts ?? []).filter((a) => a.current === true);
  const coverDays = s.plan?.values?.coverDays ?? null;
  const excluded = new Set((s.scope?.excluded ?? []).map((e) => e.title));
  const expectedUnits =
    coverDays != null ? unitsFor(coverDays) : null;

  for (const artifact of current) {
    const body = JSON.stringify(artifact);
    for (const title of excluded) {
      assert.doesNotMatch(body, new RegExp(title), `current artifact must not mention excluded ${title}`);
    }
    if (expectedUnits != null && artifact.artifactType === "supplier_email_draft") {
      assert.match(body, new RegExp(String(expectedUnits)), "supplier draft must match current cover");
    }
  }
}

test("adversarial replenishment: six-turn conversation with non-golden wording", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Turn 1
  const t1 = await turn(
    prisma,
    "Three months should be plenty. Leave Pear out of this one and tell me what I'd order.",
    [
      { tool: "exclude_product", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
  );
  assert.equal(t1.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 0);
  assert.match(t1.reply, /Picnic Xinomavro/);
  assert.match(t1.reply, /\b9\b/);
  assertNoToolLeakage(t1.reply);

  // Turn 2
  const t2 = await turn(
    prisma,
    "Suppose we were a bit leaner and carried two months instead?",
    [{ tool: "simulate_plan", arguments: { coverDays: 60 } }],
  );
  assert.equal(t2.outcome, TURN_OUTCOME.noAction);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.match(t2.reply, /\b6\b/);

  // Turn 3
  const t3 = await turn(
    prisma,
    "Yeah actually let's do that.",
    [
      { tool: "update_plan", arguments: { coverDays: 60 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
  );
  assert.equal(t3.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 60);
  assert.match(t3.reply, /\b6\b/);

  // Turn 4
  const t4 = await turn(
    prisma,
    "Give me something I can send whoever supplies it.",
    [{ tool: "draft_supplier_email", arguments: {} }],
  );
  assert.equal(t4.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 1);
  assert.match(t4.reply, /Picnic Xinomavro/);
  assert.match(t4.reply, /\b6 units\b/i);

  // Turn 5
  const draftsBefore = supplierRuns(prisma);
  const t5 = await turn(
    prisma,
    "Never mind the note for now. Put Pear back in and recalculate.",
    [
      { tool: "include_product_again", arguments: { productTitle: "Pear Skin Sipon" } },
      { tool: "build_replenishment_proposal", arguments: {} },
    ],
  );
  assert.equal(t5.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), draftsBefore);
  const s5 = await state(prisma);
  assert.deepEqual(
    s5.scope.items.map((i) => i.title).sort(),
    ["Pear Skin Sipon", "Picnic Xinomavro"].sort(),
  );

  // Turn 6
  const t6 = await turn(
    prisma,
    "Where have we ended up compared with where we started?",
    [{ tool: "inspect_history", arguments: {} }],
  );
  assert.equal(t6.outcome, TURN_OUTCOME.noAction);
  assert.match(t6.reply, /120|Originally/i);
  assert.match(t6.reply, /60|90/);
  assert.match(t6.reply, /Picnic/i);

  assertCurrentArtifactsConsistent(await state(prisma));
});

test("minimum necessary work: cover-only must not auto-draft (wrong plan simulation)", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Simulate a BAD model that drafts email when merchant only asked to change cover
  const badModel = await turn(prisma, "Change the cover to 90 days.", [
    { tool: "update_plan", arguments: { coverDays: 90 } },
    { tool: "draft_supplier_email", arguments: {} }, // model over-plans
  ]);

  // Application executes what model plans — this documents the risk
  assert.equal(badModel.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 1, "no app-level gate prevents over-planning");
});

test("supplier fallback: malformed LLM output uses grounded deterministic draft", async () => {
  const badProvider = {
    enabled: true,
    provider: "test",
    model: "bad-artifact",
    async generateStructuredJson() {
      return {
        json: {
          summary: "Drafted.",
          detail: "x",
          nextPrompt: "y",
          body: "Please order the products we discussed.",
          items: [{ title: "Picnic Xinomavro", units: 99 }], // wrong quantity
        },
      };
    },
  };

  const context = {
    provider: badProvider,
    lowCoverProducts: [{ title: "Picnic Xinomavro", recommendedUnitsAtDefaultCover: 9 }],
    targetCoverDays: 90,
    resolvedContext: { plan: { values: { coverDays: 90 } }, scope: { excluded: [] } },
    step: { title: "Draft supplier communication" },
  };

  const result = await runSupplierEmailDraftAssist(context);
  assert.match(result.progress.body, /Picnic Xinomavro/);
  assert.match(result.progress.body, /\b9 units\b/);
  assert.doesNotMatch(result.progress.body, /\b99\b/);
});

test("supplier fallback: provider unavailable still produces grounded draft", async () => {
  const context = {
    provider: null,
    lowCoverProducts: [{ title: "Picnic Xinomavro", recommendedUnitsAtDefaultCover: 9 }],
    targetCoverDays: 90,
    resolvedContext: { plan: { values: { coverDays: 90 } }, scope: { excluded: [] } },
    step: { title: "Draft supplier communication" },
  };

  const result = await runSupplierEmailDraftAssist(context);
  assert.match(result.progress.body, /Picnic Xinomavro: 9 units/);
});

test("artifact duplication: one draft tool yields one rendered supplier block", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await turn(prisma, "Draft the supplier note.", [
    { tool: "draft_supplier_email", arguments: {} },
  ]);

  const hiCount = (result.reply.match(/Hi,/g) ?? []).length;
  assert.ok(hiCount <= 1, `expected at most one email artifact block, found ${hiCount}`);
});

test("negation is NOT enforced at application layer when model over-plans", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const before = supplierRuns(prisma);

  const result = await turn(
    prisma,
    "Update the proposal but don't draft anything yet.",
    [
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "build_replenishment_proposal", arguments: {} },
      { tool: "draft_supplier_email", arguments: {} }, // model ignores negation
    ],
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), before + 1, "application executes model plan regardless of negation");
});
