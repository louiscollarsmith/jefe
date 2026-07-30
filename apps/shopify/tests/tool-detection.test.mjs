import assert from "node:assert/strict";
import test from "node:test";
import { detectToolStack, TOOL_SIGNATURES } from "../app/lib/integrations/tool-detection.server.js";

test("empty signals detect nothing", () => {
  assert.deepEqual(detectToolStack({}), []);
  assert.deepEqual(detectToolStack(), []);
});

test("metafield namespace is a high-confidence match", () => {
  const got = detectToolStack({ metafieldNamespaces: ["loox", "unrelated"] });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "loox");
  assert.equal(got[0].category, "reviews");
  assert.equal(got[0].confidence, 0.9);
  assert.ok(got[0].matchedBy.includes("metafield:loox"));
});

test("fulfillment service (substring, case-insensitive) is the strongest tell", () => {
  const got = detectToolStack({ fulfillmentServices: ["ShipStation Fulfillment"] });
  assert.equal(got[0].id, "shipstation");
  assert.equal(got[0].confidence, 0.95);
});

test("gateway substring detects a payments tool", () => {
  const got = detectToolStack({ gateways: ["afterpay_us"] });
  assert.equal(got[0].id, "afterpay");
  assert.equal(got[0].category, "payments");
});

test("order-tag pattern is a weaker (0.6) signal", () => {
  const got = detectToolStack({ orderTags: ["Subscription Recurring"] });
  const recharge = got.find((t) => t.id === "recharge");
  assert.ok(recharge, "recharge detected via tag");
  assert.equal(recharge.confidence, 0.6);
});

test("a stronger signal wins the confidence for the same tool", () => {
  const got = detectToolStack({ metafieldNamespaces: ["recharge"], orderTags: ["Subscription"] });
  const recharge = got.find((t) => t.id === "recharge");
  assert.equal(recharge.confidence, 0.9, "metafield (0.9) beats tag (0.6)");
  assert.ok(recharge.matchedBy.length >= 2, "records both signals");
});

test("detects multiple tools + sorts by confidence desc", () => {
  const got = detectToolStack({
    metafieldNamespaces: ["judgeme"], // reviews, 0.9
    fulfillmentServices: ["shipbob"], // fulfillment, 0.95
    orderTags: ["subscription"], // recharge, 0.6
  });
  assert.deepEqual(got.map((t) => t.id), ["shipbob", "judgeme", "recharge"]);
});

test("no false positives from unrelated signals", () => {
  const got = detectToolStack({
    metafieldNamespaces: ["my_custom_ns", "global"],
    gateways: ["shopify_payments"],
    orderTags: ["VIP", "gift"],
  });
  assert.deepEqual(got, []);
});

test("registry entries are well-formed (id/name/category + at least one signal)", () => {
  for (const s of TOOL_SIGNATURES) {
    assert.ok(s.id && s.name && s.category, `${s.id}: id/name/category`);
    const hasSignal =
      (s.metafieldNamespaces?.length ?? 0) +
      (s.fulfillmentServices?.length ?? 0) +
      (s.gateways?.length ?? 0) +
      (s.orderTagPatterns?.length ?? 0) +
      (s.customerTagPatterns?.length ?? 0);
    assert.ok(hasSignal > 0, `${s.id}: has at least one signal`);
  }
  // ids unique
  const ids = TOOL_SIGNATURES.map((s) => s.id);
  assert.equal(ids.length, new Set(ids).size, "tool ids are unique");
});
