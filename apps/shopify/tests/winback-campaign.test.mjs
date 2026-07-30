import assert from "node:assert/strict";
import test from "node:test";

// Signed feedback/unsubscribe links reuse this secret; set before rendering.
process.env.EMAIL_UNSUBSCRIBE_SECRET =
  process.env.EMAIL_UNSUBSCRIBE_SECRET || "test-email-unsubscribe-secret";

import {
  dueCampaignStep,
  campaignStopReason,
  renderWinBackCampaignEmail,
  isWinBackCampaignEnabled,
  WINBACK_EMAIL2_AFTER_DAYS,
  WINBACK_EMAIL3_AFTER_DAYS,
} from "../app/lib/email/winback-campaign.server.js";

const DAY = 86_400_000;
const now = new Date("2026-07-30T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * DAY);

// --- dueCampaignStep (the cadence gate) ---
test("dueCampaignStep: no Day-0 farewell → null (sequence never started)", () => {
  assert.equal(
    dueCampaignStep(
      { winbackEmailSentAt: null, winbackEmail2SentAt: null, winbackEmail3SentAt: null },
      now,
    ),
    null,
  );
});

test("dueCampaignStep: before the email-2 window → null", () => {
  assert.equal(
    dueCampaignStep(
      { winbackEmailSentAt: daysAgo(WINBACK_EMAIL2_AFTER_DAYS - 1), winbackEmail2SentAt: null, winbackEmail3SentAt: null },
      now,
    ),
    null,
  );
});

test("dueCampaignStep: email-2 due once the window passes", () => {
  assert.equal(
    dueCampaignStep(
      { winbackEmailSentAt: daysAgo(WINBACK_EMAIL2_AFTER_DAYS), winbackEmail2SentAt: null, winbackEmail3SentAt: null },
      now,
    ),
    2,
  );
});

test("dueCampaignStep: before the email-3 window → null", () => {
  assert.equal(
    dueCampaignStep(
      { winbackEmailSentAt: daysAgo(30), winbackEmail2SentAt: daysAgo(WINBACK_EMAIL3_AFTER_DAYS - 1), winbackEmail3SentAt: null },
      now,
    ),
    null,
  );
});

test("dueCampaignStep: email-3 due once its window passes", () => {
  assert.equal(
    dueCampaignStep(
      { winbackEmailSentAt: daysAgo(30), winbackEmail2SentAt: daysAgo(WINBACK_EMAIL3_AFTER_DAYS), winbackEmail3SentAt: null },
      now,
    ),
    3,
  );
});

test("dueCampaignStep: hard cap — email-3 already sent → null", () => {
  assert.equal(
    dueCampaignStep(
      { winbackEmailSentAt: daysAgo(30), winbackEmail2SentAt: daysAgo(20), winbackEmail3SentAt: daysAgo(10) },
      now,
    ),
    null,
  );
});

// --- campaignStopReason (the four exit conditions) ---
test("campaignStopReason: reinstall wins over everything", () => {
  assert.equal(
    campaignStopReason({ status: "active" }, { hasFeedback: true, isUnsubscribed: true }),
    "reinstalled",
  );
});

test("campaignStopReason: feedback stops the sequence", () => {
  assert.equal(
    campaignStopReason({ status: "uninstalled" }, { hasFeedback: true, isUnsubscribed: false }),
    "feedback",
  );
});

test("campaignStopReason: unsubscribe stops the sequence", () => {
  assert.equal(
    campaignStopReason({ status: "uninstalled" }, { hasFeedback: false, isUnsubscribed: true }),
    "unsubscribed",
  );
});

test("campaignStopReason: no exit condition → null (proceed)", () => {
  assert.equal(
    campaignStopReason({ status: "uninstalled" }, { hasFeedback: false, isUnsubscribed: false }),
    null,
  );
});

// --- renderWinBackCampaignEmail (templates + signed links) ---
test("renderWinBackCampaignEmail step 2: subject, copy, signed links, no leftover placeholders", () => {
  const r = renderWinBackCampaignEmail(2, {
    shopDomain: "wildflower-goods.myshopify.com",
    to: "sarah@wildflowergoods.com",
    storeName: "Wildflower Goods",
  });
  assert.equal(r.subject, "Still curious what made you leave");
  assert.match(r.html, /still a little curious/i);
  assert.match(r.html, /Wildflower Goods/);
  assert.match(r.html, /sarah@wildflowergoods\.com/);
  assert.match(r.html, /\/e\/unsubscribe\?t=/);
  assert.match(r.html, /\/e\/feedback\?t=/);
  assert.ok(!r.html.includes("{{"), "no unresolved template placeholders");
  assert.match(r.text, /still a little curious/i);
});

test("renderWinBackCampaignEmail step 3: last-note copy + reconnect CTA", () => {
  const r = renderWinBackCampaignEmail(3, {
    shopDomain: "wildflower-goods.myshopify.com",
    to: "sarah@wildflowergoods.com",
    storeName: "Wildflower Goods",
  });
  assert.equal(r.subject, "Last note from me");
  assert.match(r.html, /that's me done/i);
  assert.match(r.html, /Reconnect Jefe/);
  assert.ok(!r.html.includes("{{"), "no unresolved template placeholders");
  assert.match(r.text, /that's me done/i);
});

test("renderWinBackCampaignEmail: greeting falls back when no merchant name", () => {
  const r = renderWinBackCampaignEmail(2, { shopDomain: "x.myshopify.com", to: "a@b.com" });
  assert.match(r.html, /Right then/);
});

// --- the dark flag ---
test("isWinBackCampaignEnabled: default off; only 'true' enables", () => {
  const prev = process.env.ENABLE_WINBACK_CAMPAIGN;
  delete process.env.ENABLE_WINBACK_CAMPAIGN;
  assert.equal(isWinBackCampaignEnabled(), false);
  process.env.ENABLE_WINBACK_CAMPAIGN = "true";
  assert.equal(isWinBackCampaignEnabled(), true);
  process.env.ENABLE_WINBACK_CAMPAIGN = "false";
  assert.equal(isWinBackCampaignEnabled(), false);
  if (prev === undefined) delete process.env.ENABLE_WINBACK_CAMPAIGN;
  else process.env.ENABLE_WINBACK_CAMPAIGN = prev;
});
