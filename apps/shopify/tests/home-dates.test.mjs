import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HOME_TIME_ZONE,
  computeHomeDateLabel,
  currentServerInstant,
  formatDateInZone,
  storeTimeZoneFromPayload,
} from "../app/lib/home/home-dates.js";

// The instant Matt hit: 23:30 UTC on 11 Aug. In London (BST, +1) it's already the
// 12th; in New York (EDT, -4) it's still the 11th. A pinned-timezone label renders
// the SAME text on server (UTC) and browser for a given store zone — which is the
// whole fix. This test asserts per-zone correctness at the straddle, so it fails if
// anyone reverts to a bare new Date()/unpinned toLocaleDateString (which would pass
// at midday and mismatch at midnight — worse than no test).
const STRADDLE = new Date("2026-08-11T23:30:00.000Z");

test("computeHomeDateLabel is timezone-pinned and correct per store zone at the midnight straddle", () => {
  const london = computeHomeDateLabel({ now: STRADDLE, timeZone: "Europe/London", locale: "en-GB" });
  assert.match(london, /Wednesday/);
  assert.match(london, /12/);
  assert.match(london, /August/);

  const newYork = computeHomeDateLabel({ now: STRADDLE, timeZone: "America/New_York", locale: "en-GB" });
  assert.match(newYork, /Tuesday/);
  assert.match(newYork, /11/);

  // Same instant, different store zone → different calendar day. That's the bug,
  // rendered correctly instead of mismatching.
  assert.notEqual(london, newYork);
});

test("computeHomeDateLabel falls back to the default zone (never throws, never viewer-local)", () => {
  const bad = computeHomeDateLabel({ now: STRADDLE, timeZone: "Not/AZone", locale: "en-GB" });
  const fallback = computeHomeDateLabel({ now: STRADDLE, timeZone: DEFAULT_HOME_TIME_ZONE, locale: "en-GB" });
  assert.equal(bad, fallback); // invalid zone → default, deterministically
  assert.equal(computeHomeDateLabel({ now: STRADDLE }), fallback); // no zone → default
});

test("formatDateInZone pins the zone for a fixed instant; empty for missing/invalid", () => {
  assert.match(formatDateInZone({ iso: "2026-08-11T23:30:00.000Z", timeZone: "Europe/London" }), /12 Aug/);
  assert.match(formatDateInZone({ iso: "2026-08-11T23:30:00.000Z", timeZone: "America/New_York" }), /11 Aug/);
  assert.equal(formatDateInZone({ iso: null }), "");
  assert.equal(formatDateInZone({ iso: "not-a-date" }), "");
});

test("currentServerInstant returns the current instant (the isolated, server-only clock read)", () => {
  const before = Date.now();
  const instant = currentServerInstant();
  const after = Date.now();
  assert.ok(instant instanceof Date);
  // It's the real clock, bounded by the two Date.now() readings around it.
  assert.ok(instant.getTime() >= before && instant.getTime() <= after);
});

test("storeTimeZoneFromPayload extracts the store zone, else null", () => {
  assert.equal(storeTimeZoneFromPayload({ shopify: { ianaTimezone: "America/Los_Angeles" } }), "America/Los_Angeles");
  assert.equal(storeTimeZoneFromPayload({ shopify: {} }), null);
  assert.equal(storeTimeZoneFromPayload({}), null);
  assert.equal(storeTimeZoneFromPayload(null), null);
});
