/**
 * Regression coverage for the Basalt Tide Arinto bug: a merchant explicitly
 * rejecting/deferring a proposed Action in focused chat must produce a real
 * durable state transition, never just model prose that narrates one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runFocusedActionAgent } from "../app/lib/actions/agent/agent-loop.server.js";
import { toolNamesForKind } from "../app/lib/actions/agent/tool-registry.server.js";
import {
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
} from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider, emptySuccessProvider } from "./helpers/scripted-agent.mjs";

test("reject_action and defer_action are available on every action kind", () => {
  for (const kind of ["restock", "markdown", "listing_copy", "generic"]) {
    const names = toolNamesForKind(kind);
    assert.ok(names.includes("reject_action"), `reject_action missing for ${kind}`);
    assert.ok(names.includes("defer_action"), `defer_action missing for ${kind}`);
  }
});

test("a standalone rejection calls reject_action and durably takes the action off Proposed", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  assert.equal(prisma.state.action.status, "proposed");

  const provider = eagerlyDoneProvider(
    [{ tool: "reject_action", arguments: {} }],
    "I've rejected this. Nothing was written to your store.",
  );

  const result = await runFocusedActionAgent(prisma, {
    message: "Don't do this. Cancel this, I never want to do it.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.ledger.some((row) => row.tool === "reject_action" && row.ok),
    true,
  );
  // Durable state actually moved — this is not free-text narration.
  assert.notEqual(prisma.state.action.status, "proposed");
  assert.equal(
    prisma.state.events.some((event) => event.eventType === "action_rejected"),
    true,
  );
  // No Shopify write of any kind for a reject.
  assert.equal(prisma.state.changeSets.length, 0);
});

test("holding for later calls defer_action, not reject_action", async () => {
  const prisma = buildActionFixture({ kind: "markdown" });
  const provider = eagerlyDoneProvider(
    [{ tool: "defer_action", arguments: {} }],
    "I'll leave this for later. Nothing was written to your store.",
  );

  const result = await runFocusedActionAgent(prisma, {
    message: "Not now, maybe later.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.ledger.some((row) => row.tool === "defer_action" && row.ok),
    true,
  );
  assert.equal(
    prisma.state.events.some((event) => event.eventType === "action_deferred"),
    true,
  );
  assert.equal(
    prisma.state.events.some((event) => event.eventType === "action_rejected"),
    false,
  );
});

test("a bare 'Cancelled.' claim with no tool call is not shipped to the merchant", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const provider = emptySuccessProvider("Cancelled.");

  const result = await runFocusedActionAgent(prisma, {
    message: "Can we cancel this, I never want to do it?",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider,
    logger: quietLogger,
  });

  // The exact regression: no tool ran, so the ledger cannot support the claim,
  // and the reply must not repeat it verbatim.
  assert.equal(result.ledger.length, 0);
  assert.notEqual(result.reply.trim(), "Cancelled.");
  assert.equal(prisma.state.action.status, "proposed");
});
