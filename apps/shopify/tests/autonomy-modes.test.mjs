import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_MODES,
  isActionMode,
  displayMode,
} from "../app/components/settings/autonomy-modes.js";

// Locks the founder ruling (2026-08-12, AGENTS.md): the autonomy dial offers exactly TWO modes.
// `recommend` was retired as a selectable mode; a third mode must never creep back into the dial.

test("the autonomy dial offers exactly two modes — approve_execute + autonomous, never recommend", () => {
  assert.deepEqual([...ACTION_MODES], ["approve_execute", "autonomous"]);
  assert.equal(ACTION_MODES.includes("recommend"), false);
  assert.equal(ACTION_MODES.length, 2);
});

test("isActionMode accepts the two selectable modes, rejects recommend and anything else", () => {
  assert.equal(isActionMode("approve_execute"), true);
  assert.equal(isActionMode("autonomous"), true);
  assert.equal(isActionMode("recommend"), false);
  assert.equal(isActionMode("garbage"), false);
});

test("displayMode coerces a legacy recommend to the safe default, passes valid modes, nulls the rest", () => {
  assert.equal(displayMode("recommend"), "approve_execute");
  assert.equal(displayMode("approve_execute"), "approve_execute");
  assert.equal(displayMode("autonomous"), "autonomous");
  assert.equal(displayMode(undefined), null);
  assert.equal(displayMode(null), null);
  assert.equal(displayMode("garbage"), null);
});
