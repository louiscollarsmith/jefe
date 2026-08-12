import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldReWelcomeOnReactivation } from "../app/lib/ingestion/shopify/tenant.server.js";

// The re-onboarding guard: a reinstall re-sends the Day-0 welcome ONLY when the
// last one is old enough to be a genuine return, not evaluation thrash.
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-12T12:00:00.000Z");

test("never re-welcomes a shop that was never welcomed", () => {
  assert.equal(shouldReWelcomeOnReactivation(null, NOW), false);
});

test("does NOT re-welcome inside the 30-day window (evaluation thrash)", () => {
  assert.equal(
    shouldReWelcomeOnReactivation(new Date(NOW.getTime() - 5 * DAY), NOW),
    false,
  );
});

test("does NOT re-welcome at exactly 30 days (window is strictly greater-than)", () => {
  assert.equal(
    shouldReWelcomeOnReactivation(new Date(NOW.getTime() - 30 * DAY), NOW),
    false,
  );
});

test("re-welcomes a genuine return (>30 days since the last welcome)", () => {
  assert.equal(
    shouldReWelcomeOnReactivation(new Date(NOW.getTime() - 45 * DAY), NOW),
    true,
  );
});

test("accepts an ISO-string timestamp, not only a Date", () => {
  assert.equal(
    shouldReWelcomeOnReactivation(
      new Date(NOW.getTime() - 60 * DAY).toISOString(),
      NOW,
    ),
    true,
  );
});
