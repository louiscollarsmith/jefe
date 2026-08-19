/**
 * Boundaries, failure and repetition.
 *
 * Three things the agent must never do, whatever the model says: invent
 * merchant evidence it does not have, claim work that failed, or do the same
 * work twice because a message arrived twice.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { runAssistStepById } from "../app/lib/actions/agent/assist-runner.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";
import {
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
  restockStepsNeedingEvidence,
} from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider, providerDown, scriptedProvider } from "./helpers/scripted-agent.mjs";

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

/* -------------------------------------------------------------------------- */
/* Merchant input is a real boundary                                           */
/* -------------------------------------------------------------------------- */

test('"just finish this" asks for the missing evidence, not for a step to be started', async () => {
  const prisma = buildActionFixture({
    kind: "restock",
    steps: restockStepsNeedingEvidence(),
  });

  const result = await turn(prisma, "Just finish this for me.", [
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);

  assert.equal(result.outcome, TURN_OUTCOME.blocked);
  assert.match(result.reply, /supplier costs|need/i);
  assert.doesNotMatch(result.reply, /step 1|hasn't started|start step/i);
  assert.doesNotMatch(result.reply, /^Done/i);

  // Nothing downstream was faked into existence.
  const state = await resolveActionState(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
  });
  const proposal = state.work.find((row) => row.step.title.includes("proposal"));
  assert.notEqual(proposal.state, "complete");
});

test("once the merchant's evidence arrives, Jefe carries on by itself", async () => {
  const prisma = buildActionFixture({
    kind: "restock",
    steps: restockStepsNeedingEvidence(),
  });

  // The merchant supplies what was missing.
  const evidenceStep = prisma.state.steps.find((row) => row.mode === "evidence_required");
  evidenceStep.status = "completed";
  evidenceStep.progress = { artifactType: "supplier_costs", summary: "Costs uploaded." };

  const result = await turn(prisma, "Right, carry on.", [
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(
    prisma.state.steps.find((row) => row.title.includes("proposal")).status,
    "completed",
  );
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

test("a failed assist run leaves the step re-runnable and is reported honestly", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  // Persisting the run's result blows up — the kind of blip that used to end
  // with a cheerful "Done." and a step stuck on `running`.
  prisma.state.faults.assistCompletionThrows = true;

  const result = await turn(prisma, "Build the proposal.", [
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);

  assert.notEqual(result.outcome, TURN_OUTCOME.success);
  assert.doesNotMatch(result.reply, /^Done/i);

  const step = prisma.state.steps.find((row) => row.title.includes("inventory"));
  assert.notEqual(step.status, "running", "a failed run must not leave the step wedged");
  assert.notEqual(step.status, "completed");
});

test("a partial chain reports what landed and what did not", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  prisma.state.faults.assistCompletionThrows = true;

  // The plan change succeeds; the assist chain cannot complete.
  const result = await handleFocusedActionMessage(prisma, {
    message: "Use 60 days and draft the supplier email.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: scriptedProvider((payload) => {
      if (payload.iteration === 0) {
        return {
          done: false,
          toolCalls: [
            { tool: "update_plan", arguments: { coverDays: 60 } },
            { tool: "draft_supplier_email", arguments: {} },
          ],
        };
      }
      return { done: true, finalReply: null, toolCalls: [] };
    }),
    logger: quietLogger,
  });

  assert.equal(result.outcome, TURN_OUTCOME.partialSuccess);
  assert.equal(prisma.state.action.plan.coverDays, 60, "the successful half stays saved");
  assert.match(result.reply, /60/);
  assert.match(result.reply, /couldn't|could not/i);
});

test("when the planner is unavailable nothing is changed and the merchant is told", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await handleFocusedActionMessage(prisma, {
    message: "Use 90 days.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: providerDown(),
    logger: quietLogger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true);
  assert.equal(prisma.state.action.plan.coverDays, 120);
  assert.match(result.reply, /try again/i);
});

/* -------------------------------------------------------------------------- */
/* Repetition and concurrency                                                  */
/* -------------------------------------------------------------------------- */

test("the same work with the same inputs never runs twice", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  await turn(prisma, "Build the proposal.", [
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);
  const afterFirst = prisma.state.stepRuns.length;

  await turn(prisma, "Build the proposal.", [
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);
  assert.equal(prisma.state.stepRuns.length, afterFirst, "no duplicate runs for identical inputs");

  // Changing an input makes it legitimately new work again.
  await turn(prisma, "Use 90 days.", [{ tool: "update_plan", arguments: { coverDays: 90 } }]);
  await turn(prisma, "Rebuild it.", [{ tool: "build_replenishment_proposal", arguments: {} }]);
  assert.ok(prisma.state.stepRuns.length > afterFirst, "new inputs are new work");
});

test("a duplicated message does not duplicate the work", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const [first, second] = await Promise.all([
    turn(prisma, "Build the proposal.", [{ tool: "build_replenishment_proposal", arguments: {} }]),
    turn(prisma, "Build the proposal.", [{ tool: "build_replenishment_proposal", arguments: {} }]),
  ]);

  const proposalRuns = prisma.state.stepRuns.filter((row) => row.stepId === "step-2");
  assert.ok(proposalRuns.length <= 1, "at most one proposal run for one set of inputs");
  assert.ok(first.reply);
  assert.ok(second.reply);
});

test("a second claim on a running step is refused rather than run twice", async () => {
  const prisma = buildActionFixture({ kind: "restock", status: "in_progress" });
  prisma.state.steps[0].status = "running";

  const result = await runAssistStepById(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    stepId: "step-1",
    logger: quietLogger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "STEP_NOT_CLAIMABLE");
});

test("the same tool call repeated inside one turn is not executed twice", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(prisma, "Use 90 days.", [
    { tool: "update_plan", arguments: { coverDays: 90 } },
    { tool: "update_plan", arguments: { coverDays: 90 } },
  ]);

  const repeats = result.ledger.filter((row) => row.tool === "update_plan");
  assert.equal(repeats.length, 2);
  assert.equal(repeats[0].ok, true);
  assert.equal(repeats[1].ok, false);
  assert.equal(repeats[1].error.code, "ALREADY_RUN");
  assert.equal(prisma.state.action.plan.coverDays, 90);
});

test("the tool loop is bounded even against a model that never stops", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  let iterations = 0;

  const result = await handleFocusedActionMessage(prisma, {
    message: "Keep going forever.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: scriptedProvider(() => {
      iterations += 1;
      return {
        done: false,
        toolCalls: [{ tool: "get_action_state", arguments: { stepId: `s${iterations}` } }],
      };
    }),
    logger: quietLogger,
  });

  assert.ok(iterations <= 8, `planner should be bounded, ran ${iterations} times`);
  assert.ok(result.reply);
});
