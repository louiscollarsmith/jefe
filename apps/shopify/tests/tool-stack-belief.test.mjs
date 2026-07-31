import assert from "node:assert/strict";
import test from "node:test";
import { detectToolStack } from "../app/lib/integrations/tool-detection.server.js";
import {
  TOOL_STACK_BELIEF_KEY,
  buildToolStackBeliefUpsertInput,
  makeToolStackBeliefRecorder,
  toolStackBeliefContent,
  toolStackSignalsFromRecords,
} from "../app/lib/integrations/tool-stack-belief.server.js";

// --- toolStackBeliefContent: detected → belief value + confidence (the shared mapper) ---------

test("toolStackBeliefContent: empty detection → zero-count, zero-confidence value", () => {
  const content = toolStackBeliefContent([]);
  assert.equal(content.value.detectedCount, 0);
  assert.deepEqual(content.value.tools, []);
  assert.deepEqual(content.value.toolIds, []);
  assert.equal(content.confidence, 0);
  assert.match(content.summary, /No third-party tools/);
});

test("toolStackBeliefContent: strong signal (metafield namespace) → high confidence", () => {
  const detected = detectToolStack({ metafieldNamespaces: ["loox"] });
  const content = toolStackBeliefContent(detected);
  assert.equal(content.value.detectedCount, 1);
  assert.deepEqual(content.value.toolIds, ["loox"]);
  assert.deepEqual(content.value.categories, ["reviews"]);
  assert.equal(content.confidence, 0.9, "metafield namespace is a strong signal");
});

test("toolStackBeliefContent: weak signal (order tag only) → low confidence, never dressed up", () => {
  const detected = detectToolStack({ orderTags: ["Subscription"] });
  const content = toolStackBeliefContent(detected);
  assert.deepEqual(content.value.toolIds, ["recharge"]);
  assert.equal(content.confidence, 0.6, "a hand-taggable order tag is a weak signal");
});

test("toolStackBeliefContent: confidence = MAX per-tool across a mixed stack", () => {
  const detected = detectToolStack({
    metafieldNamespaces: ["loox"], // 0.9 reviews
    orderTags: ["Subscription"], // 0.6 recharge
    gateways: ["afterpay_us"], // 0.9 payments
  });
  const content = toolStackBeliefContent(detected);
  assert.ok(content.value.detectedCount >= 3);
  assert.equal(content.confidence, 0.9, "strongest single signal wins");
  assert.deepEqual(content.value.categories, ["payments", "reviews", "subscriptions"]);
  // provenance is preserved per tool and is PII-free (signal kinds, not customer data)
  const loox = content.value.tools.find((tool) => tool.id === "loox");
  assert.ok(loox.matchedBy.some((match) => match.startsWith("metafield:")));
});

// --- toolStackSignalsFromRecords: extract signals from already-fetched DB records ---------------

test("toolStackSignalsFromRecords: pulls gateways + order tags from order rawPayload", () => {
  const signals = toolStackSignalsFromRecords({
    orders: [
      { rawPayload: { paymentGatewayNames: ["afterpay_us"], tags: "Subscription, VIP" } },
      { rawPayload: { fulfillments: [{ service: "shipbob" }] } },
    ],
    customerIdentities: [{ rawPayload: { tags: ["wholesale"] } }],
  });
  assert.deepEqual(signals.gateways, ["afterpay_us"]);
  assert.deepEqual(signals.orderTags, ["Subscription", "VIP"], "comma string tags split + trimmed");
  assert.deepEqual(signals.fulfillmentServices, ["shipbob"]);
  assert.deepEqual(signals.customerTags, ["wholesale"]);
  assert.deepEqual(signals.metafieldNamespaces, [], "metafield namespaces are never in ingested records");
});

test("toolStackSignalsFromRecords: records without rawPayload → empty signals (order signals dormant)", () => {
  const signals = toolStackSignalsFromRecords({
    orders: [{ id: "o1" }, { id: "o2", rawPayload: null }],
    customerIdentities: [{ rawPayload: { orderIds: ["x"] } }],
  });
  assert.deepEqual(signals.gateways, []);
  assert.deepEqual(signals.orderTags, []);
  assert.deepEqual(signals.customerTags, []);
});

