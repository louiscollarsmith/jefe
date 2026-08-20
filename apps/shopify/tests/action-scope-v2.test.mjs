import assert from "node:assert/strict";
import test from "node:test";

import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";
import { MERCHANT, SHOP, buildActionFixture, quietLogger } from "./helpers/action-fixture.mjs";
import { eagerlyDoneProvider } from "./helpers/scripted-agent.mjs";

function turn(prisma, message, toolCalls) {
  return handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: eagerlyDoneProvider(toolCalls, "Updated the scope."),
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

test("dynamic restock scope can add a Shopify product outside original recommendation evidence", async () => {
  const prisma = buildActionFixture({
    kind: "restock",
    catalog: [
      {
        merchantId: MERCHANT,
        shopId: SHOP,
        externalId: "gid://shopify/Product/ash-path",
        title: "Ash Path Listan",
        vendor: "Acme Supplier",
        status: "ACTIVE",
        rawPayload: { dailyVelocity: 0.1 },
        variants: [
          {
            externalId: "gid://shopify/ProductVariant/ash-path-750",
            title: "750ml",
            inventoryItemExternalId: "gid://shopify/InventoryItem/ash-path",
            inventoryLevels: [{ available: 0 }],
          },
        ],
      },
    ],
  });

  const result = await turn(
    prisma,
    "Ash Path Listan also comes from the same supplier, can you add this to the plan too and work out how much we need for 240 days?",
    [
      { tool: "update_plan", arguments: { coverDays: 240 } },
      { tool: "add_product_to_scope", arguments: { productReference: "Ash Path Listan" } },
    ],
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.doesNotMatch(result.reply, /already handled|duplicate|tool/i);

  const projected = await state(prisma);
  const titles = projected.scope.items.map((item) => item.title).sort();
  assert.deepEqual(titles, ["Ash Path Listan", "Pear Skin Sipon", "Picnic Xinomavro"]);

  const ash = projected.scope.items.find((item) => item.title === "Ash Path Listan");
  assert.equal(ash.recommendedUnits, 24);
  assert.equal(projected.canonicalProposal.coverDays, 240);
  assert.ok(
    projected.canonicalProposal.items.some(
      (item) => item.title === "Ash Path Listan" && item.recommendedUnits === 24,
    ),
  );

  const reloaded = await state(prisma);
  assert.ok(reloaded.scope.items.some((item) => item.title === "Ash Path Listan"));
});

test("duplicate successful tool calls do not leak internal loop guard language", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const result = await turn(prisma, "Make it 240 days twice.", [
    { tool: "update_plan", arguments: { coverDays: 240 } },
    { tool: "update_plan", arguments: { coverDays: 240 } },
  ]);

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.doesNotMatch(result.reply, /already handled|duplicate operation|tool already ran/i);
});
