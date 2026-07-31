import assert from "node:assert/strict";
import test from "node:test";
import {
  WEBHOOK_SLOW_MS,
  evaluateWebhookHealth,
  getWebhookHealth,
  maybeAlertWebhookHealth,
  recordWebhookOutcome,
  resetWebhookHealth,
} from "../app/lib/observability/webhook-health.server.js";

test("records outcomes into the window with success rate + slow count", () => {
  resetWebhookHealth();
  recordWebhookOutcome({ ok: true, ms: 200 });
  recordWebhookOutcome({ ok: true, ms: WEBHOOK_SLOW_MS + 500 }); // slow but ok
  recordWebhookOutcome({ ok: false, ms: 50 });
  const h = getWebhookHealth();
  assert.equal(h.received, 3);
  assert.equal(h.ok, 2);
  assert.equal(h.failed, 1);
  assert.equal(h.slow, 1);
  assert.equal(h.maxMs, WEBHOOK_SLOW_MS + 500);
  assert.ok(Math.abs(h.successRate - 2 / 3) < 1e-9);
});

test("resetWebhookHealth clears the window (empty window is healthy, rate 1)", () => {
  resetWebhookHealth();
  const h = getWebhookHealth();
  assert.equal(h.received, 0);
  assert.equal(h.successRate, 1);
});

test("evaluate: below minVolume never degrades, even with failures", () => {
  const health = { received: 5, ok: 1, failed: 4, slow: 0, maxMs: 10, successRate: 0.2, windowMs: 1000 };
  assert.deepEqual(evaluateWebhookHealth(health, { minVolume: 20 }), {
    degraded: false,
    reasons: [],
  });
});

test("evaluate: a real success-rate drop degrades with a reason", () => {
  const health = { received: 100, ok: 80, failed: 20, slow: 0, maxMs: 10, successRate: 0.8, windowMs: 1000 };
  const v = evaluateWebhookHealth(health, { minVolume: 20, minSuccessRate: 0.9 });
  assert.equal(v.degraded, true);
  assert.match(v.reasons.join(" "), /success rate 80%/);
});

test("evaluate: a slow-webhook spike degrades (delivery-timeout risk)", () => {
  const health = { received: 100, ok: 100, failed: 0, slow: 40, maxMs: 6200, successRate: 1, windowMs: 1000 };
  const v = evaluateWebhookHealth(health, { minVolume: 20, maxSlowRate: 0.25 });
  assert.equal(v.degraded, true);
  assert.match(v.reasons.join(" "), /40% slow/);
});

test("evaluate: a healthy busy window does not degrade", () => {
  const health = { received: 500, ok: 498, failed: 2, slow: 3, maxMs: 900, successRate: 0.996, windowMs: 1000 };
  assert.equal(evaluateWebhookHealth(health).degraded, false);
});

test("maybeAlertWebhookHealth respects the interval, pages a degraded window, then rolls", () => {
  resetWebhookHealth(1_000_000);
  // Interval not elapsed → no evaluation yet.
  assert.equal(maybeAlertWebhookHealth({ now: 1_000_000 + 60_000 }), false);
  for (let i = 0; i < 30; i += 1) recordWebhookOutcome({ ok: false, ms: 100 });
  const alerts = [];
  const logger = { error: (msg, ctx) => alerts.push({ msg, ctx }) };
  const evaluated = maybeAlertWebhookHealth({ now: 1_000_000 + 16 * 60_000, logger });
  assert.equal(evaluated, true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].ctx.reasons.join(" "), /success rate/);
  // Window rolled + interval clock reset.
  assert.equal(getWebhookHealth().received, 0);
  assert.equal(maybeAlertWebhookHealth({ now: 1_000_000 + 16 * 60_000 + 1000, logger }), false);
});

test("maybeAlertWebhookHealth stays silent on a healthy window", () => {
  resetWebhookHealth(2_000_000);
  for (let i = 0; i < 50; i += 1) recordWebhookOutcome({ ok: true, ms: 200 });
  const alerts = [];
  const evaluated = maybeAlertWebhookHealth({
    now: 2_000_000 + 16 * 60_000,
    logger: { error: (m, c) => alerts.push({ m, c }) },
  });
  assert.equal(evaluated, true);
  assert.equal(alerts.length, 0);
});
