import assert from "node:assert/strict";
import test from "node:test";
import {
  signalsFromShopifyResponse,
  TOOL_STACK_SIGNALS_QUERY,
  TOOL_STACK_SIGNAL_LIMITS,
} from "../app/lib/integrations/tool-stack-signals.server.js";
import { detectToolStack } from "../app/lib/integrations/tool-detection.server.js";

test("empty / null / partial responses degrade to empty signals (never throw)", () => {
  const empty = { metafieldNamespaces: [], gateways: [], orderTags: [], customerTags: [], fulfillmentServices: [] };
  assert.deepEqual(signalsFromShopifyResponse(null), empty);
  assert.deepEqual(signalsFromShopifyResponse(undefined), empty);
  assert.deepEqual(signalsFromShopifyResponse({}), empty);
  assert.deepEqual(signalsFromShopifyResponse({ orders: null, customers: {} }), empty);
});

test("accepts both the bare data object and a { data } envelope", () => {
  const inner = { orders: { nodes: [{ paymentGatewayNames: ["PayPal"], tags: ["VIP"] }] } };
  const fromBare = signalsFromShopifyResponse(inner);
  const fromEnvelope = signalsFromShopifyResponse({ data: inner });
  assert.deepEqual(fromBare, fromEnvelope);
  assert.deepEqual(fromBare.gateways, ["paypal"]);
});

test("maps gateways (lower-cased, deduped) and tags (case preserved, deduped)", () => {
  const data = {
    orders: {
      nodes: [
        { paymentGatewayNames: ["PayPal", "shopify_payments"], tags: ["Subscription", "VIP"] },
        { paymentGatewayNames: ["PayPal", "Afterpay"], tags: ["VIP"] },
        null, // defensive: a null node
      ],
    },
    customers: { nodes: [{ tags: ["wholesale"] }, { tags: ["wholesale", "VIP"] }] },
  };
  const s = signalsFromShopifyResponse(data);
  assert.deepEqual(s.gateways.sort(), ["afterpay", "paypal", "shopify_payments"]);
  assert.deepEqual(s.orderTags.sort(), ["Subscription", "VIP"]);
  assert.deepEqual(s.customerTags.sort(), ["VIP", "wholesale"]);
});

test("collects metafield namespaces across every owner type, lower-cased + deduped", () => {
  const data = {
    productDefs: { nodes: [{ namespace: "Loox" }, { namespace: "reviews" }] },
    variantDefs: { nodes: [{ namespace: "recharge" }] },
    orderDefs: { nodes: [{ namespace: "recharge" }] },
    customerDefs: { nodes: [{ namespace: "smile" }] },
    shopDefs: { nodes: [{ namespace: "Judgeme" }] },
  };
  const s = signalsFromShopifyResponse(data);
  assert.deepEqual(s.metafieldNamespaces.sort(), ["judgeme", "loox", "recharge", "reviews", "smile"]);
});

test("end-to-end: a realistic response flows into detectToolStack and identifies the stack", () => {
  const data = {
    orders: {
      nodes: [
        { paymentGatewayNames: ["shopify_payments", "afterpay_us"], tags: ["Subscription Recurring"] },
      ],
    },
    customers: { nodes: [{ tags: ["smile.io member"] }] },
    productDefs: { nodes: [{ namespace: "loox" }] },
  };
  const detected = detectToolStack(signalsFromShopifyResponse(data));
  const ids = detected.map((t) => t.id);
  assert.ok(ids.includes("loox"), "Loox via metafield namespace");
  assert.ok(ids.includes("afterpay"), "Afterpay via gateway substring");
  assert.ok(ids.includes("recharge"), "Recharge via order-tag pattern");
  // sorted by confidence desc: metafield/gateway (0.9/0.95) before the tag match (0.6)
  assert.equal(detected[detected.length - 1].id, "recharge");
});

test("query + limits are well-formed constants", () => {
  assert.match(TOOL_STACK_SIGNALS_QUERY, /query ToolStackSignals/);
  assert.match(TOOL_STACK_SIGNALS_QUERY, /paymentGatewayNames/);
  assert.match(TOOL_STACK_SIGNALS_QUERY, /metafieldDefinitions/);
  assert.equal(typeof TOOL_STACK_SIGNAL_LIMITS.orders, "number");
  assert.ok(TOOL_STACK_SIGNAL_LIMITS.orders > 0 && TOOL_STACK_SIGNAL_LIMITS.defs > 0);
});