test("toolStackSignalsFromRecords → detectToolStack: end-to-end from DB records", () => {
  const signals = toolStackSignalsFromRecords({
    orders: [{ rawPayload: { paymentGatewayNames: ["klarna"], tags: ["recharge"] } }],
  });
  const detected = detectToolStack(signals);
  const ids = detected.map((tool) => tool.id);
  assert.ok(ids.includes("klarna"), "gateway → Klarna");
  assert.ok(ids.includes("recharge"), "order tag → Recharge");
});

// --- buildToolStackBeliefUpsertInput: the pure upsert input for the write path ------------------

test("buildToolStackBeliefUpsertInput: correct belief shape; precedence omitted (→ inference)", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");
  const detected = detectToolStack({ metafieldNamespaces: ["loox"], gateways: ["afterpay_us"] });
  const input = buildToolStackBeliefUpsertInput({ merchantId: "m1", shopId: "shop1", detected, now });

  assert.equal(input.key, TOOL_STACK_BELIEF_KEY);
  assert.equal(input.key, "business.tool_stack");
  assert.equal(input.category, "business");
  assert.equal(input.valueType, "structured");
  assert.equal(input.merchantId, "m1");
  assert.equal(input.shopId, "shop1");
  assert.equal(input.confidence, 0.9);
  assert.ok(input.value.toolIds.includes("loox") && input.value.toolIds.includes("afterpay"));
  // NEVER merchant-confirmed: no precedence set → upsertDerivedBelief defaults to systemInference.
  assert.equal(
    Object.prototype.hasOwnProperty.call(input, "precedence"),
    false,
    "must not pin a merchant precedence",
  );
  assert.equal(input.evidence.evidenceType, "tool_stack_detection");
  assert.ok(input.evidence.metadata.matchedSignalKinds.includes("metafield"));
  assert.ok(input.evidence.metadata.matchedSignalKinds.includes("gateway"));
});

// --- makeToolStackBeliefRecorder: the concrete recordBelief seam wired to the write path --------

test("makeToolStackBeliefRecorder: requires an upsertDerivedBelief dependency", () => {
  assert.throws(() => makeToolStackBeliefRecorder({ prisma: {} }), /upsertDerivedBelief/);
});

test("makeToolStackBeliefRecorder: empty detection is a no-op (never writes an empty belief)", async () => {
  const calls = [];
  const record = makeToolStackBeliefRecorder({
    upsertDerivedBelief: async (prisma, input) => { calls.push(input); return { changed: true }; },
    prisma: {},
    shopId: "shop1",
  });
  const res = await record({ merchantId: "m1", detected: [], signals: { gateways: [] } });
  assert.deepEqual(res, { wrote: false, reason: "no_tools_detected" });
  assert.equal(calls.length, 0, "no write when nothing detected");
});

test("makeToolStackBeliefRecorder: persists detected stack via the injected write path", async () => {
  const calls = [];
  const record = makeToolStackBeliefRecorder({
    upsertDerivedBelief: async (prisma, input) => { calls.push({ prisma, input }); return { changed: true }; },
    prisma: { tag: "prisma-double" },
    shopId: "shop1",
  });
  const detected = detectToolStack({ metafieldNamespaces: ["loox"], gateways: ["afterpay_us"] });
  const res = await record({ merchantId: "m7", detected, signals: {} });

  assert.equal(res.wrote, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prisma.tag, "prisma-double", "the injected prisma is used");
  assert.equal(calls[0].input.key, "business.tool_stack");
  assert.equal(calls[0].input.merchantId, "m7");
  assert.equal(calls[0].input.shopId, "shop1");
  assert.equal(calls[0].input.confidence, 0.9);
});

test("makeToolStackBeliefRecorder: a write failure propagates (caller keeps it fire-and-forget)", async () => {
  let logged = false;
  const record = makeToolStackBeliefRecorder({
    upsertDerivedBelief: async () => { throw new Error("db down"); },
    prisma: {},
    logger: { error: () => { logged = true; } },
  });
  const detected = detectToolStack({ metafieldNamespaces: ["loox"] });
  await assert.rejects(() => record({ merchantId: "m1", detected }), /db down/);
  assert.equal(logged, true, "error is captured before rethrow");
});
