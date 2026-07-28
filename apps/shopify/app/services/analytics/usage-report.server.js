// @ts-check

/**
 * Usage analytics — the pure reporting core.
 *
 * This module answers "how are clients using Jefe?" and "where do they drop
 * off?" from data the app already stores (Shop setup/onboarding state, channel
 * connections, generation runs, memory beliefs, the job queue). It performs NO
 * I/O: the CLI (`scripts/analytics-report.mjs`) fetches the aggregates and hands
 * them here, which keeps all the metric logic unit-testable with fixtures.
 *
 * Internal/developer-facing only; every input is a count keyed by
 * merchant/shop/status — never customer PII. See
 * `docs/ops/product_analytics_and_margin_spec.md` for the full plan; this is the
 * v1 read-only slice (no new tables, no per-event instrumentation).
 */

/** Channel-connection statuses that do NOT count as "connected". */
const DISCONNECTED_CHANNEL_STATUSES = new Set([
  "not_connected",
  "disconnected",
  "revoked",
  "error",
  "failed",
]);

/**
 * @param {number} part
 * @param {number} whole
 * @returns {number} percentage rounded to one decimal (0 when whole is 0)
 */
export function pct(part, whole) {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * @param {Record<string, number> | undefined} byStatus
 * @returns {number}
 */
function sumCounts(byStatus) {
  if (!byStatus) return 0;
  return Object.values(byStatus).reduce((total, n) => total + (n || 0), 0);
}

/**
 * @param {Record<string, number> | undefined} byStatus
 * @param {string} feature
 * @returns {{ feature: string; total: number; failed: number; failureRatePct: number; byStatus: Record<string, number> }}
 */
function generationHealth(byStatus, feature) {
  const map = byStatus ?? {};
  const total = sumCounts(map);
  const failed = map.failed ?? 0;
  return {
    feature,
    total,
    failed,
    failureRatePct: pct(failed, total),
    byStatus: map,
  };
}

/**
 * @typedef {object} UsageReportInput
 * @property {string} generatedAt ISO timestamp (supplied by the caller).
 * @property {number} windowDays Active-window size in days.
 * @property {number} merchants Total merchant count.
 * @property {{ total: number; setupStatus: Record<string, number>; backfillStarted: number; backfillCompleted: number; onboardingCompleted: number; installedInWindow: number }} shops
 * @property {Record<string, number>} channels Channel-connection counts by status.
 * @property {{ totalBeliefs: number; merchantsWithBeliefs: number }} memory
 * @property {{ insights: Record<string, number>; goals: Record<string, number>; plan: Record<string, number> }} generation
 * @property {Record<string, number>} jobs Backfill-job counts by status.
 * @property {{ activeInWindow: number }} activity Distinct shops active in the window.
 */

/**
 * Build the structured usage report from pre-fetched aggregates.
 *
 * @param {UsageReportInput} data
 */
export function buildUsageReport(data) {
  const installed = data.shops.total;

  const stages = [
    { stage: "installed", count: installed },
    { stage: "backfill_started", count: data.shops.backfillStarted },
    { stage: "backfill_completed", count: data.shops.backfillCompleted },
    { stage: "onboarding_completed", count: data.shops.onboardingCompleted },
  ];

  const funnel = stages.map((entry, index) => {
    const previous = index === 0 ? null : stages[index - 1].count;
    return {
      stage: entry.stage,
      count: entry.count,
      pctOfInstalled: pct(entry.count, installed),
      stepConversionPct: previous === null ? null : pct(entry.count, previous),
    };
  });

  // Biggest single-step fall-off, by absolute merchants lost.
  let biggestDropOff = null;
  for (let i = 1; i < stages.length; i += 1) {
    const lost = stages[i - 1].count - stages[i].count;
    if (!biggestDropOff || lost > biggestDropOff.lostCount) {
      biggestDropOff = {
        from: stages[i - 1].stage,
        to: stages[i].stage,
        lostCount: lost,
        lostPct: pct(lost, stages[i - 1].count),
      };
    }
  }

  const connectedChannels = Object.entries(data.channels)
    .filter(([status]) => !DISCONNECTED_CHANNEL_STATUSES.has(status))
    .reduce((total, [, n]) => total + (n || 0), 0);

  return {
    generatedAt: data.generatedAt,
    windowDays: data.windowDays,
    totals: { merchants: data.merchants, shops: installed },
    funnel,
    biggestDropOff,
    engagement: {
      activeInWindow: data.activity.activeInWindow,
      activePctOfInstalled: pct(data.activity.activeInWindow, installed),
      installedInWindow: data.shops.installedInWindow,
      channelConnections: connectedChannels,
      channelsByStatus: data.channels,
      merchantsWithMemory: data.memory.merchantsWithBeliefs,
      totalBeliefs: data.memory.totalBeliefs,
      avgBeliefsPerMemoryMerchant:
        data.memory.merchantsWithBeliefs > 0
          ? Math.round(
              (data.memory.totalBeliefs / data.memory.merchantsWithBeliefs) * 10,
            ) / 10
          : 0,
    },
    generationHealth: {
      insights: generationHealth(data.generation.insights, "insights"),
      goals: generationHealth(data.generation.goals, "goals"),
      plan: generationHealth(data.generation.plan, "plan"),
    },
    jobQueue: {
      byStatus: data.jobs,
      failed: data.jobs.failed ?? 0,
      running: data.jobs.running ?? 0,
      queued: data.jobs.queued ?? 0,
    },
    setupStatusBreakdown: data.shops.setupStatus,
  };
}

/**
 * @param {Record<string, number>} byStatus
 * @returns {string}
 */
function formatBreakdown(byStatus) {
  const entries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "    (none)";
  return entries.map(([key, n]) => `    ${key.padEnd(24)} ${n}`).join("\n");
}

/**
 * Render the report as a human-readable text block for the CLI.
 *
 * @param {ReturnType<typeof buildUsageReport>} report
 * @returns {string}
 */
export function formatUsageReport(report) {
  const lines = [];
  lines.push("Jefe — client usage report");
  lines.push(`Generated: ${report.generatedAt}  ·  active window: ${report.windowDays}d`);
  lines.push("");
  lines.push(
    `Merchants: ${report.totals.merchants}   Shops: ${report.totals.shops}`,
  );
  lines.push("");

  lines.push("Onboarding funnel");
  for (const step of report.funnel) {
    const conv =
      step.stepConversionPct === null ? "—" : `${step.stepConversionPct}%`;
    lines.push(
      `  ${step.stage.padEnd(22)} ${String(step.count).padStart(5)}  ` +
        `(${step.pctOfInstalled}% of installed, step ${conv})`,
    );
  }
  if (report.biggestDropOff && report.biggestDropOff.lostCount > 0) {
    lines.push(
      `  ↳ biggest drop-off: ${report.biggestDropOff.from} → ${report.biggestDropOff.to} ` +
        `(${report.biggestDropOff.lostCount} lost, ${report.biggestDropOff.lostPct}%)`,
    );
  }
  lines.push("");

  lines.push("Engagement");
  lines.push(
    `  Active in window:      ${report.engagement.activeInWindow} ` +
      `(${report.engagement.activePctOfInstalled}% of installed)`,
  );
  lines.push(`  Installed in window:   ${report.engagement.installedInWindow}`);
  lines.push(`  Channel connections:   ${report.engagement.channelConnections}`);
  lines.push(
    `  Merchants with memory: ${report.engagement.merchantsWithMemory} ` +
      `(avg ${report.engagement.avgBeliefsPerMemoryMerchant} beliefs, ` +
      `${report.engagement.totalBeliefs} total)`,
  );
  lines.push("");

  lines.push("Generation health (failures = stalled clients)");
  for (const feature of [
    report.generationHealth.insights,
    report.generationHealth.goals,
    report.generationHealth.plan,
  ]) {
    lines.push(
      `  ${feature.feature.padEnd(10)} runs ${String(feature.total).padStart(5)}  ` +
        `failed ${feature.failed} (${feature.failureRatePct}%)`,
    );
  }
  lines.push("");

  lines.push("Job queue");
  lines.push(formatBreakdown(report.jobQueue.byStatus));
  lines.push("");

  lines.push("Setup status breakdown");
  lines.push(formatBreakdown(report.setupStatusBreakdown));

  return lines.join("\n");
}
