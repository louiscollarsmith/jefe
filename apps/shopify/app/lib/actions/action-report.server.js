// @ts-check

// Executed-action visibility — the ops READ over the `action_executions` ledger. Now that the
// action layer is live (clearance executes in prod), this surfaces the proposal→execution funnel
// and outcome mix: how many actions were proposed vs applied vs reverted vs failed, by action
// type, plus the "has Jefe done its first real successful action yet" milestone.
//
// Read-only + self-contained — it does NOT touch the live execution path (that stays owned by the
// adapter/wire), and it does NOT wire alerting (routing the milestone / a sustained-failure signal
// to #jefe-slack is a small follow-up on the worker + ops alerter — chat 8's lane). Pure shaper +
// a thin prisma groupBy, mirroring the cost-report read.

/** @param {unknown} v */
const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/** Terminal statuses that mean a store write was attempted. */
const EXECUTED_STATUSES = new Set(["applied", "partially_applied", "reverted", "failed"]);
/** Statuses that mean a store write actually landed (in whole or part). */
const SUCCESSFUL_STATUSES = new Set(["applied", "partially_applied"]);

/**
 * Pure: shape prisma `groupBy(['actionType','status'])` rows into an execution summary.
 * Defensive against empty / malformed rows.
 * @param {Array<{ actionType?: string|null, status?: string|null, _count?: { _all?: number } }>|null|undefined} rows
 */
export function shapeActionSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {Map<string, { actionType: string, proposed: number, approved: number, applied: number, partiallyApplied: number, reverted: number, failed: number, superseded: number, executed: number, successful: number, total: number }>} */
  const byType = new Map();
  const totals = { proposed: 0, approved: 0, applied: 0, partiallyApplied: 0, reverted: 0, failed: 0, superseded: 0 };

  for (const r of list) {
    const type = r?.actionType ?? "unknown";
    const status = r?.status ?? "unknown";
    const c = num(r?._count?._all);
    const e = byType.get(type) ?? { actionType: type, proposed: 0, approved: 0, applied: 0, partiallyApplied: 0, reverted: 0, failed: 0, superseded: 0, executed: 0, successful: 0, total: 0 };

    e.total += c;
    if (status === "applied") { e.applied += c; totals.applied += c; }
    else if (status === "partially_applied") { e.partiallyApplied += c; totals.partiallyApplied += c; }
    else if (status === "reverted") { e.reverted += c; totals.reverted += c; }
    else if (status === "failed") { e.failed += c; totals.failed += c; }
    else if (status === "proposed") { e.proposed += c; totals.proposed += c; }
    else if (status === "approved") { e.approved += c; totals.approved += c; }
    else if (status === "superseded") { e.superseded += c; totals.superseded += c; }
    if (EXECUTED_STATUSES.has(status)) e.executed += c;
    if (SUCCESSFUL_STATUSES.has(status)) e.successful += c;
    byType.set(type, e);
  }

  const totalExecuted = totals.applied + totals.partiallyApplied + totals.reverted + totals.failed;
  const successful = totals.applied + totals.partiallyApplied;
  return {
    ...totals,
    totalRuns: totals.proposed + totals.approved + totalExecuted + totals.superseded,
    totalExecuted,
    successful,
    // % of attempted writes that landed (in whole or part). null until something has executed.
    executionSuccessRatePercent: totalExecuted > 0 ? round2((successful / totalExecuted) * 100) : null,
    byActionType: [...byType.values()].sort((a, b) => b.total - a.total),
    // The milestone: has Jefe successfully executed a real action for a merchant yet?
    hasExecutedAny: successful > 0,
  };
}

/**
 * Read the action ledger and return an execution summary (proposal→execution funnel + outcomes).
 * @param {{ actionExecution: { groupBy: Function } }} prisma
 */
export async function summarizeExecutedActions(prisma) {
  const rows = await prisma.actionExecution.groupBy({
    by: ["actionType", "status"],
    _count: { _all: true },
  });
  return shapeActionSummary(rows);
}
