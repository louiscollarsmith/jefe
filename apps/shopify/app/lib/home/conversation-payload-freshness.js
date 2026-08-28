// @ts-check

// Picks whichever of two conversation payloads is actually fresher — by message count —
// rather than trusting a fixed source-priority order.
//
// Regression (2026-08-27): openConversationPayload in daily-home.tsx used to resolve as
// `fetchedConversation ?? cachedConversation ?? loaderConversation`, an unconditional priority
// order. Each of those three sources refreshes on its own schedule (a background poll fetch, a
// client-side cache, and the route loader's own revalidation), so whichever one happened to sit
// first in that chain could easily be the STALEST of the three at the moment a chat.message
// submission finished — outranking an already-fresh source that had already revalidated with the
// merchant's new message and Jefe's reply. That produced a one-render flash of "I couldn't get to
// that one, try again" on a turn that never actually failed: navigation had gone idle (so the
// "still sending" state read false), but the resolved payload still ended on the merchant's own
// message because it came from the stale source. Comparing all sources by message count instead
// of by where they came from means a stale source can never outrank a fresher one, regardless of
// which one happens to update first.
//
// Pure, no I/O — unit-testable directly.

/**
 * @template {{ conversation: { messages?: unknown[] | null } } | null} T
 * @param {T} a
 * @param {T} b
 * @returns {T}
 */
export function freshestConversationPayload(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aCount = a.conversation.messages?.length ?? 0;
  const bCount = b.conversation.messages?.length ?? 0;
  return bCount > aCount ? b : a;
}
