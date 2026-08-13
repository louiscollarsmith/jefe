import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Opening Jefe must always land on the conversation. The embedded app's URL is
// persistent (App Bridge restores the last location on re-open), so a move zoom the
// merchant left would silently re-open on a fresh entry — the bug Matt hit. These are
// source-level guards so a redesign can't quietly regress the behaviour.

const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const dailyHomeSource = fs.readFileSync(
  new URL("../app/components/daily-home.tsx", import.meta.url),
  "utf8",
);

test("a fresh app entry drops a stale ?actionChat and lands on the home conversation", () => {
  // A once-per-document-load guard distinguishes a fresh entry from in-session nav...
  assert.match(appIndexSource, /staleZoomGuardArmed/);
  // ...and on the daily home, when a zoom param is present, it clears it.
  assert.match(appIndexSource, /data\.appMode === "daily" && data\.actionChatId/);
  assert.match(appIndexSource, /appPathFromSearch\(location\.search, \{ actionChat: null \}\)/);
  // Client-only clock/location reads stay OUT of this route module (hydration lint).
  assert.doesNotMatch(appIndexSource, /\bwindow\./);
});

test("home-chat polish: single 'Thinking' indicator + wired prompt chips", () => {
  // The Send button is a plain disabled state — the thinking ROW is the only indicator,
  // so the merchant never sees "Thinking" twice at once.
  assert.doesNotMatch(dailyHomeSource, /\{isThinking \? "Thinking" : "Send"\}/);
  assert.match(dailyHomeSource, /<div style=\{thinkingStyle\}>Thinking<\/div>/);
  // Suggested openers under the home composer post the store-level chat.message intent.
  assert.match(dailyHomeSource, /function StorePrompt/);
  assert.match(dailyHomeSource, /<StorePrompt message=/);
});

test("chat replies preserve the reader's scroll position instead of jumping to the top", () => {
  assert.match(dailyHomeSource, /function usePreserveChatScrollDuringIntent/);
  assert.match(dailyHomeSource, /usePreserveChatScrollDuringIntent\(navigation, "chat\.message"\)/);
  assert.match(dailyHomeSource, /usePreserveChatScrollDuringIntent\(navigation, "chat\.retry"\)/);
  assert.match(dailyHomeSource, /usePreserveChatScrollDuringIntent\(navigation, "action\.chat\.message"\)/);
  assert.match(dailyHomeSource, /distanceFromDocumentBottom\(\) < 160/);
  assert.match(dailyHomeSource, /window\.scrollTo\(\{ top: snapshot\.y \}\)/);
  assert.match(dailyHomeSource, /preventScrollReset/);
  assert.doesNotMatch(dailyHomeSource, /window\.scrollTo\(\{ top: 0/);
});

test("the conversation index lists moments and scrolls the thread to them (not a thread swap)", () => {
  // A left-rail index built from real moments (executed/reported/declined actions + the
  // current move), each carrying the DOM id of its message so the rail can scroll to it.
  assert.match(dailyHomeSource, /function buildConversationIndex/);
  assert.match(dailyHomeSource, /function ConversationIndex/);
  assert.match(dailyHomeSource, /className="jefe-home-index"/);
  assert.match(dailyHomeSource, /anchorId=\{`moment-\$\{action\.actionRunId\}`\}/);
  // Wayfinding inside the one thread: scrollIntoView, never a navigate/URL change.
  assert.match(dailyHomeSource, /function scrollToMoment/);
  assert.match(dailyHomeSource, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.doesNotMatch(
    dailyHomeSource,
    /scrollToMoment[\s\S]{0,120}(navigate\(|window\.location)/,
  );
});
