import assert from "node:assert/strict";
import test from "node:test";
import {
  detectAndRecordToolStack,
  isToolStackDetectionEnabled,
} from "../app/lib/integrations/tool-stack-detection.server.js";

const OFF = { ENABLE_TOOL_STACK_DETECTION: "false" };
const ON = { ENABLE_TOOL_STACK_DETECTION: "true" };

/** A fake Admin GraphQL client that records calls and returns canned data. */
function fakeClient(data) {
  const calls = [];
  return { calls, request: async (q, v) => { calls.push({ q, v }); return data; } };
}

const SIGNAL_DATA = {
  orders: { nodes: [{ paymentGatewayNames: ["afterpay_us"], tags: ["Subscription"] }] },
  customers: { nodes: [] },
  productDefs: { nodes: [{ namespace: "loox" }] },
};

test("isToolStackDetectionEnabled reads the flag (default off)", () => {
  assert.equal(isToolStackDetectionEnabled(ON), true);
  assert.equal(isToolStackDetectionEnabled(OFF), false);
  assert.equal(isToolStackDetectionEnabled({}), false);
});

test("flag off: complete no-op — never queries Shopify, never writes", async () => {
  const client = fakeClient(SIGNAL_DATA);
  let recorded = false;
  const res = await detectAndRecordToolStack({
    client, merchantId: "m1", env: OFF, recordBelief: async () => { recorded = true; },
  });
  assert.deepEqual(res, { enabled: false, detected: [], wrote: false });
  assert.equal(client.calls.length, 0, "no Shopify query while dark");
  assert.equal(recorded, false, "no belief write while dark");
});

test("flag on, no recordBelief: queries + detects, returns result, wrote=false", async () => {
  const client = fakeClient(SIGNAL_DATA);
  const res = await detectAndRecordToolStack({ client, merchantId: "m1", env: ON });
  assert.equal(res.enabled, true);
  assert.equal(res.wrote, false);
  assert.equal(client.calls.length, 1, "one bounded query");
  const ids = res.detected.map((t) => t.id);
  assert.ok(ids.includes("loox"), "metafield namespace → Loox");
  assert.ok(ids.includes("afterpay"), "gateway substring → Afterpay");
  assert.ok(ids.includes("recharge"), "order-tag pattern → Recharge");
});

test("flag on, with recordBelief: persists via the injected seam (detected + signals)", async () => {
  const client = fakeClient(SIGNAL_DATA);
  let payload = null;
  const res = await detectAndRecordToolStack({
    client, merchantId: "m7", env: ON, recordBelief: async (p) => { payload = p; },
  });
  assert.equal(res.wrote, true);
  assert.equal(payload.merchantId, "m7");
  assert.ok(Array.isArray(payload.detected) && payload.detected.length >= 2);
  assert.ok(payload.signals && Array.isArray(payload.signals.gateways), "signals passed through");
});

test("detection failures propagate (caller keeps it fire-and-forget)", async () => {
  const client = { request: async () => { throw new Error("throttled"); } };
  await assert.rejects(
    () => detectAndRecordToolStack({ client, merchantId: "m1", env: ON }),
    /throttled/,
  );
});
