import assert from "node:assert/strict";
import test from "node:test";

import { freshestConversationPayload } from "../app/lib/home/conversation-payload-freshness.js";

// Regression (2026-08-27): openConversationPayload in daily-home.tsx used to resolve
// fetchedConversation ?? freshestConversationPayload(cachedConversation, loaderConversation) — a
// fixed source-priority order that gave the background-poll fetch unconditional top priority
// regardless of whether it was actually the freshest of the three. A merchant could send a
// message, have it persist and get a reply (the original HTTP request succeeded end to end), and
// still briefly see "I couldn't get to that one, try again" — because the stale open-time
// snapshot in conversationFetcher.data still ended on their own message and outranked an
// already-revalidated loader that had the real reply. Folding all three sources into the same
// freshest-by-message-count comparison closes that.

function payload(messageCount) {
  return {
    conversation: {
      conversation: { id: "conv-1" },
      messages: Array.from({ length: messageCount }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? "merchant" : "assistant",
        content: `message ${i}`,
      })),
    },
    libraryFiles: [],
  };
}

test("loader wins when the fetched conversation is stale (fewer messages)", () => {
  const fetched = payload(3); // pre-send snapshot: no new merchant message, no reply
  const loader = payload(5); // revalidated: merchant message + reply landed
  const result = freshestConversationPayload(fetched, loader);
  assert.equal(result, loader);
  assert.equal(result.conversation.messages.length, 5);
});

test("fetched conversation wins when it is newer than the loader", () => {
  const loader = payload(3); // the SSR loader's own props.conversation, not yet revalidated
  const fetched = payload(6); // an explicit background refetch that landed first
  const result = freshestConversationPayload(fetched, loader);
  assert.equal(result, fetched);
  assert.equal(result.conversation.messages.length, 6);
});

test("cached conversation wins when it is the newest of the three", () => {
  const fetched = payload(2);
  const loader = payload(2);
  const cached = payload(4);
  // Mirrors the real call site: freshestConversationPayload(fetched, freshestConversationPayload(cached, loader))
  const result = freshestConversationPayload(fetched, freshestConversationPayload(cached, loader));
  assert.equal(result, cached);
  assert.equal(result.conversation.messages.length, 4);
});

test("a post-send stale fetched snapshot ending on the merchant message cannot outrank a loader that already has the reply", () => {
  // The exact false-failure scenario: the merchant's send has fully completed (persisted +
  // replied) and the loader has revalidated, but conversationFetcher.data still holds whatever it
  // last fetched at conversation-open time, before this turn existed.
  const staleFetchedEndingOnMerchant = payload(3); // 0:merchant 1:assistant 2:merchant — no reply yet
  const freshLoaderWithReply = payload(4); // 0:merchant 1:assistant 2:merchant 3:assistant — replied
  const result = freshestConversationPayload(staleFetchedEndingOnMerchant, freshLoaderWithReply);
  assert.equal(result, freshLoaderWithReply);
  const messages = result.conversation.messages;
  const lastMessage = messages[messages.length - 1];
  // This is exactly what daily-home.tsx's awaitingReply check reads — if this were still the
  // stale payload, lastMessage.role would be "merchant" and Try Again would render.
  assert.equal(lastMessage.role, "assistant");
});

test("null on either side falls back to whichever payload exists", () => {
  const only = payload(2);
  assert.equal(freshestConversationPayload(null, only), only);
  assert.equal(freshestConversationPayload(only, null), only);
  assert.equal(freshestConversationPayload(null, null), null);
});

test("equal message counts keep the first argument (stable, arbitrary tie-break)", () => {
  const a = payload(3);
  const b = payload(3);
  assert.equal(freshestConversationPayload(a, b), a);
});
