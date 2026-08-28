import assert from "node:assert/strict";
import test from "node:test";

import { persistAssistantReplyOnce } from "../app/lib/merchant-memory/general-chat.server.js";

// Regression (2026-08-27, real conversation 5dd1a4e5-67c9-44b8-bb43-58cf67ad53a6): a merchant saw
// an error, retried, the retry appeared to hang, and reloading showed TWO real assistant replies
// to the same question — timestamps three seconds apart. retryLastGeneralChatReply's own
// "already answered?" check only protects against retrying an attempt that has already finished;
// it does nothing when the original attempt is still silently running when the retry starts (this
// session traced several real cases where a stalled client connection never resolves even though
// the backend completes the turn regardless). persistAssistantReplyOnce closes this at the actual
// write, using SERIALIZABLE isolation so Postgres itself refuses to let two concurrent callers
// both commit a reply for the same merchant turn.

const CONVERSATION = { id: "conv-1", merchantId: "m1", shopId: "s1" };
const SINCE_MESSAGE = { createdAt: new Date("2026-08-27T13:56:39.458Z") };

function baseAppendInput(overrides = {}) {
  return {
    conversation: CONVERSATION,
    conversationId: CONVERSATION.id,
    merchantId: CONVERSATION.merchantId,
    shopId: CONVERSATION.shopId,
    role: "assistant",
    content: "A real answer.",
    surface: "app",
    metadata: {},
    ...overrides,
  };
}

/**
 * Minimal mock Prisma. Deliberately omits merchantMemoryEpisode/backfillJob — both are
 * feature-detected (`tx.merchantMemoryEpisode?.upsert`, `tx.backfillJob?.findUnique`) inside
 * appendConversationMessage and skip cleanly when absent, so this stays focused on exactly the
 * concurrency behavior under test.
 */
function buildPrisma({ seedReplies = [], failFirstCreateWith = null, concurrentWinnerOnFailure = null } = {}) {
  const messages = [...seedReplies];
  let createAttempts = 0;
  const messageOps = {
    findFirst: async ({ where }) => {
      const matches = messages
        .filter(
          (m) =>
            m.conversationId === where.conversationId &&
            m.role === where.role &&
            (!where.createdAt?.gt || m.createdAt.getTime() > where.createdAt.gt.getTime()),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return matches[0] ?? null;
    },
    create: async ({ data }) => {
      createAttempts += 1;
      if (failFirstCreateWith && createAttempts === 1) {
        if (concurrentWinnerOnFailure) messages.push(concurrentWinnerOnFailure);
        const error = new Error(failFirstCreateWith.message ?? "could not serialize access due to concurrent update");
        if (failFirstCreateWith.code) /** @type {any} */ (error).code = failFirstCreateWith.code;
        throw error;
      }
      const row = {
        id: `msg-${messages.length + 1}`,
        createdAt: new Date(`2026-08-27T14:00:0${messages.length}.000Z`),
        ...data,
      };
      messages.push(row);
      return row;
    },
  };
  return {
    messages,
    createAttempts: () => createAttempts,
    merchantMemoryConversationMessage: messageOps,
    $transaction: async (callback, options) => {
      assert.equal(options?.isolationLevel, "Serializable", "must run the check-then-write at SERIALIZABLE isolation");
      return callback({ merchantMemoryConversationMessage: messageOps });
    },
  };
}

test("no race: the only caller persists the real reply", async () => {
  const prisma = buildPrisma();
  const result = await persistAssistantReplyOnce(prisma, { conversation: CONVERSATION, sinceMessage: SINCE_MESSAGE }, baseAppendInput());
  assert.equal(result.duplicate, false);
  assert.equal(result.message.content, "A real answer.");
  assert.equal(prisma.messages.length, 1);
});

test("a reply already exists at entry: returns it, does not write a second one", async () => {
  const existing = {
    id: "msg-existing",
    conversationId: CONVERSATION.id,
    role: "assistant",
    content: "Already answered.",
    createdAt: new Date("2026-08-27T13:56:51.599Z"),
  };
  const prisma = buildPrisma({ seedReplies: [existing] });
  const result = await persistAssistantReplyOnce(prisma, { conversation: CONVERSATION, sinceMessage: SINCE_MESSAGE }, baseAppendInput());
  assert.equal(result.duplicate, true);
  assert.equal(result.message.id, "msg-existing");
  assert.equal(prisma.createAttempts(), 0, "must not attempt to write once an existing reply is found");
});

test("genuine race: a concurrent writer commits first, this caller loses the SERIALIZABLE conflict and returns the winner instead of a duplicate", async () => {
  const winner = {
    id: "msg-winner",
    conversationId: CONVERSATION.id,
    role: "assistant",
    content: "The original attempt's real answer, which finished after this caller had already started.",
    createdAt: new Date("2026-08-27T13:56:51.599Z"),
  };
  const prisma = buildPrisma({
    failFirstCreateWith: { code: "40001", message: "could not serialize access due to concurrent update" },
    concurrentWinnerOnFailure: winner,
  });
  const result = await persistAssistantReplyOnce(prisma, { conversation: CONVERSATION, sinceMessage: SINCE_MESSAGE }, baseAppendInput());
  assert.equal(result.duplicate, true, "the loser of the race must report duplicate, not write its own second reply");
  assert.equal(result.message.id, "msg-winner");
  assert.equal(prisma.messages.length, 1, "exactly one assistant reply must exist — never two");
});

test("a non-serialization error is not swallowed as a race loss", async () => {
  const prisma = buildPrisma({ failFirstCreateWith: { message: "connection reset" } });
  await assert.rejects(
    persistAssistantReplyOnce(prisma, { conversation: CONVERSATION, sinceMessage: SINCE_MESSAGE }, baseAppendInput()),
    /connection reset/,
  );
});
