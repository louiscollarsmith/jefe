import assert from "node:assert/strict";
import test from "node:test";

import { buildGroundedFallbackReply } from "../app/lib/merchant-memory/general-chat.server.js";

// The grounded fallback interpolates a retrieved item's content straight into the reply.
// Not every retrieved item is prose — some carry a serialised belief value — so a merchant
// asking about growth was shown:
//
//   From what I know about your business, Trailing 90d: {"items":[{"name":"Meadowline",
//   "revenue":1527.5,"sharePercent":30.13}, …
//
// Found by the answer-quality harness against the holistic chat, on the path taken whenever
// both LLM providers fail. Raw JSON is never an answer; admitting the gap is better.

const ctx = (semantic) => ({
  queryClass: "general",
  semanticMemory: semantic,
  episodicMemory: [],
  actionMemory: [],
});

test("a serialised belief value is never read out to the merchant", () => {
  const reply = buildGroundedFallbackReply("how is growth?", ctx([
    {
      content:
        'Trailing 90d: {"items":[{"name":"Meadowline","revenue":1527.5,"sharePercent":30.13}]}',
    },
  ]));

  assert.doesNotMatch(reply, /\{"/, "no JSON object may reach merchant copy");
  assert.doesNotMatch(reply, /sharePercent/);
  assert.match(reply, /couldn’t connect|couldn't connect/, "admits the gap instead");
});

test("a readable item is still used", () => {
  // Selection is by word overlap with the question, so the item has to share a term —
  // this test is about prose surviving the filter, not about the scorer.
  const reply = buildGroundedFallbackReply("how is revenue?", ctx([
    { content: "Revenue grew about 12% over the last 90 days" },
  ]));

  assert.match(reply, /Revenue grew about 12%/);
  assert.match(reply, /^From what I know about your business,/);
});

test("a readable item is preferred over a serialised one", () => {
  // The JSON item is first and would otherwise win on position.
  const reply = buildGroundedFallbackReply("how are repeat customers?", ctx([
    { content: 'Repeat customers coverage: {"ratio":1,"numerator":436}' },
    { content: "Repeat customers are about a third of all orders" },
  ]));

  assert.match(reply, /Repeat customers/);
  assert.doesNotMatch(reply, /ratio/);
});

test("key/value fragments are rejected too, not just full objects", () => {
  const reply = buildGroundedFallbackReply("what is the denominator?", ctx([
    { content: '"percentage": 100, "denominator": 436' },
  ]));

  assert.doesNotMatch(reply, /denominator/);
});

test("an empty context still produces the plain admission", () => {
  const reply = buildGroundedFallbackReply("how is growth?", ctx([]));
  assert.match(reply, /couldn’t connect|couldn't connect/);
});
