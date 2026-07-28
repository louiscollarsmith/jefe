import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUsageReport,
  formatUsageReport,
  pct,
} from "../app/services/analytics/usage-report.server.js";

function sampleInput(overrides = {}) {
  return {
    generatedAt: "2026-07-28T12:00:00.000Z",
    windowDays: 7,
    merchants: 100,
    shops: {
      total: 100,
      setupStatus: { installed: 20, backfill_running: 10, ready: 70 },
      backfillStarted: 80,
      backfillCompleted: 60,
      onboardingCompleted: 40,
      installedInWindow: 12,
    },
    channels: { connected: 25, not_connected: 30, needs_configuration: 5 },
    memory: { totalBeliefs: 900, merchantsWithBeliefs: 60 },
    generation: {
      insights: { completed: 55, failed: 5 },
      goals: { completed: 40 },
      plan: { completed: 38, failed: 2 },
    },
    jobs: { queued: 3, running: 1, succeeded: 200, failed: 4 },
    activity: { activeInWindow: 45 },
    ...overrides,
  };
}

test("pct rounds to one decimal and guards divide-by-zero", () => {
  assert.equal(pct(40, 100), 40);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(5, 0), 0);
});

test("funnel reports counts, share of installed, and step conversion", () => {
  const report = buildUsageReport(sampleInput());
  assert.deepEqual(
    report.funnel.map((s) => [s.stage, s.count, s.pctOfInstalled, s.stepConversionPct]),
    [
      ["installed", 100, 100, null],
      ["backfill_started", 80, 80, 80],
      ["backfill_completed", 60, 60, 75],
      ["onboarding_completed", 40, 40, 66.7],
    ],
  );
});

test("identifies the biggest single-step drop-off by merchants lost", () => {
  const report = buildUsageReport(sampleInput());
  // Losses: 100->80 = 20, 80->60 = 20, 60->40 = 20. First max wins.
  assert.equal(report.biggestDropOff.from, "installed");
  assert.equal(report.biggestDropOff.to, "backfill_started");
  assert.equal(report.biggestDropOff.lostCount, 20);

  const skewed = buildUsageReport(
    sampleInput({
      shops: {
        total: 100,
        setupStatus: {},
        backfillStarted: 95,
        backfillCompleted: 50,
        onboardingCompleted: 45,
        installedInWindow: 0,
      },
    }),
  );
  assert.equal(skewed.biggestDropOff.from, "backfill_started");
  assert.equal(skewed.biggestDropOff.to, "backfill_completed");
  assert.equal(skewed.biggestDropOff.lostCount, 45);
});

test("counts connected channels, excluding disconnected statuses", () => {
  const report = buildUsageReport(sampleInput());
  // connected (25) + needs_configuration (5) count; not_connected (30) excluded.
  assert.equal(report.engagement.channelConnections, 30);
});

test("computes generation failure rates per feature", () => {
  const report = buildUsageReport(sampleInput());
  assert.equal(report.generationHealth.insights.total, 60);
  assert.equal(report.generationHealth.insights.failed, 5);
  assert.equal(report.generationHealth.insights.failureRatePct, 8.3);
  assert.equal(report.generationHealth.goals.failureRatePct, 0);
});

test("computes engagement aggregates", () => {
  const report = buildUsageReport(sampleInput());
  assert.equal(report.engagement.activeInWindow, 45);
  assert.equal(report.engagement.activePctOfInstalled, 45);
  assert.equal(report.engagement.merchantsWithMemory, 60);
  assert.equal(report.engagement.avgBeliefsPerMemoryMerchant, 15);
});

test("handles an empty dataset without dividing by zero", () => {
  const report = buildUsageReport({
    generatedAt: "2026-07-28T12:00:00.000Z",
    windowDays: 7,
    merchants: 0,
    shops: {
      total: 0,
      setupStatus: {},
      backfillStarted: 0,
      backfillCompleted: 0,
      onboardingCompleted: 0,
      installedInWindow: 0,
    },
    channels: {},
    memory: { totalBeliefs: 0, merchantsWithBeliefs: 0 },
    generation: { insights: {}, goals: {}, plan: {} },
    jobs: {},
    activity: { activeInWindow: 0 },
  });
  assert.equal(report.funnel[0].pctOfInstalled, 0);
  assert.equal(report.engagement.avgBeliefsPerMemoryMerchant, 0);
  assert.equal(report.generationHealth.plan.failureRatePct, 0);
});

test("formatUsageReport renders the key sections as text", () => {
  const text = formatUsageReport(buildUsageReport(sampleInput()));
  assert.match(text, /Onboarding funnel/);
  assert.match(text, /Engagement/);
  assert.match(text, /Generation health/);
  assert.match(text, /Job queue/);
  assert.match(text, /onboarding_completed/);
});
