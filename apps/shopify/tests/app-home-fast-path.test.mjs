import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appIndex = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const conversationRoute = fs.readFileSync(
  new URL("../app/routes/api.app-home.conversation.tsx", import.meta.url),
  "utf8",
);
const actionChatsRoute = fs.readFileSync(
  new URL("../app/routes/api.app-home.action-chats.tsx", import.meta.url),
  "utf8",
);

test("the daily loader no longer loads full memory or unused daily panels", () => {
  const dailyBranch = branchBody(appIndex, 'appMode: "daily"');
  assert.doesNotMatch(dailyBranch, /getMerchantMemoryView/);
  assert.doesNotMatch(dailyBranch, /getLatestMerchantInsights/);
  assert.doesNotMatch(dailyBranch, /getOpenQuestions/);
  assert.doesNotMatch(dailyBranch, /getLatestHorizon/);
  assert.doesNotMatch(dailyBranch, /loadAppHomeWhatsNew/);
  assert.doesNotMatch(dailyBranch, /getNotificationPreference/);
  assert.doesNotMatch(dailyBranch, /listMerchantFilePicks/);
  assert.match(dailyBranch, /getDailyChatExperience/);
  assert.match(dailyBranch, /historyTake: 8/);
});

test("narrow app-home resource routes authenticate and tenant-scope their reads", () => {
  for (const source of [conversationRoute, actionChatsRoute]) {
    assert.match(source, /authenticateAppRequest\(request\)/);
    assert.match(source, /resolveShopifyTenantForRequest/);
    assert.match(source, /merchantId: merchant\.id/);
    assert.match(source, /shopId: shop\.id/);
    assert.match(source, /Cache-Control": "no-store"/);
  }
  assert.match(conversationRoute, /getDailyChatThread/);
  assert.match(conversationRoute, /listMerchantFilePicks/);
  assert.match(actionChatsRoute, /listChatsFocusedOnAction/);
  assert.match(actionChatsRoute, /getMerchantActionFocus/);
});

test("focused-chat start is a typed narrow POST instead of a home-route action", () => {
  assert.match(actionChatsRoute, /export async function action/);
  assert.match(actionChatsRoute, /startFocusedActionChat/);
  assert.match(actionChatsRoute, /chooser: true, chats: result\.chats/);
  assert.match(
    actionChatsRoute,
    /chooser: false,[\s\S]*conversationId: result\.conversationId/,
  );
  assert.match(actionChatsRoute, /ok: false, actionId, error: result\.error/);
  assert.doesNotMatch(appIndex, /if \(intent === "chat\.focus\.start"\)/);
});

function branchBody(source, marker) {
  const end = source.indexOf(marker);
  assert.notEqual(end, -1, `no marker found for ${marker}`);
  const start = source.lastIndexOf("if (", end);
  assert.notEqual(start, -1, `no branch found before ${marker}`);
  const next = source.indexOf("if (", end);
  return source.slice(start, next === -1 ? source.length : next);
}
