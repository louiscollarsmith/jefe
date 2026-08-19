/**
 * The success contract.
 *
 * These are the regressions that mattered: Jefe answering "Done." having done
 * nothing, and Jefe answering "Done." having planned everything but executed
 * nothing. Both are architecture bugs, not prompt bugs, so both are pinned
 * here against the real runtime.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { runFocusedActionAgent } from "../app/lib/actions/agent/agent-loop.server.js";
import {
  TURN_OUTCOME,
  classifyTurn,
  composeGroundedReply,
  isBareSuccess,
} from "../app/lib/actions/agent/turn-outcome.server.js";
import { TOOL_EFFECT } from "../app/lib/actions/agent/tool-registry.server.js";
import {
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
} from "./helpers/action-fixture.mjs";
import {
  eagerlyDoneProvider,
  emptySuccessProvider,
  scriptedProvider,
} from "./helpers/scripted-agent.mjs";

const REPRO =
  "120 days feels like too much. Only replenish Picnic Xinomavro, use 90 days instead, and show me the proposal.";

function run(prisma, message, provider) {
  return handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider,
    logger: quietLogger,
  });
}

/* -------------------------------------------------------------------------- */
/* Ledger classification                                                       */
/* -------------------------------------------------------------------------- */

function toolResult(overrides) {
  return {
    tool: "t",
    ok: true,
    effect: TOOL_EFFECT.read,
    message: "",
    facts: {},
    changes: [],
    artifact: null,
    error: null,
    blocked: null,
    ...overrides,
  };
}

test("an empty ledger is NO_ACTION, never SUCCESS", () => {
  assert.equal(classifyTurn([]), TURN_OUTCOME.noAction);
});

test("reads alone are NO_ACTION — reading is not doing", () => {
  assert.equal(classifyTurn([toolResult({ effect: TOOL_EFFECT.read })]), TURN_OUTCOME.noAction);
});

test("a successful state change is SUCCESS", () => {
  assert.equal(
    classifyTurn([toolResult({ effect: TOOL_EFFECT.stateChange, changes: [{ field: "coverDays", to: 90 }] })]),
    TURN_OUTCOME.success,
  );
});

test("success alongside a failure is PARTIAL_SUCCESS", () => {
  assert.equal(
    classifyTurn([
      toolResult({ effect: TOOL_EFFECT.stateChange, changes: [{ field: "coverDays", to: 90 }] }),
      toolResult({ ok: false, effect: TOOL_EFFECT.artifact, error: { code: "X", message: "no" } }),
    ]),
    TURN_OUTCOME.partialSuccess,
  );
});

test("only failures is FAILED", () => {
  assert.equal(
    classifyTurn([toolResult({ ok: false, effect: TOOL_EFFECT.stateChange, error: { code: "X", message: "no" } })]),
    TURN_OUTCOME.failed,
  );
});

/* -------------------------------------------------------------------------- */
/* Response grounding                                                          */
/* -------------------------------------------------------------------------- */

test('bare "Done." is recognised as an empty success response', () => {
  for (const text of ["Done.", "done", "Updated!", "All set —", "Completed."]) {
    assert.equal(isBareSuccess(text), true, text);
  }
  assert.equal(isBareSuccess("Done — Pear Skin Sipon is excluded."), false);
});

test('a NO_ACTION turn cannot ship "Done."', () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.noAction,
    ledger: [],
    modelReply: "Done.",
  });
  assert.doesNotMatch(composed.reply, /^Done\.$/);
  assert.match(composed.reply, /haven't changed anything/i);
  assert.equal(composed.usedModelProse, false);
});

test("a NO_ACTION turn cannot ship a success claim either", () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.noAction,
    ledger: [],
    modelReply: "I've updated the cover to 90 days.",
  });
  assert.doesNotMatch(composed.reply, /90 days/);
});

test("a SUCCESS turn whose prose omits the number it claims falls back to the ledger wording", () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.success,
    ledger: [
      toolResult({
        effect: TOOL_EFFECT.stateChange,
        changes: [{ field: "coverDays", from: 120, to: 90 }],
      }),
    ],
    modelReply: "Done.",
  });
  assert.equal(composed.usedModelProse, false);
  assert.match(composed.reply, /90 days/);
});

test("a SUCCESS turn keeps model prose that actually states the change", () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.success,
    ledger: [
      toolResult({
        effect: TOOL_EFFECT.stateChange,
        changes: [{ field: "coverDays", from: 120, to: 90 }],
      }),
    ],
    modelReply: "I've moved the cover target to 90 days.",
  });
  assert.equal(composed.usedModelProse, true);
  assert.match(composed.reply, /90 days/);
});

test("prose cannot claim a Shopify write the ledger does not contain", () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.success,
    ledger: [
      toolResult({
        effect: TOOL_EFFECT.stateChange,
        changes: [{ field: "markdownPercent", from: 25, to: 20 }],
      }),
    ],
    modelReply: "Set to 20% and applied the changes to Shopify.",
  });
  assert.equal(composed.usedModelProse, false);
  assert.doesNotMatch(composed.reply, /shopify/i);
});

