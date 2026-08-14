import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Opening Jefe must always land on the focused-action home. The embedded app's URL is
// persistent (App Bridge restores the last location on re-open), so a chat the
// merchant left would silently re-open on a fresh entry. These are source-level
// guards so a redesign can't quietly regress the behaviour.

const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const dailyHomeSource = fs.readFileSync(
  new URL("../app/components/daily-home.tsx", import.meta.url),
  "utf8",
);
const clientNavigationReporterSource = fs.readFileSync(
  new URL("../app/components/client-navigation-reporter.tsx", import.meta.url),
  "utf8",
);

test("a fresh app entry drops stale chat params and lands on the focused-action home", () => {
  // A once-per-document-load guard distinguishes a fresh entry from in-session nav...
  assert.match(appIndexSource, /staleZoomGuardArmed/);
  // ...and on the daily home, when a persisted chat/chooser param is present, it clears it.
  assert.match(appIndexSource, /if \(data\.appMode === "daily"\)/);
  assert.match(
    appIndexSource,
    /params\.has\("actionChat"\)[\s\S]*params\.has\("conversation"\)[\s\S]*params\.has\("talkAction"\)/,
  );
  assert.match(
    appIndexSource,
    /appPathFromSearch\(location\.search,\s*\{\s*actionChat: null,\s*conversation: null,\s*talkAction: null,\s*\}\)/,
  );
  // Client-only clock/location reads stay OUT of this route module (hydration lint).
  assert.doesNotMatch(appIndexSource, /\bwindow\./);
});

test("focused-chat polish: single 'Thinking' indicator + wired action menu", () => {
  // The Send button is a plain disabled state — the thinking ROW is the only indicator,
  // so the merchant never sees "Thinking" twice at once.
  assert.doesNotMatch(dailyHomeSource, /\{isThinking \? "Thinking" : "Send"\}/);
  // ONE thinking row, whatever it says. Since 2026-08-13 it reads "Reading your file" while an
  // attachment is being read, so this asserts the count rather than the literal — the property
  // was never the word, it was that the merchant does not see two indicators at once.
  assert.equal(
    (dailyHomeSource.match(/style=\{thinkingStyle\}/g) ?? []).length,
    1,
    "exactly one thinking indicator",
  );
  assert.match(dailyHomeSource, /pendingAttachmentName \? "Reading your file" : "Thinking"/);
  // The plus menu is the way actions enter a chat: one action can become focus,
  // while other actions are added as read-only references.
  assert.match(dailyHomeSource, /function ActionAttachmentMenu/);
  assert.match(dailyHomeSource, /Work on an action/);
  assert.match(dailyHomeSource, /Reference an action/);
  assert.match(dailyHomeSource, /value="chat\.action\.reference"/);
});

test("chat replies preserve the reader's scroll position instead of jumping to the top", () => {
  assert.match(dailyHomeSource, /function usePreserveChatScrollDuringIntent/);
  assert.match(dailyHomeSource, /usePreserveChatScrollDuringIntent\(navigation, "chat\.message"\)/);
  assert.match(dailyHomeSource, /usePreserveChatScrollDuringIntent\(navigation, "chat\.retry"\)/);
  assert.doesNotMatch(dailyHomeSource, /usePreserveChatScrollDuringIntent\(navigation, "action\.chat\.message"\)/);
  assert.match(dailyHomeSource, /distanceFromDocumentBottom\(\) < 160/);
  assert.match(dailyHomeSource, /window\.scrollTo\(\{ top: snapshot\.y \}\)/);
  assert.match(dailyHomeSource, /preventScrollReset/);
  assert.doesNotMatch(dailyHomeSource, /window\.scrollTo\(\{ top: 0/);
});

test("the home uses action-centric navigation into focused chats", () => {
  assert.match(dailyHomeSource, /function FocusedActionsHome/);
  assert.match(dailyHomeSource, /function AttentionSpotlight/);
  assert.match(dailyHomeSource, /function TalkActionChooser/);
  assert.match(dailyHomeSource, /value="chat\.focus\.start"/);
  assert.match(dailyHomeSource, /conversation: conversation\.id/);
  assert.match(dailyHomeSource, /talkAction: null/);
  assert.match(dailyHomeSource, /conversation: chat\.id/);
});

test("home overlay navigations do not re-run the full app loader", () => {
  assert.match(appIndexSource, /function isAppHomeUiOnlyNavigation/);
  assert.match(appIndexSource, /function normalizeAppDataPath/);
  assert.match(appIndexSource, /pathname === "\/app\.data" \? "\/app" : pathname/);
  assert.match(appIndexSource, /"conversation", "talkAction", "actionChat"/);
  assert.match(appIndexSource, /!formData && isAppHomeUiOnlyNavigation\(currentUrl, nextUrl\)/);
  assert.doesNotMatch(appIndexSource, /changed\.every\(\(key\) => \["view", "conversation"/);
});

test("focused chat details load through narrow app-home resources", () => {
  assert.match(dailyHomeSource, /\/api\/app-home\/conversation\?conversationId=/);
  assert.match(dailyHomeSource, /\/api\/app-home\/action-chats\?actionId=/);
  assert.match(dailyHomeSource, /conversationCache/);
  assert.match(dailyHomeSource, /actionChatsCache/);
});

test("daily home reads merchant actions without syncing on every load", () => {
  assert.match(appIndexSource, /const merchantActionsPromise = listMerchantActions\(prisma, \{/);
  assert.match(appIndexSource, /includeInactive: true,\s*sync: false,/);
});

test("client navigation logging only labels real UI-param changes as overlays", () => {
  assert.match(clientNavigationReporterSource, /changed\.length > 0/);
  assert.match(
    clientNavigationReporterSource,
    /changed\.every\(\(key\) => \["conversation", "talkAction", "actionChat"\]\.includes\(key\)\)/,
  );
});
