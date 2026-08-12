import assert from "node:assert/strict";
import test from "node:test";

import { sendConversationMessage } from "../app/lib/merchant-memory/conversation.server.js";

// Two guards on the conversation context, both adjacent to the thread-memory work in
// `conversation-thread-memory.test.mjs` (another session's file) but asserting things it
// does not:
//
//  1. `lastDiscussedBeliefKeys` recovers from a stored EMPTY array. It was restored with
//     `??`, which does not treat `[]` as missing, and every no-change turn writes `[]` —
//     so the first one made the rebuild-from-history path unreachable for the rest of the
//     conversation. Confirmed empty on a production conversation row. This pointer feeds
//     the deterministic path ("that's right", "forget that"), which the prompt thread does
//     not cover.
//  2. Thread content is REDACTED before it crosses the AI boundary. The code routes it
//     through safePromptText; nothing asserted it, so a refactor could drop it silently.

const BELIEFS = [
  {
    id: "b1",
    key: "business.description",
    category: "business",
    value: { text: "We sell tinned fish to independent delis." },
    status: "inferred",
    confidence: 0.8,
    evidence: [],
  },
];

/**
 * Prisma double. `storedContext` is what the conversation row already holds, and
 * `priorMessages` is the thread the merchant can see.
 */
function mockPrisma({ storedContext = {}, priorMessages = [] } = {}) {
  const created = [];
  let conversation = { id: "c1", context: storedContext };
  // Stamp the fields every real row carries, so the fixtures above stay about the thread
  // rather than about Prisma's column list.
  const thread = priorMessages.map((message, index) => ({
    id: `p${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 7, 12, 9, index)),
    structuredOperation: null,
    operationStatus: null,
    relatedBeliefIds: [],
    relatedOpenQuestionId: null,
    ...message,
  }));
  return {
    created,
    merchantMemoryBelief: { findMany: async () => BELIEFS },
    merchantMemoryBeliefHistory: { findMany: async () => [] },
    merchantMemoryRefreshRun: { findFirst: async () => null },
    merchantMemoryOpenQuestion: {
      findMany: async () => [],
      upsert: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    merchantMemoryConversation: {
      findFirst: async () => conversation,
      create: async ({ data }) => {
        conversation = { id: "c1", context: {}, ...data };
        return conversation;
      },
      update: async ({ data }) => {
        conversation = { ...conversation, ...data };
        return conversation;
      },
    },
    merchantMemoryConversationMessage: {
      create: async ({ data }) => {
        const row = { id: `m${created.length + 1}`, createdAt: new Date(), ...data };
        created.push(row);
        return row;
      },
      // The prior thread plus whatever this turn has stored so far.
      findMany: async () => [...thread, ...created],
      findFirst: async () => created[created.length - 1] ?? null,
      update: async ({ data }) => data,
    },
  };
}

/** Captures the prompt the interpreter would send. */
function capturingProvider(capture) {
  return {
    provider: "test",
    model: "test",
    enabled: true,
    generateStructuredOperation: async (request) => {
      capture.prompt = JSON.parse(request.prompt);
      return {
        operation: {
          operationType: "no_memory_change",
          reason: "internal note",
          merchantReply: "Understood.",
          merchantStatement: "x",
          confidence: 0.5,
          requiresConfirmation: false,
        },
      };
    },
  };
}

async function promptFrom(options) {
  const capture = {};
  const prisma = mockPrisma(options);
  await sendConversationMessage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    message: options.message ?? "what do you think?",
    llmProvider: capturingProvider(capture),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return capture.prompt;
}

test("a stored empty lastDiscussedBeliefKeys recovers from the thread", async () => {
  // The exact production state: the pointer was zeroed by an earlier no-change turn, while
  // the thread plainly shows which belief was last discussed.
  const prompt = await promptFrom({
    storedContext: { lastDiscussedBeliefKeys: [] },
    priorMessages: [
      { role: "merchant", content: "our description is wrong" },
      {
        role: "assistant",
        content: "Understood.",
        structuredOperation: { targetBeliefKey: "business.description" },
      },
    ],
  });

  assert.deepEqual(
    prompt.conversationContext.lastDiscussedBeliefKeys,
    ["business.description"],
    "an empty stored array must not defeat the rebuild-from-history fallback",
  );
});

test("a stored non-empty lastDiscussedBeliefKeys still wins over history", async () => {
  // The fix must not invert the precedence: an explicit stored pointer is authoritative.
  const prompt = await promptFrom({
    storedContext: { lastDiscussedBeliefKeys: ["business.store_name"] },
    priorMessages: [
      {
        role: "assistant",
        content: "Understood.",
        structuredOperation: { targetBeliefKey: "business.description" },
      },
    ],
  });

  assert.deepEqual(prompt.conversationContext.lastDiscussedBeliefKeys, ["business.store_name"]);
});

test("an array of empty strings counts as empty, not as a topic", async () => {
  const prompt = await promptFrom({
    storedContext: { lastDiscussedBeliefKeys: ["", null] },
    priorMessages: [
      {
        role: "assistant",
        content: "Understood.",
        structuredOperation: { targetBeliefKey: "business.description" },
      },
    ],
  });

  assert.deepEqual(prompt.conversationContext.lastDiscussedBeliefKeys, ["business.description"]);
});

test("no stored pointer and no history is an empty list, not a crash", async () => {
  const prompt = await promptFrom({ storedContext: {}, priorMessages: [] });
  assert.deepEqual(prompt.conversationContext.lastDiscussedBeliefKeys, []);
});

test("thread content is redacted before it reaches the model", async () => {
  // A merchant pasting a customer's details into chat must not have them forwarded to the
  // provider verbatim. safePromptText does this; this asserts it stays done.
  const prompt = await promptFrom({
    priorMessages: [
      { role: "merchant", content: "chase the order for jane.fairfax@example.com on 07700 900123" },
    ],
  });

  const thread = JSON.stringify(prompt.recentThread);
  assert.doesNotMatch(thread, /07700 900123/, "phone numbers must not cross the AI boundary");
  assert.doesNotMatch(thread, /jane\.fairfax@example\.com/, "emails must not cross either");
});
