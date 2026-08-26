import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { buildActionRaise } from "../app/lib/actions/action-resolution.server.js";

// Jefe has one adapter and can talk about far more than it can execute, so MOST
// recommendations land on the non-executable branch. That branch rendered:
//
//   "This move is advisory until a typed action preview is available."
//
// Our vocabulary, framed as an absence, offering nothing to do — so the most common outcome
// read as a failed action rather than as advice. The no-dead-ends invariant says every
// recommendation either executes, asks for approval, or INSTRUCTS.
//
// Underneath it: buildEligibilityRecord has been writing modeReason / policyViolations /
// degradedFromAutonomous into the eligibility column — "here's what I couldn't do, and what
// you'd need to change" — and getActiveSuggestedAction never selected the column. Jefe worked
// out why it could not act, stored it, and dropped it one step before the merchant.

const dailyHome = fs.readFileSync(
  new URL("../app/components/daily-home.tsx", import.meta.url),
  "utf8",
);
const resolution = fs.readFileSync(
  new URL("../app/lib/actions/action-resolution.server.js", import.meta.url),
  "utf8",
);

test("the internal 'advisory until a typed action preview' line is no longer rendered", () => {
  // Ignore comment lines: the replacement quotes the old sentence to explain why it went, and
  // that documentation is worth keeping. What must not survive is the RENDERED string.
  const code = dailyHome
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /typed action preview/);
  // The raise/instruct-path note moved from the old FocusedActionDecisionRow
  // (removed in the conversation-first Action Chat redesign) into
  // ActionChatHeader, but the underlying no-dead-ends guarantee is unchanged.
  assert.match(code, /function ActionChatHeader/);
  assert.match(code, /action\.raise\.reason/);
});

test("a non-executable move still says something the merchant can act on", () => {
  // The fallback must be a position, not an absence — no "unavailable", no "not supported".
  const fallback = /Accepting the plan does not write to Shopify/;
  assert.match(dailyHome, fallback);
});

test("the raise payload is actually read back from the database", () => {
  // The whole defect was a column that was written and never selected.
  assert.match(resolution, /eligibility: true/);
  assert.match(resolution, /raise: buildActionRaise\(row\.eligibility\)/);
});

test("a merchant's own cap is named, because it is the thing they can change", () => {
  const raise = buildActionRaise({
    policyViolations: ["max 20 products per run"],
    degradedFromAutonomous: true,
  });
  assert.ok(raise);
  assert.match(raise.reason, /limit you set/i);
  assert.equal(raise.detail, "max 20 products per run");
});

test("a degraded autonomous run explains itself without blaming the merchant", () => {
  const raise = buildActionRaise({ degradedFromAutonomous: true, policyViolations: [] });
  assert.ok(raise);
  assert.match(raise.reason, /couldn't be confident enough/i);
  assert.equal(raise.detail, null);
});

test("an irreversible action says so plainly", () => {
  const raise = buildActionRaise({ reversible: false });
  assert.ok(raise);
  assert.match(raise.reason, /can't undo/i);
});

test("no reason is null, never a fabricated one", () => {
  // Jefe must not invent a cause it does not have — the surface has a general line for this.
  assert.equal(buildActionRaise(null), null);
  assert.equal(buildActionRaise(undefined), null);
  assert.equal(buildActionRaise({}), null);
  assert.equal(buildActionRaise({ autoEligible: true, reversible: true }), null);
  assert.equal(buildActionRaise("not an object"), null);
});

test("a malformed policyViolations list cannot leak junk into the sentence", () => {
  const raise = buildActionRaise({ policyViolations: [null, "", 42, "a real cap"] });
  assert.ok(raise);
  assert.equal(raise.detail, "a real cap");
});
