import assert from "node:assert/strict";
import test from "node:test";

import {
  retryLastConversationReply,
  sendConversationMessage,
} from "../app/lib/merchant-memory/conversation.server.js";

// A merchant message that gets no reply used to be a dead end: the send commits the
// merchant's row BEFORE Jefe is asked, so a failure left their words in the thread with
// nothing after them and no way to ask again except retyping — which would have stored
// what they said twice. `retryLastConversationReply` answers the message already there.
//
// The property that matters is NOT "a retry produces a reply" (an assistant row is easy to
// assert and easy to fake). It is that a retry NEVER writes a second copy of the merchant's
// message, and that retrying an already-answered thread does nothing at all.

const MERCHANT = "m1";
const SHOP = "s1";

// enabled:false keeps interpretMerchantMessageWithLlm on its deterministic fallback — no
// network, and the branch taken is real application code rather than a mocked reply.
const OFFLINE_LLM = { enabled: false };

function buildPrisma({ seedMessages = [] } = {}) {
  const conversations = [
    {
      id: "conv-1",
      merchantId: MERCHANT,
      shopId: SHOP,
      topic: "memory",
      status: "active",
      context: {},
      createdAt: new Date("2026-08-12T09:00:00.000Z"),
      updatedAt: new Date("2026-08-12T09:00:00.000Z"),
    },
  ];
  const messages = seedMessages.map((message, index) => ({
    id: message.id ?? `seed-${index + 1}`,
    conversationId: "conv-1",
    merchantId: MERCHANT,
    shopId: SHOP,
    structuredOperation: null,
    operationStatus: null,
    relatedBeliefIds: [],
    relatedOpenQuestionId: null,
    safeSummary: null,
    createdAt: new Date(`2026-08-12T10:0${index}:00.000Z`),
    ...message,
  }));

  return {
    messages,
    conversations,
    merchantMemoryConversation: {
      findFirst: async () => conversations[0],
      create: async ({ data }) => {
        const row = { id: `conv-${conversations.length + 1}`, ...data };
        conversations.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = conversations.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    merchantMemoryConversationMessage: {
      create: async ({ data }) => {
        const row = {
          id: `msg-${messages.length + 1}`,
          createdAt: new Date(`2026-08-12T11:0${messages.length}:00.000Z`),
          structuredOperation: null,
          operationStatus: null,
          relatedBeliefIds: [],
          relatedOpenQuestionId: null,
          ...data,
        };
        messages.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }) => {
        const matches = messages.filter(
          (m) =>
            (where.id === undefined || m.id === where.id) &&
            (where.role === undefined || m.role === where.role) &&
            (where.conversationId === undefined ||
              m.conversationId === where.conversationId) &&
            (where.merchantId === undefined || m.merchantId === where.merchantId),
        );
        if (orderBy?.createdAt === "desc") {
          return [...matches].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
        }
        return matches[0] ?? null;
      },
      findMany: async ({ where }) =>
        messages.filter((m) => m.conversationId === where.conversationId),
    },
    merchantMemoryOpenQuestion: {
      upsert: async () => ({}),
      findMany: async () => [],
    },
    merchantMemoryBelief: {
      findMany: async () => [],
    },
  };
}

const merchantRows = (prisma) => prisma.messages.filter((m) => m.role === "merchant");

test("a retry answers the existing message instead of storing it a second time", async () => {
  const prisma = buildPrisma({
    seedMessages: [
      { id: "msg-unanswered", role: "merchant", content: "how are my margins looking?" },
    ],
  });

  const result = await retryLastConversationReply(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    llmProvider: OFFLINE_LLM,
  });

  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  // The whole point: still exactly ONE merchant message, and it is the original row.
  assert.equal(merchantRows(prisma).length, 1);
  assert.equal(merchantRows(prisma)[0].id, "msg-unanswered");
  // And the thread no longer ends on the merchant — Jefe has said something back.
  assert.equal(prisma.messages[prisma.messages.length - 1].role, "assistant");
});

test("retrying an already-answered thread is a no-op, not a second reply", async () => {
  const prisma = buildPrisma({
    seedMessages: [
      { id: "msg-asked", role: "merchant", content: "how are my margins looking?" },
      { id: "msg-answered", role: "assistant", content: "Here is what I found." },
    ],
  });
  const before = prisma.messages.length;

  const result = await retryLastConversationReply(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    llmProvider: OFFLINE_LLM,
  });

  assert.equal(result.ok, true);
  assert.equal(result.retried, false);
  // A double-tapped Retry, or one clicked in a stale tab, must not append anything.
  assert.equal(prisma.messages.length, before);
});

test("retrying an empty thread is harmless", async () => {
  const prisma = buildPrisma();
  const result = await retryLastConversationReply(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    llmProvider: OFFLINE_LLM,
  });
  assert.equal(result.ok, true);
  assert.equal(result.retried, false);
  assert.equal(prisma.messages.length, 0);
});

test("reuseMessageId will not adopt another merchant's message", async () => {
  const prisma = buildPrisma({
    seedMessages: [
      { id: "msg-theirs", role: "merchant", content: "not yours", merchantId: "m2" },
    ],
  });

  const result = await sendConversationMessage(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    message: "not yours",
    reuseMessageId: "msg-theirs",
    llmProvider: OFFLINE_LLM,
  });

  // Tenant scoping is part of the lookup, so the row is simply not found — and a
  // not-found reuse must fail closed rather than silently creating a fresh message.
  assert.equal(result.ok, false);
  assert.equal(merchantRows(prisma).length, 1);
  assert.equal(merchantRows(prisma)[0].merchantId, "m2");
});
