import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDetectedToolStackView,
  toolConfidenceBand,
  detectedViaPhrase,
  TOOL_SURFACEABLE_CONFIDENCE,
  TOOL_STACK_BELIEF_KEY,
} from "../app/lib/integrations/tool-stack-read.server.js";

/** A domain-belief-shaped fixture whose value is the detector's output array. */
function belief(detected, extra = {}) {
  return { key: TOOL_STACK_BELIEF_KEY, value: detected, confidence: 0.9, lastObservedAt: new Date("2026-07-31T00:00:00Z"), ...extra };
}

test("null / absent belief → friendly none_yet view, never an error", () => {
  const view = buildDetectedToolStackView(null);
  assert.equal(view.empty, true);
  assert.equal(view.status, "none_yet");
  assert.equal(view.count, 0);
  assert.equal(view.headline, null);
  assert.deepEqual(view.tools, []);
  assert.equal(view.provenance, "inference");
});

test("maps detected tools → render-ready, inference-framed, nothing connected", () => {
  const view = buildDetectedToolStackView(
    belief([
      { id: "recharge", name: "Recharge", category: "subscriptions", matchedBy: ["metafield:recharge"], confidence: 0.9 },
      { id: "paypal", name: "PayPal", category: "payments", matchedBy: ["gateway:paypal"], confidence: 0.9 },
    ]),
  );
  assert.equal(view.status, "detected");
  assert.equal(view.count, 2);
  assert.equal(view.provenance, "inference");
  const recharge = view.tools.find((t) => t.id === "recharge");
  assert.equal(recharge.name, "Recharge");
  assert.equal(recharge.categoryLabel, "Subscriptions");
  assert.equal(recharge.connected, false); // never fabricate a connection
  assert.equal(recharge.connectOffer.status, "coming_soon"); // honestly gated until the mechanism lands
  assert.equal(recharge.connectOffer.cta, "Connect Recharge");
});

test("tolerates value shape: bare array, {detected:[]}, {tools:[]}", () => {
  const arr = [{ id: "loox", name: "Loox", category: "reviews", confidence: 0.9, matchedBy: ["metafield:loox"] }];
  assert.equal(buildDetectedToolStackView(belief(arr)).count, 1);
  assert.equal(buildDetectedToolStackView(belief({ detected: arr })).count, 1);
  assert.equal(buildDetectedToolStackView(belief({ tools: arr })).count, 1);
});

test("drops malformed entries (no id)", () => {
  const view = buildDetectedToolStackView(belief([{ name: "Ghost" }, { id: "smile", name: "Smile.io", category: "loyalty", confidence: 0.9 }]));
  assert.equal(view.count, 1);
  assert.equal(view.tools[0].id, "smile");
});

test("surfaceable gates on confidence threshold (tag-only matches fall below)", () => {
  const view = buildDetectedToolStackView(
    belief([
      { id: "strong", name: "Strong", category: "reviews", confidence: 0.9, matchedBy: ["metafield:x"] },
      { id: "weak", name: "Weak", category: "subscriptions", confidence: 0.6, matchedBy: ["orderTag:sub"] },
    ]),
  );
  assert.equal(view.surfaceableCount, 1);
  assert.equal(view.tools.find((t) => t.id === "strong").surfaceable, true);
  assert.equal(view.tools.find((t) => t.id === "weak").surfaceable, false);
  assert.ok(0.6 < TOOL_SURFACEABLE_CONFIDENCE && TOOL_SURFACEABLE_CONFIDENCE <= 0.7);
});

test("groups by category", () => {
  const view = buildDetectedToolStackView(
    belief([
      { id: "loox", name: "Loox", category: "reviews", confidence: 0.9 },
      { id: "yotpo", name: "Yotpo", category: "reviews", confidence: 0.9 },
      { id: "paypal", name: "PayPal", category: "payments", confidence: 0.9 },
    ]),
  );
  const reviews = view.byCategory.find((c) => c.category === "reviews");
  assert.equal(reviews.tools.length, 2);
  assert.equal(reviews.categoryLabel, "Reviews");
  assert.equal(view.byCategory.find((c) => c.category === "payments").tools.length, 1);
});

test("headline reads naturally at 1 / 2 / 3+ tools", () => {
  const t = (id) => ({ id, name: id, category: "other", confidence: 0.9 });
  assert.equal(buildDetectedToolStackView(belief([t("A")])).headline, "Jefe spotted A in your stack");
  assert.equal(buildDetectedToolStackView(belief([t("A"), t("B")])).headline, "Jefe spotted A and B in your stack");
  assert.equal(buildDetectedToolStackView(belief([t("A"), t("B"), t("C"), t("D")])).headline, "Jefe spotted A, B and 2 more in your stack");
});

test("toolConfidenceBand bands", () => {
  assert.equal(toolConfidenceBand(0.95), "high");
  assert.equal(toolConfidenceBand(0.75), "medium");
  assert.equal(toolConfidenceBand(0.6), "low");
  assert.equal(toolConfidenceBand(null), "unknown");
});

test("detectedViaPhrase humanizes the strongest signal", () => {
  assert.equal(detectedViaPhrase(["metafield:klaviyo"]), "app data saved in your store");
  assert.equal(detectedViaPhrase(["gateway:paypal"]), "a payment method at checkout");
  assert.equal(detectedViaPhrase(["fulfillment:shipstation"]), "a fulfillment service on your orders");
  assert.equal(detectedViaPhrase([]), "signals in your store");
  assert.equal(detectedViaPhrase(undefined), "signals in your store");
});
