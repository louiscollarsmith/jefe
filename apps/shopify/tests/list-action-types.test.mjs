import assert from "node:assert/strict";
import test from "node:test";
import { listActionTypes, ACTION_REGISTRY } from "../app/lib/actions/action-intent.server.js";

test("listActionTypes returns engine facts per registered action type (no design copy)", () => {
  const pm = listActionTypes({ CLEARANCE_EXECUTE_ENABLED: "true" }).find((a) => a.actionType === "price_markdown");
  assert.ok(pm, "price_markdown present");
  assert.equal(pm.live, true, "live when its execute-flag is 'true'");
  assert.deepEqual(pm.requiredScopes, ["write_products"]);
  // engine facts only — no label/order/detail leaking from the registry
  assert.deepEqual(Object.keys(pm).sort(), ["actionType", "live", "requiredScopes"]);
});

test("live is false when the execute-flag is off / absent / not exactly 'true'", () => {
  const pmWith = (env) => listActionTypes(env).find((a) => a.actionType === "price_markdown").live;
  assert.equal(pmWith({ CLEARANCE_EXECUTE_ENABLED: "false" }), false);
  assert.equal(pmWith({}), false);
  assert.equal(pmWith({ CLEARANCE_EXECUTE_ENABLED: "1" }), false, "exact 'true' only");
  assert.equal(pmWith({ CLEARANCE_EXECUTE_ENABLED: "TRUE" }), false);
});

test("covers exactly the registered action types", () => {
  const list = listActionTypes({});
  assert.equal(list.length, Object.keys(ACTION_REGISTRY).length);
  assert.deepEqual(list.map((a) => a.actionType).sort(), Object.keys(ACTION_REGISTRY).sort());
});
