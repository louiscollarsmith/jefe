import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKFILL_WINDOW_MONTHS,
  DEFAULT_BACKFILL_DAYS,
  MAX_BACKFILL_DAYS,
  MAX_BACKFILL_MONTHS,
  monthsToDays,
} from "../app/lib/shopify/backfill-window.server.js";
import { buildOrdersBackfillQueryFilter } from "../app/lib/shopify/queries.server.js";

test("backfill window config derives days from months and defaults to 24 months", () => {
  assert.equal(monthsToDays(24), 731); // round(24 * 30.44)
  assert.equal(monthsToDays(12), 365);
  assert.equal(BACKFILL_WINDOW_MONTHS, 24);
  assert.equal(DEFAULT_BACKFILL_DAYS, monthsToDays(24));
  assert.ok(MAX_BACKFILL_MONTHS >= BACKFILL_WINDOW_MONTHS);
  assert.equal(MAX_BACKFILL_DAYS, monthsToDays(MAX_BACKFILL_MONTHS));
});

test("orders backfill query filter clamps to the configured max window", () => {
  // A huge request is clamped to the ceiling, not an unbounded date.
  const clamped = buildOrdersBackfillQueryFilter(10_000_000);
  const atMax = buildOrdersBackfillQueryFilter(MAX_BACKFILL_DAYS);
  assert.equal(clamped, atMax);
  // Days below the ceiling pass through unchanged (30d window != the max).
  const recent = buildOrdersBackfillQueryFilter(30);
  assert.notEqual(recent, atMax);
  // Filter shape is a created_at lower bound.
  assert.match(clamped, /^created_at:>=\d{4}-\d{2}-\d{2}$/);
});