test("partial success reports both halves and never pretends the failure succeeded", () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.partialSuccess,
    ledger: [
      toolResult({
        effect: TOOL_EFFECT.stateChange,
        changes: [{ field: "coverDays", from: 120, to: 90 }],
      }),
      toolResult({
        ok: false,
        effect: TOOL_EFFECT.artifact,
        blocked: { code: "MERCHANT_INPUT_REQUIRED", message: "I still need supplier costs." },
      }),
    ],
    modelReply: null,
  });
  assert.match(composed.reply, /90 days/);
  assert.match(composed.reply, /supplier costs/i);
});

test("failure reports the actual reason", () => {
  const composed = composeGroundedReply({
    outcome: TURN_OUTCOME.failed,
    ledger: [
      toolResult({
        ok: false,
        effect: TOOL_EFFECT.stateChange,
        error: { code: "INVALID", message: "That parameter doesn't apply to this action." },
      }),
    ],
    modelReply: "Done.",
  });
  assert.doesNotMatch(composed.reply, /^Done\.$/);
  assert.match(composed.reply, /couldn't/i);
  assert.match(composed.reply, /doesn't apply/i);
});

/* -------------------------------------------------------------------------- */
/* The reproduction, end to end                                                */
/* -------------------------------------------------------------------------- */

test('a model that plans work and says "done" in the same turn still gets the work done', async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const provider = eagerlyDoneProvider([
    { tool: "restrict_to_products", arguments: { productTitle: "Picnic Xinomavro" } },
    { tool: "update_plan", arguments: { coverDays: 90 } },
    { tool: "build_replenishment_proposal", arguments: {} },
  ]);

  const result = await run(prisma, REPRO, provider);

  // The work happened.
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.equal(
    prisma.state.constraints.some((row) => /Pear Skin Sipon/i.test(row.label)),
    true,
    "Pear should be excluded",
  );

  // And the answer says so, with the numbers.
  assert.notEqual(result.reply.trim(), "Done.");
  assert.match(result.reply, /Pear Skin Sipon/);
  assert.match(result.reply, /90/);
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /\b9\b/);
  assert.equal(result.outcome, TURN_OUTCOME.success);
});

test("a model that claims success having called nothing gets an honest answer instead", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await run(prisma, REPRO, emptySuccessProvider("Done."));

  assert.equal(result.outcome, TURN_OUTCOME.noAction);
  assert.notEqual(result.reply.trim(), "Done.");
  assert.match(result.reply, /haven't changed anything/i);
  assert.equal(prisma.state.action.plan.coverDays, 120, "nothing should have been persisted");
});

test("a tool rejection is shown to the model rather than silently swallowed", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  /** @type {any[]} */
  const seen = [];
  const provider = scriptedProvider((payload) => {
    seen.push(payload.toolResultsThisTurn ?? []);
    if (seen.length === 1) {
      // markdownPercent is not a replenishment plan field.
      return { done: false, toolCalls: [{ tool: "update_plan", arguments: { markdownPercent: 0 } }] };
    }
    return { done: true, finalReply: null, toolCalls: [] };
  });

  const result = await run(prisma, "Set the markdown to 0%.", provider);

  const rejection = seen[1]?.[0];
  assert.ok(rejection, "the model should see the rejected call");
  assert.equal(rejection.ok, false);
  assert.match(rejection.message, /markdownPercent|does not apply|coverDays/i);
  assert.equal(prisma.state.action.plan.markdownPercent, undefined);
  assert.equal(result.outcome, TURN_OUTCOME.failed);
  assert.doesNotMatch(result.reply, /^Done/i);
});

test("tools the action type does not have are refused and reported", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const provider = scriptedProvider([
    { done: false, toolCalls: [{ tool: "apply_change_set", arguments: {} }] },
    { done: true, finalReply: null, toolCalls: [] },
  ]);

  const result = await run(prisma, "Apply it to Shopify.", provider);
  assert.equal(result.outcome, TURN_OUTCOME.failed);
  assert.match(result.reply, /not available|couldn't/i);
});

test("the agent trace records why the turn answered what it did", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await runFocusedActionAgent(prisma, {
    message: REPRO,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: eagerlyDoneProvider([{ tool: "update_plan", arguments: { coverDays: 90 } }]),
    logger: quietLogger,
  });

  const trace = result.trace;
  assert.ok(trace);
  assert.equal(trace.message, REPRO);
  assert.equal(trace.outcome, TURN_OUTCOME.success);
  assert.equal(trace.stateBefore.coverDays, 120);
  assert.equal(trace.stateAfter.coverDays, 90);
  assert.deepEqual(
    trace.ledger.map((row) => row.tool),
    ["update_plan"],
  );
  assert.equal(trace.modelReply, "Done.");
  assert.notEqual(trace.finalReply, "Done.");
  assert.ok(trace.toolSchemaVersion);
  assert.ok(trace.agentVersion);
});
