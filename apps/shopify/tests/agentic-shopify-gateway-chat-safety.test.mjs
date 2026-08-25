import assert from "node:assert/strict";
import test from "node:test";

import { AGENTIC_ACTION_CHAT_TOOLS, agenticActionChatToolCatalogue } from "../app/lib/shopify/agentic-runtime/action-chat.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// docs/ops/agentic-shopify-gateway-full/ Part 6: chat's Shopify access is migrated to
// shopify_schema/shopify_query only, dispatched with recommendationMode: true — the same hard,
// structural read-only mechanism already proven safe by the recommendation-agent and standalone
// gateway test suites (20 + 9 tests). These are the chat-specific properties worth testing
// directly: the mutation tools are never even a recognized tool name here, and the tool catalogue
// switches surface correctly.

async function withSurface(surface, fn) {
  const previous = process.env.SHOPIFY_AGENT_SURFACE;
  process.env.SHOPIFY_AGENT_SURFACE = surface;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SHOPIFY_AGENT_SURFACE;
    else process.env.SHOPIFY_AGENT_SURFACE = previous;
  }
}

test("action-chat never recognizes the mutation tool names, regardless of surface", () => {
  assert.equal(AGENTIC_ACTION_CHAT_TOOLS.includes(SHOPIFY_GATEWAY_TOOL.prepareMutation), false);
  assert.equal(AGENTIC_ACTION_CHAT_TOOLS.includes(SHOPIFY_GATEWAY_TOOL.executeMutation), false);
});

test("action-chat recognizes shopify_schema/shopify_query as valid tool names", () => {
  assert.equal(AGENTIC_ACTION_CHAT_TOOLS.includes(SHOPIFY_GATEWAY_TOOL.schema), true);
  assert.equal(AGENTIC_ACTION_CHAT_TOOLS.includes(SHOPIFY_GATEWAY_TOOL.query), true);
});

test("gateway surface: the tool catalogue describes shopify_schema/shopify_query, not the catalog tools", async () => {
  await withSurface("gateway", async () => {
    const catalogue = agenticActionChatToolCatalogue();
    const names = catalogue.map((t) => t.name);
    assert.equal(names.includes(SHOPIFY_GATEWAY_TOOL.schema), true);
    assert.equal(names.includes(SHOPIFY_GATEWAY_TOOL.query), true);
    assert.equal(names.includes("retrieve_shopify_operations"), false);
    assert.equal(names.includes("call_shopify_operation"), false);
    assert.equal(names.includes(SHOPIFY_GATEWAY_TOOL.prepareMutation), false);
    assert.equal(names.includes(SHOPIFY_GATEWAY_TOOL.executeMutation), false);
  });
});
