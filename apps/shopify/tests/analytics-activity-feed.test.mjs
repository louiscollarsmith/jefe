import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityFeed,
  formatActivityDigest,
} from "../app/services/analytics/activity-feed.server.js";

const NOW = new Date("2026-07-28T22:00:00.000Z");

function sampleEvents() {
  return [
    { ts: "2026-07-28T21:40:00.000Z", type: "shop_installed", shopDomain: "jaspers-market.myshopify.com" },
    { ts: "2026-07-28T21:22:00.000Z", type: "memory_rebuilt", shopDomain: "northwind.myshopify.com" },
    { ts: "2026-07-28T20:58:00.000Z", type: "generation_failed", shopDomain: "acme.myshopify.com", detail: "plan" },
    { ts: "2026-07-28T19:30:00.000Z", type: "onboarding_completed", shopDomain: "jaspers-market.myshopify.com" },
    // Outside the 24h window — must be excluded.
    { ts: "2026-07-26T10:00:00.000Z", type: "shop_installed", shopDomain: "old-store.myshopify.com" },
  ];
}

test("buildActivityFeed keeps only in-window events, newest first", () => {
  const feed = buildActivityFeed(sampleEvents(), { now: NOW, windowHours: 24 });
  assert.equal(feed.totalEvents, 4);
  assert.equal(feed.events[0].type, "shop_installed"); // 21:40, newest
  assert.equal(feed.events[0].shopDomain, "jaspers-market.myshopify.com");
  assert.ok(!feed.events.some((e) => e.shopDomain === "old-store.myshopify.com"));
});

test("counts by type and distinct active shops", () => {
  const feed = buildActivityFeed(sampleEvents(), { now: NOW, windowHours: 24 });
  assert.deepEqual(feed.byType, {
    shop_installed: 1,
    memory_rebuilt: 1,
    generation_failed: 1,
    onboarding_completed: 1,
  });
  // jaspers (x2), northwind, acme => 3 distinct
  assert.equal(feed.activeShops, 3);
});

test("surfaces warn-severity events under attention", () => {
  const feed = buildActivityFeed(sampleEvents(), { now: NOW, windowHours: 24 });
  assert.equal(feed.attention.length, 1);
  assert.equal(feed.attention[0].type, "generation_failed");
  assert.equal(feed.attention[0].detail, "plan");
});

test("a narrower window excludes older in-window events", () => {
  const feed = buildActivityFeed(sampleEvents(), { now: NOW, windowHours: 1 });
  // Only events since 21:00 => 21:40 install + 21:22 memory
  assert.equal(feed.totalEvents, 2);
});

test("formatActivityDigest renders header, summary, attention and recent", () => {
  const feed = buildActivityFeed(sampleEvents(), { now: NOW, windowHours: 24 });
  const text = formatActivityDigest(feed);
  assert.match(text, /Jefe activity — last 24h/);
  assert.match(text, /4 events across 3 shops/);
  assert.match(text, /Needs attention \(1\)/);
  assert.match(text, /generation failed \(plan\)/);
  assert.match(text, /Recent/);
  assert.match(text, /jaspers-market\.myshopify\.com/);
});

test("empty window renders a clean no-activity message", () => {
  const feed = buildActivityFeed([], { now: NOW, windowHours: 24 });
  const text = formatActivityDigest(feed);
  assert.match(text, /No activity in the window/);
  assert.equal(feed.totalEvents, 0);
});
