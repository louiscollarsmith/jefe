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
  // (or their message appears twice while the retry runs). rawPendingMessage — the
  // chat-freeze-watchdog refactor's raw, pre-dedup form of the original pendingMessage — is what
  // carries this gate now; pendingMessage itself derives from isSending, not isSendingRaw/isRetrying
  // directly, but isSending can only ever be true when isSendingRaw already is.
  assert.match(dailyHome, /const isRetrying\s*=/);
  assert.match(dailyHome, /const isThinking = isSending \|\| isRetrying/);
  assert.match(dailyHome, /isSendingRaw && typeof navigation\.formData\?\.get\("message"\)/);
  // isSending covers an in-flight send from either source — the optimistic local state set on
  // click, or navigation.formData (chips, and file-only sends with no typed text) — and is only
  // false again once the reply has genuinely landed or the turn has settled.
  assert.match(dailyHome, /const isSending =\s*\n?\s*\(rawPendingMessage\.length > 0 \|\| isSendingRaw\) &&/);
});

test("the chat POST persists and returns immediately; the reply is generated in the background", () => {
  // Regression (2026-08-27), reported four times: "when I send a message it doesn't appear
  // instantly, it waits until the server responds." The POST used to persist the message, run a
  // 30-40s LLM turn, persist the reply, and only then return — one blocking HTTP lifecycle. The
  // transcript is server-rendered, so nothing the merchant said could reach the screen until that
  // whole round trip finished; every purely client-side attempt to bridge that gap was fighting
  // the fact that the authoritative transcript genuinely did not contain their message yet.
  // Persisting what they said is fast and certain; generating a reply is slow and fallible. Only
  // the first belongs in the request they are waiting on.
  const generalChat = read("app/lib/merchant-memory/general-chat.server.js");
  assert.match(generalChat, /export async function startGeneralChatTurn/);
  const startTurn = generalChat.slice(
    generalChat.indexOf("export async function startGeneralChatTurn"),
    generalChat.indexOf("async function setPendingReplyMarker"),
  );
  assert.ok(startTurn.length > 0, "could not locate startGeneralChatTurn");
  // Generation must NOT be awaited — awaiting it is the whole bug.
  assert.match(
    startTurn,
    /void sendGeneralChatMessage\(prisma, \{/,
    "reply generation must not block the response the merchant is waiting on",
  );
  assert.doesNotMatch(
    startTurn,
    /await sendGeneralChatMessage\(/,
    "awaiting generation here restores the blocking round trip this split exists to remove",
  );
  // Durable, server-owned progress marker, so "Jefe is still thinking" survives a reload and is
  // never guessed from elapsed time — and is cleared however generation ends, including a throw.
  assert.match(startTurn, /setPendingReplyMarker/);
  assert.match(startTurn, /\.finally\(/);
  assert.match(startTurn, /clearPendingReplyMarker/);
  assert.match(generalChat, /pendingReply: pendingReplyFromContext\(row\.context\)/);

  // The surface trusts that marker for Thinking, and polls until the reply lands.
  assert.match(dailyHome, /const replyInProgress = Boolean\(activeConversation\?\.pendingReply\)/);
  assert.match(dailyHome, /const isThinking = isSending \|\| isRetrying \|\| replyInProgress/);
  assert.match(dailyHome, /watchdogReplyPendingRef/);
});

test("the merchant's message renders the instant they press Send, not when the server replies", () => {
  // Regression (2026-08-27), reported directly: "when I send a message it doesn't display
  // instantly, it waits until the server responds to show my message." The optimistic bubble was
  // derived purely from navigation.formData, so whether the merchant's own words appeared at all
  // depended on React Router having already transitioned this route into a submitting state with
  // the form body attached — and when that lagged the click, nothing rendered until the server
  // came back, so their message showed up alongside Jefe's reply instead of ahead of it. The
  // message is now put on screen synchronously in the submit handler itself, as ordinary state,
  // which cannot lag a click. Desired shape is iMessage: message right, "Thinking" left, reply
  // replaces Thinking.
  assert.match(dailyHome, /const \[optimisticSend, setOptimisticSend\] = useState\(""\)/);
  const submitHandler = dailyHome.slice(
    dailyHome.indexOf("const handleComposerSubmit = () => {"),
    dailyHome.indexOf("if (!activeConversation) {"),
  );
  assert.ok(submitHandler.length > 0, "could not locate the composer submit handler");
  assert.match(
    submitHandler,
    /setOptimisticSend\(composerMessage\.trim\(\)\);/,
    "the merchant's message must be rendered from the submit event itself, never inferred from navigation timing",
  );
  // navigation.formData stays a SECOND source (chips submit their own Forms, and a file-only send
  // has no typed text) — but it must no longer be the only one.
  assert.match(dailyHome, /const rawPendingMessage = optimisticSend \|\| navPendingMessage;/);

  // The optimistic copy is cleared on evidence, never on a timer: only once the submission has
  // actually been seen starting (or the message is durably in the transcript) AND everything has
  // gone quiet. Clearing on timing alone would let the first render after the click — where
  // navigation may not have flipped yet — look identical to "all done" and wipe the message
  // straight back off screen.
  assert.match(dailyHome, /const \[sendObserved, setSendObserved\] = useState\(false\)/);
  const settled = dailyHome.slice(
    dailyHome.indexOf("const turnSettled ="),
    dailyHome.indexOf("const pendingAttachmentName"),
  );
  assert.ok(settled.length > 0, "could not locate the turn-settled derivation");
  assert.match(settled, /sendObserved \|\| optimisticSendLandedInTranscript/);
});

test("a mid-flight background refresh must not end the turn, hide Thinking, or fake a failure", () => {
  // Regression (2026-08-27), the one the merchant actually reported: send a message, and for
  // ~20 seconds the chat showed "I couldn't get to that one just now — your message is saved.
  // [Try again]" over a turn that was still running perfectly well, then the real reply replaced
  // it. Root cause: the turn-is-finished check treated "the merchant's own message is now in the
  // transcript" as completion. It never is — sendGeneralChatMessage persists the merchant's
  // message BEFORE calling the LLM (deliberately, so a failure leaves their words in the thread).
  // So when the chat-freeze watchdog's 20s poll landed mid-send against a ~40s turn, it saw that
  // just-persisted message, declared the round trip over, and dropped both the optimistic bubble
  // and the Thinking indicator — which satisfied every remaining condition for awaitingReply and
  // rendered the reply-failed row. Only an assistant reply after this exact merchant message may
  // end the turn.
  assert.match(dailyHome, /const replyLandedForPendingMessage =/);
  const completionStart = dailyHome.indexOf("const replyLandedForPendingMessage =");
  const completion = dailyHome.slice(
    completionStart,
    dailyHome.indexOf("const isSending =", completionStart),
  );
  assert.ok(completion.length > 0, "could not locate the turn-completion check");
  assert.match(
    completion,
    /lastRealMessage\?\.role === "assistant"/,
    "a turn may only be considered finished once an assistant reply exists",
  );
  assert.doesNotMatch(
    completion,
    /lastRealMessage\?\.role === "merchant"/,
    "the merchant's own persisted message must never be treated as the turn finishing — it is persisted before the LLM even runs",
  );

  // Hiding the duplicate optimistic bubble and ending the turn are now separate decisions; fusing
  // them is precisely what caused this. Thinking must survive the merchant's own message landing.
  assert.match(dailyHome, /const pendingMessageAlreadyVisible =/);
  assert.match(
    dailyHome,
    /const pendingMessage =\s*\n?\s*isSending && !pendingMessageAlreadyVisible \? rawPendingMessage : "";/,
  );

  // And the reply-failed row stays silent while any refresh is still in flight, so the window
  // between a send finishing and the fresh transcript arriving can't read as a failure either.
  assert.match(dailyHome, /!threadRefreshPending &&/);
  const awaiting = dailyHome.slice(
    dailyHome.indexOf("const awaitingReply ="),
    dailyHome.indexOf("const isBlankThread"),
  );
  assert.match(awaiting, /!isThinking &&/);
  assert.match(awaiting, /!threadRefreshPending &&/);
});

test("the loader hydrates the conversation the merchant actually has open", () => {
  // Regression (2026-08-27): getDailyChatExperience was called from the loader with no
  // conversationId, so for any open chat it returned { conversation: null, messages: [] } — the
  // loader never loaded the thread being chatted in. That disabled the one mechanism react-router
  // gives for free (a POST's automatic revalidation returning the fresh transcript as part of the
  // same submission), forcing every reply to be discovered through a separate client-side refetch
  // and leaving a multi-second window after each send where the newest transcript available still
  // ended on the merchant's own message — which reads as a failed turn.
  const start = appIndex.indexOf("const conversationPromise = getDailyChatExperience(prisma, {");
  const call = appIndex.slice(start, appIndex.indexOf("});", start));
  assert.ok(call.length > 0, "could not locate the daily-chat loader call");
  assert.match(
    call,
    /conversationId: url\.searchParams\.get\("conversation"\)/,
    "the loader must hydrate the open conversation so revalidation carries the reply",
  );
});

test("a stale cached conversation cannot flash the reply-failed row, and cannot blank the chat mid-send either", () => {
  // Regression (2026-08-27, first pass): a merchant briefly saw "I couldn't get to that one, try
  // again" right before the real reply appeared, on a request that never actually failed — a
  // pre-send-stale conversationCache entry outranked the already-fresh, just-revalidated loader
  // data in openConversationPayload's fallback chain for the one render before this effect's own
  // deferred cleanup ran. The first fix cleared the cache entry the moment a thread-mutating
  // submission STARTED rather than only once it finished — but that destroyed the only
  // known-good pre-send snapshot for any conversation reached via client-side navigation (one
  // that doesn't match the SSR loader's own props.conversation), so openConversationPayload fell
  // through to null and the whole chat view swapped to FocusedConversationLoading for the full
  // duration of every send: no pending message, no thinking indicator, nothing, until the
  // submission completed. Second pass (2026-08-27): the submission-start branch must not touch
  // the cache at all, and freshestConversationPayload must pick whichever of the cache and the
  // loader has more messages, so a stale cache entry can never outrank a fresher loader
  // regardless of timing — without ever deleting the pre-send snapshot mid-send.
  const startBranch = dailyHome.slice(
    dailyHome.indexOf("if (navigation.state !== \"idle\" && isThreadMutationIntent(intent)) {"),
    dailyHome.indexOf("if (navigation.state !== \"idle\") return;"),
  );
  assert.ok(startBranch.length > 0, "could not locate the thread-mutation-start branch to check");
  assert.doesNotMatch(
    startBranch,
    /setConversationCache/,
    "must not touch the conversation cache when a send starts — that destroys the only pre-send snapshot for conversations opened via client-side navigation",
  );
  assert.match(
    dailyHome,
    /import \{ freshestConversationPayload \} from "\.\.\/lib\/home\/conversation-payload-freshness\.js"/,
  );
  assert.match(dailyHome, /freshestConversationPayload\(cachedConversation, loaderConversation\)/);
});

test("the background-fetched conversation cannot outrank a fresher cache/loader payload either", () => {
  // Regression (2026-08-27, third pass — same underlying bug, second independent path): even
  // after the fix above, openConversationPayload still resolved as
  // `fetchedConversation ?? freshestConversationPayload(cachedConversation, loaderConversation)`
  // — fetchedConversation (conversationFetcher.data) was checked FIRST, unconditionally, ahead of
  // the freshness comparison. It's only populated once, at conversation-open time, and not
  // refreshed again until an explicit post-idle refetch (a real network round-trip) resolves. In
  // the window between navigation going idle with a fresh reply already in props.conversation and
  // that refetch completing, this stale open-time snapshot (still ending on the merchant's own
  // message) unconditionally outranked the already-fresh loaderConversation, flashing "Try Again"
  // on a turn that never failed. Fixed by folding the matched fetchedConversation into the SAME
  // freshest-by-message-count comparison as the other two sources, so no source — regardless of
  // where it came from — can outrank a fresher one.
  assert.doesNotMatch(
    dailyHome,
    /\(fetchedConversation\?\.conversation\.conversation\?\.id === openConversationId\s*\n\s*\? fetchedConversation\s*\n\s*: null\)\s*\?\?/,
    "fetchedConversation must not be given unconditional top priority ahead of the freshness comparison",
  );
  assert.match(dailyHome, /const matchedFetchedConversation =/);
  const matchedBranch = dailyHome.slice(
    dailyHome.indexOf("const matchedFetchedConversation ="),
    dailyHome.indexOf("const activeConversation = openConversationPayload"),
  );
  assert.match(
    matchedBranch,
    /fetchedConversation\?\.conversation\.conversation\?\.id === openConversationId\s*\n\s*\? fetchedConversation\s*\n\s*: null/,
  );
  assert.match(
    matchedBranch,
    /const openConversationPayload = freshestConversationPayload\(\s*\n\s*matchedFetchedConversation,\s*\n\s*freshestConversationPayload\(cachedConversation, loaderConversation\),\s*\n\s*\);/,
  );
});

test("retry targets the same path the composer posts into", () => {
  // The composer posts chat.message -> startGeneralChatTurn -> sendGeneralChatMessage. Retry MUST
  // land on the same generation path. Since 2026-08-27 the composer reaches it one level of
  // indirection away: startGeneralChatTurn persists the merchant's message, returns immediately,
  // and re-enters sendGeneralChatMessage in the background against the stored message — so the
  // two still converge, which is the property this pins.
  //
  // Asserted by slicing each branch's BODY rather than by a character window. The window was
  // widened twice on 2026-08-13 as the handler legitimately grew (attachment reading, then the
  // keep-file path) — a heuristic that has to be relaxed every time correct code is added is
  // measuring the wrong thing. The property is "this branch reaches that function", full stop.
  assert.match(branchBody(appIndex, "chat.message"), /startGeneralChatTurn/);
  const generalChat = read("app/lib/merchant-memory/general-chat.server.js");
  const startTurn = generalChat.slice(
    generalChat.indexOf("export async function startGeneralChatTurn"),
    generalChat.indexOf("async function setPendingReplyMarker"),
  );
  assert.ok(startTurn.length > 0, "could not locate startGeneralChatTurn");
  assert.match(
    startTurn,
    /sendGeneralChatMessage\(prisma, \{/,
    "the composer path must still reach the one shared generation path retry uses",
  );
  assert.match(
    startTurn,
    /reuseMessageId: persisted\.message\.id/,
    "background generation must answer the ALREADY-stored message, never append a second copy",
  );
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
