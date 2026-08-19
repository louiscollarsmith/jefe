/**
 * Execute golden path — the intelligence layer must not weaken write safety.
 *
 * The typed adapter and approval policy have their own tests. What is proved
 * here is that the agent sitting in front of them cannot: apply without an
 * explicit instruction, apply in the same breath as changing the plan, or
 * describe a Shopify write that did not happen.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";
import { toolNamesForKind } from "../app/lib/actions/agent/tool-registry.server.js";
import { MERCHANT, SHOP, buildActionFixture, quietLogger } from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider } from "./helpers/scripted-agent.mjs";

function turn(prisma, message, toolCalls, extra = {}) {
  return handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: eagerlyDoneProvider(toolCalls, extra.finalReply ?? "Done."),
    logger: quietLogger,
    ...extra,
  });
}

test("a replenishment action is never even offered the Shopify write tool", () => {
  const restock = toolNamesForKind("restock");
  assert.equal(restock.includes("apply_change_set"), false);
  assert.equal(restock.includes("build_change_set"), false);
  assert.equal(restock.includes("build_replenishment_proposal"), true);

  const markdown = toolNamesForKind("markdown");
  assert.equal(markdown.includes("apply_change_set"), true);
  assert.equal(markdown.includes("draft_supplier_email"), false);
});

test("constraint + revision + preview in one message, with nothing written", async () => {
  const prisma = buildActionFixture({ kind: "markdown" });

  const result = await turn(
    prisma,
    "Don't touch C. 25% is too much; use 20%, and show me exactly what would change without touching Shopify yet.",
    [
      { tool: "exclude_product", arguments: { productTitle: "Product C" } },
      { tool: "update_plan", arguments: { markdownPercent: 20 } },
      { tool: "build_change_set", arguments: {} },
    ],
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.markdownPercent, 20);

  const state = await resolveActionState(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
  });
  const titles = state.scope.items.map((item) => item.title);
  assert.equal(titles.includes("Product C"), false);
  assert.equal(titles.includes("Product B"), true);

  // A change set exists for review, and none of them has been applied.
  assert.ok(prisma.state.changeSets.length > 0);
  assert.equal(
    prisma.state.changeSets.some((row) => ["applied", "applying", "partial"].includes(row.status)),
    false,
    "nothing may be written to Shopify on a preview turn",
  );
  assert.match(result.reply, /20/);
});

test("apply is refused in the same turn that changed the plan", async () => {
  const prisma = buildActionFixture({ kind: "markdown" });

  const result = await turn(prisma, "Use 20% and apply it.", [
    { tool: "update_plan", arguments: { markdownPercent: 20 } },
    { tool: "apply_change_set", arguments: {} },
  ]);

  const applyRow = result.ledger.find((row) => row.tool === "apply_change_set");
  assert.equal(applyRow.ok, false);
  assert.equal(applyRow.error.code, "APPROVAL_REQUIRED_AFTER_CHANGE");
  assert.equal(
    prisma.state.changeSets.some((row) => row.status === "applied"),
    false,
  );
  assert.equal(result.outcome, TURN_OUTCOME.partialSuccess);
  assert.match(result.reply, /20/);
  assert.match(result.reply, /apply/i);
});

test("an apply that does not execute is reported as a failure, never as success", async () => {
  const prisma = buildActionFixture({ kind: "markdown" });

  await turn(prisma, "Show me what would change.", [{ tool: "build_change_set", arguments: {} }]);

  // No execution is wired for this action, so the write cannot happen.
  const result = await turn(prisma, "Looks good, apply those.", [
    { tool: "apply_change_set", arguments: {} },
  ]);

  assert.equal(result.outcome, TURN_OUTCOME.failed);
  assert.match(result.reply, /couldn't/i);
  assert.doesNotMatch(result.reply, /^Done/i);
  assert.equal(
    prisma.state.changeSets.some((row) => row.status === "applied"),
    false,
  );
});

test("an explicit apply targets the current change set, not an earlier one", async () => {
  const prisma = buildActionFixture({ kind: "markdown" });

  await turn(prisma, "Show me what would change.", [{ tool: "build_change_set", arguments: {} }]);
  const first = prisma.state.changeSets.at(-1);

  await turn(prisma, "Use 20%.", [{ tool: "update_plan", arguments: { markdownPercent: 20 } }]);
  const current = prisma.state.changeSets.at(-1);

  assert.notEqual(current.id, first.id, "revising the plan supersedes the old change set");
  assert.equal(first.status, "stale");

  await turn(prisma, "Apply those.", [{ tool: "apply_change_set", arguments: {} }]);

  // The stale one is never the target of an apply, whatever happens downstream.
  assert.equal(first.status, "stale");
});
