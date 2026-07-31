import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateInboundEmailHealth,
  getInboundEmailHealth,
  maybeAlertInboundEmailHealth,
  recordInboundEmailOutcome,
  resetInboundEmailHealth,
} from "../app/lib/email/inbound/health.server.js";

test("a fresh window reports a clean snapshot", () => {
  resetInboundEmailHealth(1000);
  const h = getInboundEmailHealth(1000);
  assert.equal(h.received, 0);
  assert.equal(h.successRate, 1);
});

test("outcomes accumulate; parked is counted but excluded from success rate", () => {
  resetInboundEmailHealth(0);
  recordInboundEmailOutcome({ outcome: "replied", ms: 20 });
  recordInboundEmailOutcome({ outcome: "forwarded", ms: 15 });
  recordInboundEmailOutcome({ outcome: "parked" }); // not a fault
  recordInboundEmailOutcome({ outcome: "failed", ms: 5 });
  const h = getInboundEmailHealth();
  assert.equal(h.received, 4);
  assert.equal(h.replied, 1);
  assert.equal(h.forwarded, 1);
  assert.equal(h.parked, 1);
  assert.equal(h.failed, 1);
  // actioned = replied + forwarded + failed = 3; success = 2/3
  assert.ok(Math.abs(h.successRate - 2 / 3) < 1e-9);
});

test("evaluate does not flag below the minimum actioned volume", () => {
  resetInboundEmailHealth(0);
  recordInboundEmailOutcome({ outcome: "failed" });
  const verdict = evaluateInboundEmailHealth(getInboundEmailHealth(), { minVolume: 10 });
  assert.equal(verdict.degraded, false);
});

test("evaluate flags a sustained low success rate over the volume floor", () => {
  resetInboundEmailHealth(0);
  for (let i = 0; i < 8; i += 1) recordInboundEmailOutcome({ outcome: "failed" });
  for (let i = 0; i < 4; i += 1) recordInboundEmailOutcome({ outcome: "replied" });
  const verdict = evaluateInboundEmailHealth(getInboundEmailHealth(), { minVolume: 10, minSuccessRate: 0.9 });
  assert.equal(verdict.degraded, true);
  assert.match(verdict.reasons[0], /success rate/);
});

test("maybeAlert only evaluates once per interval and rolls the window", () => {
  resetInboundEmailHealth(0);
  for (let i = 0; i < 12; i += 1) recordInboundEmailOutcome({ outcome: "failed" });
  const errors = [];
  const logger = { error: (msg, ctx) => errors.push({ msg, ctx }) };

  // Not enough time elapsed since reset → no evaluation.
  assert.equal(maybeAlertInboundEmailHealth({ logger, now: 60_000 }), false);
  // Past the interval → evaluates, pages, and rolls.
  assert.equal(maybeAlertInboundEmailHealth({ logger, now: 16 * 60_000 }), true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /Inbound email health degraded/);
  assert.equal(getInboundEmailHealth(16 * 60_000).received, 0, "window rolled");
});
