/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import {
  executeApprovedAction,
  listExecutableActionTypes,
} from "../app/lib/actions/execute-approved-action.server.js";

// The surface used to call the clearance wire for EVERY approval. That was safe only while
// clearance was the only executable action; with a second one, a merchant's tap reached the
// wrong wire, was refused, and nothing happened with no explanation.

function prismaWith(row) {
  return { actionExecution: { async findUnique() { return row; } } };
}
const session = { shop: "mock.myshopify.com" };

test("every executable action type is wired", () => {
  const types = listExecutableActionTypes().sort();
  assert.deepEqual(types, [
    "listing_copy",
    "price_markdown",
    "shopify_inventory_transfer",
    "tidy_up",
  ]);
});

test("a tidy-up approval reaches its own wire, not clearance's", async () => {
  const result = await executeApprovedAction(
    prismaWith({ actionType: "tidy_up", merchantId: "m1", status: "proposed" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    { loadOfflineToken: async () => "tok", createGqlClient: () => ({ async request() { return {}; } }) },
  );
  assert.notEqual(result.reason, "wrong_primitive:tidy_up");
  assert.notEqual(result.reason, "no_wire:tidy_up");
});

test("a listing-copy approval does not get handed to the clearance wire", async () => {
  // The regression this module exists to prevent: before it, this returned
  // "wrong_primitive:listing_copy" from the clearance wire and the merchant's tap was a no-op.
  const result = await executeApprovedAction(
    prismaWith({ actionType: "listing_copy", merchantId: "m1", status: "proposed" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    { loadOfflineToken: async () => "tok", createGqlClient: () => ({ async request() { return {}; } }) },
  );
  assert.notEqual(result.reason, "wrong_primitive:listing_copy");
});

test("an inventory-transfer approval builds the Shopify client and executes through its wire", async () => {
  const previousFlag = process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
  process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = "true";
  let capturedVariables = null;
  try {
    const prisma = {
      actionExecution: {
        async findUnique() {
          return {
            runId: "run-1",
            merchantId: "m1",
            shopId: "s1",
            merchantActionId: "action-1",
            actionType: "shopify_inventory_transfer",
            actionKind: "inventory_transfer",
            status: "approved",
            resolvedMode: "approve",
            preview: {
              originLocationId: "gid://shopify/Location/1",
              destinationLocationId: "gid://shopify/Location/2",
              lineItems: [
                {
                  inventoryItemId: "gid://shopify/InventoryItem/1",
                  title: "Pear Skin Sipon",
                  quantity: 3,
                },
              ],
            },
          };
        },
      },
      actionExecutionWrite: {
        async findFirst() {
          return null;
        },
        async create() {
          return {};
        },
      },
    };

    const result = await executeApprovedAction(
      prisma,
      session,
      { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
      {
        loadOfflineToken: async () => "tok",
        createGqlClient: () => ({
          async request(_query, variables) {
            capturedVariables = variables;
            return {
              inventoryTransferCreate: {
                inventoryTransfer: {
                  id: "gid://shopify/InventoryTransfer/1",
                  status: "OPEN",
                },
                userErrors: [],
              },
            };
          },
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.executed, true);
    assert.equal(
      result.result.shopifyTransferId,
      "gid://shopify/InventoryTransfer/1",
    );
    assert.equal(result.result.status, "OPEN");
    assert.equal(
      capturedVariables.idempotencyKey,
      "run-1:inventory_transfer",
    );
  } finally {
    if (previousFlag !== undefined) {
      process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = previousFlag;
    } else {
      delete process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED;
    }
  }
});

test("an unknown action type executes nothing rather than falling back to clearance", async () => {
  const result = await executeApprovedAction(
    prismaWith({ actionType: "some_future_action", merchantId: "m1", status: "proposed" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "no_wire:some_future_action");
});

test("another merchant's run is refused before any wire is reached", async () => {
  const result = await executeApprovedAction(
    prismaWith({ actionType: "price_markdown", merchantId: "someone-else", status: "proposed" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
  );
  assert.equal(result.reason, "not_found");
});

test("a stale non-executable run is refused before any wire is reached", async () => {
  const result = await executeApprovedAction(
    prismaWith({ actionType: "price_markdown", merchantId: "m1", status: "superseded" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "not_executable:superseded");
});
