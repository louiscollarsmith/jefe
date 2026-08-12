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

test("both executable action types are wired", () => {
  const types = listExecutableActionTypes().sort();
  assert.deepEqual(types, ["listing_copy", "price_markdown"]);
});

test("a listing-copy approval does not get handed to the clearance wire", async () => {
  // The regression this module exists to prevent: before it, this returned
  // "wrong_primitive:listing_copy" from the clearance wire and the merchant's tap was a no-op.
  const result = await executeApprovedAction(
    prismaWith({ actionType: "listing_copy", merchantId: "m1" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
    { loadOfflineToken: async () => "tok", createGqlClient: () => ({ async request() { return {}; } }) },
  );
  assert.notEqual(result.reason, "wrong_primitive:listing_copy");
});

test("an unknown action type executes nothing rather than falling back to clearance", async () => {
  const result = await executeApprovedAction(
    prismaWith({ actionType: "some_future_action", merchantId: "m1" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "no_wire:some_future_action");
});

test("another merchant's run is refused before any wire is reached", async () => {
  const result = await executeApprovedAction(
    prismaWith({ actionType: "price_markdown", merchantId: "someone-else" }),
    session,
    { merchantId: "m1", actionRunId: "run-1", mode: "approve" },
  );
  assert.equal(result.reason, "not_found");
});
