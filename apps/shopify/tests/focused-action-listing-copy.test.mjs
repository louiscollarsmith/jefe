/**
 * Product-type focused action — discovery, proposal preview, constraints.
 *
 * Reproduces the failure where an unresolved listing_copy action answered
 * "everything is excluded or out of scope" instead of discovering scope.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { SCOPE_STATUS, emptyProposalMessage } from "../app/lib/actions/listing-copy-scope.server.js";
import {
  buildCurrentProposal,
  runTool,
} from "../app/lib/actions/agent/tool-registry.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";
import {
  LISTING_COPY_CATALOG,
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
} from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider, planThenAnswer, scriptedProvider } from "./helpers/scripted-agent.mjs";

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

test("unresolved listing_copy scope is not reported as excluded", async () => {
  const prisma = buildActionFixture({ kind: "listing_copy" });
  const initial = await state(prisma);

  assert.equal(initial.scope.items.length, 0);
  assert.equal(initial.scope.status, SCOPE_STATUS.unresolved);

  const message = emptyProposalMessage(initial);
  assert.match(message, /not been discovered/i);
  assert.doesNotMatch(message, /excluded or out of scope/i);
});

test("proposal absent + scope unresolved: discovery builds preview without Shopify write", async () => {
  const prisma = buildActionFixture({ kind: "listing_copy" });

  const result = await turn(
    prisma,
    "What exactly are you proposing to change?",
    [
      { tool: "discover_product_type_scope", arguments: {} },
      { tool: "build_change_set", arguments: {} },
    ],
    "Here are the proposed product type changes.",
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.match(result.reply, /Hawkstone Mystery Cuvee|proposed|product type/i);
  assert.doesNotMatch(result.reply, /excluded or out of scope/i);

  const after = await state(prisma);
  assert.equal(after.scope.status, SCOPE_STATUS.resolvedNonempty);
  assert.equal(after.scope.items.length, 2);
  assert.equal(after.scope.items[0].toType, "Red Wine");
  assert.equal(prisma.state.changeSets.length, 1);
  assert.equal(prisma.state.catalog.filter((row) => row.productType === "Red Wine").length, 3);
});

test("scope genuinely empty after discovery is reported accurately", async () => {
  const prisma = buildActionFixture({
    kind: "listing_copy",
    catalog: LISTING_COPY_CATALOG.map((row) => ({
      ...row,
      productType: row.productType || "Red Wine",
    })),
  });

  const ctx = {
    prisma,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    kind: "listing_copy",
    state: await state(prisma),
    async reloadState() {
      this.state = await state(prisma);
      return this.state;
    },
    logger: quietLogger,
    constraints: [],
    resolveProductTitle(title) {
      return { title, ambiguous: false };
    },
    async runCommand() {
      return { ok: true, reply: "" };
    },
    async runCommandWithDiff() {
      return { ok: true, reply: "" };
    },
  };

  const discovered = await runTool(ctx, "discover_product_type_scope", {});
  assert.equal(discovered.ok, true);
  assert.match(discovered.message, /no eligible products missing product types/i);
  assert.doesNotMatch(discovered.message, /excluded/i);

  const after = await state(prisma);
  assert.equal(after.scope.status, SCOPE_STATUS.resolvedEmpty);
});

test("merchant exclusion removes product from current proposal", async () => {
  const prisma = buildActionFixture({ kind: "listing_copy" });

  await turn(prisma, "Show me what you're proposing.", [
    { tool: "discover_product_type_scope", arguments: {} },
  ]);

  const excluded = await turn(prisma, "Leave Hawkstone Mystery Cuvee alone.", [
    { tool: "exclude_product", arguments: { productTitle: "Hawkstone Mystery Cuvee" } },
    { tool: "build_change_set", arguments: {} },
  ]);

  assert.equal(excluded.outcome, TURN_OUTCOME.success);

  const after = await state(prisma);
  assert.deepEqual(
    after.scope.items.map((item) => item.title),
    ["Hawkstone Field Blend"],
  );
  assert.equal(after.scope.excluded.length, 1);
  assert.equal(after.scope.excluded[0].title, "Hawkstone Mystery Cuvee");
});

test("live state change drops products already typed", async () => {
  const prisma = buildActionFixture({ kind: "listing_copy" });

  await turn(prisma, "Show me the proposal.", [{ tool: "discover_product_type_scope", arguments: {} }]);

  const before = await state(prisma);
  assert.equal(before.scope.items.length, 2);
  assert.ok(before.scope.originalEvidence?.productCount >= 2);

  const target = prisma.state.catalog.find((row) => row.title === "Hawkstone Mystery Cuvee");
  target.productType = "Red Wine";

  await turn(prisma, "Refresh the proposal from the live catalog.", [
    { tool: "discover_product_type_scope", arguments: {} },
  ]);

  const after = await state(prisma);
  assert.equal(after.scope.items.length, 1);
  assert.equal(after.scope.items[0].title, "Hawkstone Field Blend");
  assert.ok(after.scope.originalEvidence?.productCount >= 2);
});

test("buildCurrentProposal surfaces product types for listing_copy", async () => {
  const prisma = buildActionFixture({ kind: "listing_copy" });
  await turn(prisma, "Show proposal.", [{ tool: "discover_product_type_scope", arguments: {} }]);

  const current = await state(prisma);
  const proposal = buildCurrentProposal(current);
  assert.equal(proposal.lines.length, 2);
  assert.equal(proposal.lines[0].fromType, "none");
  assert.equal(proposal.lines[0].toType, "Red Wine");
});

test("paraphrased proposal questions use the same discovery path", async () => {
  const prisma = buildActionFixture({ kind: "listing_copy" });

  const messages = [
    "Which products are you changing?",
    "Show me what you'll do.",
    "What product types are you going to set?",
  ];

  for (const message of messages) {
    const local = buildActionFixture({ kind: "listing_copy" });
    const result = await handleFocusedActionMessage(local, {
      message,
      merchantId: MERCHANT,
      shopId: SHOP,
      actionId: local.state.action.id,
      provider: scriptedProvider(
        planThenAnswer([{ tool: "discover_product_type_scope", arguments: {} }], "Preview ready."),
      ),
      logger: quietLogger,
    });
    assert.equal(result.outcome, TURN_OUTCOME.success, message);
    assert.doesNotMatch(result.reply, /excluded or out of scope/i);
  }
});
