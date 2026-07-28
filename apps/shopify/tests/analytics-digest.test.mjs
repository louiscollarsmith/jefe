import assert from "node:assert/strict";
import test from "node:test";
import { runActivityDigest } from "../app/services/analytics/digest.server.js";

const NOW = new Date("2026-07-28T22:00:00.000Z");

function fakePrisma(rows) {
  return {
    activityEvent: {
      async findMany() {
        return rows;
      },
    },
  };
}

function sampleRows() {
  return [
    { createdAt: new Date("2026-07-28T21:40:00.000Z"), type: "shop_installed", topic: "onboarding", shopDomain: "jaspers-market.myshopify.com" },
    { createdAt: new Date("2026-07-28T21:10:00.000Z"), type: "job_failed", topic: "reliability", shopDomain: "acme.myshopify.com" },
  ];
}

test("builds digest text from the event log without a webhook", async () => {
  const result = await runActivityDigest(fakePrisma(sampleRows()), { now: NOW });
  assert.equal(result.posted, false);
  assert.match(result.text, /Jefe activity/);
  assert.equal(result.feed.totalEvents, 2);
  assert.match(result.text, /Needs attention/); // job_failed is warn-severity
});

test("posts to Slack when a webhook is provided", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const result = await runActivityDigest(fakePrisma(sampleRows()), {
    now: NOW,
    webhookUrl: "https://hooks.slack.com/x",
    fetchImpl,
  });
  assert.equal(result.posted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Jefe activity/);
});

test("never throws when the Slack post fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  let result;
  await assert.doesNotReject(async () => {
    result = await runActivityDigest(fakePrisma(sampleRows()), {
      now: NOW,
      webhookUrl: "https://hooks.slack.com/x",
      fetchImpl,
    });
  });
  assert.equal(result.posted, false);
});

test("never throws when reading events fails", async () => {
  const prisma = {
    activityEvent: {
      async findMany() {
        throw new Error("db down");
      },
    },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await runActivityDigest(prisma, { now: NOW });
  });
  assert.equal(result.posted, false);
});
