import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import { retryLastGeneralChatReply } from "../app/lib/merchant-memory/general-chat.server.js";

// The chat-failure fix was landed once (931a54c) and silently lost its UI half in the #81
// merge: the server kept returning {ok:false} and the route kept handling chat.retry, but
// daily-home.tsx no longer rendered either, so a failed message showed nothing again.
//
// tests/daily-chat-retry.test.mjs stayed GREEN throughout, because it exercises the server
// functions. That is the blind spot these close. Two halves have to hold together:
//   1. the surface renders a failure and a retry control, and
//   2. the retry targets the SAME conversation the composer posts into.
// Since #81 that is the general-chat conversation, not the memory topic. Pointed at the
// wrong one, retry silently reports "nothing to retry" — worse than having no button.

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const dailyHome = read("app/components/daily-home.tsx");
const appIndex = read("app/routes/app._index.tsx");

test("the home renders a failed reply and offers a retry", () => {
  assert.match(dailyHome, /ReplyFailedRow/);
  assert.match(dailyHome, /name="intent" value="chat\.retry"/);
  assert.match(dailyHome, /Try again/);
  // Derived from the thread, not from the action result — so it survives a reload.
  assert.match(dailyHome, /awaitingReply/);
  assert.match(dailyHome, /lastMessage\?\.role === "merchant"/);
});

test("a retry does not re-render the merchant's text as pending", () => {
  // isThinking must cover retry (so the thinking line shows) while pendingMessage must not
  // (or their message appears twice while the retry runs).
  assert.match(dailyHome, /const isRetrying\s*=/);
  assert.match(dailyHome, /const isThinking = isSending \|\| isRetrying/);
  assert.match(dailyHome, /isSending && typeof navigation\.formData\?\.get\("message"\)/);
});

test("retry targets the same path the composer posts into", () => {
  // The composer posts chat.message -> sendGeneralChatMessage. Retry MUST follow it.
  //
  // Asserted by slicing each branch's BODY rather than by a character window. The window was
  // widened twice on 2026-08-13 as the handler legitimately grew (attachment reading, then the
  // keep-file path) — a heuristic that has to be relaxed every time correct code is added is
  // measuring the wrong thing. The property is "this branch reaches that function", full stop.
  assert.match(branchBody(appIndex, "chat.message"), /sendGeneralChatMessage/);
  assert.match(branchBody(appIndex, "chat.retry"), /retryLastGeneralChatReply/);
  // The pre-#81 target answered the memory-topic conversation and would no-op here.
  assert.doesNotMatch(branchBody(appIndex, "chat.retry"), /retryLastConversationReply/);
});

/**
 * The source of one `if (intent === "x")` branch: from its test to the start of the next
 * intent branch. Growth-proof, and it cannot accidentally match a neighbouring handler.
 */
function branchBody(source, intent) {
  const start = source.indexOf(`intent === "${intent}"`);
  assert.notEqual(start, -1, `no branch found for ${intent}`);
  const next = source.indexOf('if (intent === "', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

// --- the no-op branches, which are what stop a retry doing damage ---

function buildPrisma({ messages = [] } = {}) {
  const conversation = {
    id: "conv-general",
    merchantId: "m1",
    shopId: "s1",
    topic: "general",
    conversationType: "general",
    status: "active",
    context: {},
  };
  return {
    calls: [],
    merchantMemoryConversation: {
      findFirst: async () => conversation,
      create: async () => conversation,
      update: async () => conversation,
    },
    merchantMemoryConversationMessage: {
      findFirst: async ({ where, orderBy }) => {
        const rows = messages.filter(
          (m) =>
            m.conversationId === where.conversationId &&
            (where.visibility === undefined || m.visibility === where.visibility),
        );
        if (Array.isArray(orderBy)) return [...rows].reverse()[0] ?? null;
        return rows[0] ?? null;
      },
      findMany: async () => messages,
    },
  };
}

const row = (over) => ({
  id: "msg-1",
  conversationId: "conv-general",
  merchantId: "m1",
  shopId: "s1",
  role: "merchant",
  content: "how are my margins?",
  visibility: "current",
  createdAt: new Date("2026-08-12T17:00:00.000Z"),
  ...over,
});

test("retrying a thread Jefe has already answered is a no-op", async () => {
  const prisma = buildPrisma({
    messages: [row({ id: "m-ask" }), row({ id: "m-answer", role: "assistant", content: "Here you go." })],
  });
  const result = await retryLastGeneralChatReply(prisma, { merchantId: "m1", shopId: "s1" });
  assert.equal(result.ok, true);
  // A double-tapped Retry, or one clicked in a stale tab, must not append a second reply.
  assert.equal(result.retried, false);
});

test("retrying an empty thread is harmless", async () => {
  const prisma = buildPrisma();
  const result = await retryLastGeneralChatReply(prisma, { merchantId: "m1", shopId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.retried, false);
});
