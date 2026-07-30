// @ts-check

// Clearance outcome measurement — the Observe→Learn half of the action loop.
//
// The action loop is belief → decision → (typed action) → OUTCOME. This is the
// outcome step for clearance: given a clearance run that was applied (which
// variants got marked down, and when) plus the sales that happened AFTER it,
// measure whether the action actually worked — did the dead stock start moving,
// and how much cash came back?
//
// That measurement is what lets memory LEARN which actions work, which is the
// substrate of earned autonomy: a merchant whose clearances consistently move
// stock is one Jefe can eventually act for with less friction. It feeds a memory
// belief (parallel to business.recommendation_engagement) once the action_executions
// ledger exists.
//
// Pure + deterministic on purpose: it takes the applied changes and the relevant
// line items as arguments, so it's unit-testable and independent of where that
// data is stored (the DB loader + the belief that consume it are separate, and
// land once the action_executions substrate is agreed with the execution-contract
// owner). No external write, no inference.

/** @param {number} value */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Measure the realised outcome of a single applied clearance run.
 *
 * `lineItemsAfter` is the set of sale line items for this run's variants; the
 * caller scopes it (variant ∈ run, processed at/after the clearance), and this
 * function re-checks the timing defensively so a loose query can't overcount.
 * Revenue recovered uses the price actually paid when available, else the
 * clearance target price for that variant.
 *
 * @param {{ appliedAt: Date | string; changes: Array<{ variantId: string; toPrice: number }> }} run
 * @param {Array<{ variantId: string; quantity: number; unitPrice?: number | null; processedAt: Date | string }>} lineItemsAfter
 * @returns {{ variantsCleared: number; variantsSold: number; unitsMoved: number; revenueRecovered: number; effectivenessRatePercent: number }}
 */
export function measureClearanceOutcome(run, lineItemsAfter) {
  const appliedAtMs = new Date(run?.appliedAt ?? 0).getTime();
  const targetPriceByVariant = new Map();
  for (const change of run?.changes ?? []) {
    if (change?.variantId) targetPriceByVariant.set(change.variantId, Number(change.toPrice));
  }
  const clearedVariantIds = new Set(targetPriceByVariant.keys());

  const soldUnitsByVariant = new Map();
  let unitsMoved = 0;
  let revenueRecovered = 0;

  for (const line of Array.isArray(lineItemsAfter) ? lineItemsAfter : []) {
    if (!clearedVariantIds.has(line?.variantId)) continue; // not one of the cleared variants
    const processedMs = new Date(line.processedAt ?? 0).getTime();
    if (!(processedMs >= appliedAtMs)) continue; // only sales AFTER the clearance count
    const qty = Number(line.quantity) || 0;
    if (qty <= 0) continue;
    const paid =
      line.unitPrice != null && Number.isFinite(Number(line.unitPrice))
        ? Number(line.unitPrice)
        : targetPriceByVariant.get(line.variantId) ?? 0;
    unitsMoved += qty;
    revenueRecovered += qty * paid;
    soldUnitsByVariant.set(line.variantId, (soldUnitsByVariant.get(line.variantId) ?? 0) + qty);
  }

  const variantsCleared = clearedVariantIds.size;
  const variantsSold = soldUnitsByVariant.size;
  return {
    variantsCleared,
    variantsSold,
    unitsMoved,
    revenueRecovered: round2(revenueRecovered),
    // Share of cleared variants that moved at least one unit — the headline
    // "did it work" signal. Stored as a percent (0–100) so numeric grounding
    // treats it as a rate, per the belief-value convention.
    effectivenessRatePercent: variantsCleared > 0 ? round2((variantsSold / variantsCleared) * 100) : 0,
  };
}

/**
 * The DB "Observe" step: measure + record outcomes for applied clearance runs whose
 * measurement window has elapsed. For each such run it gathers the sales of the cleared
 * variants that happened AFTER the clearance was applied, scores the run with
 * measureClearanceOutcome, and persists the result on the ledger row (`outcome` +
 * `outcomeStatus="measured"` + `outcomeMeasuredAt`). No external write — only the
 * action_executions row is updated; the belief that aggregates these measured rows (the
 * "Learn" step) reads them separately.
 *
 * Idempotent by construction: it only picks up `outcomeStatus="pending"` runs and flips
 * them to "measured", so a re-run never double-scores. A run whose preview has no cleared
 * variants is still marked measured (zeros) so it can't re-queue forever. Nothing here
 * runs until clearance execution is live (there are no applied runs while the flag is
 * off) — it's the ready-for-flip half of the loop.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ now?: Date; measurementWindowDays?: number; limit?: number; logger?: Pick<Console, "info" | "warn"> }} [input]
 * @returns {Promise<{ measured: number; results: Array<{ runId: string; merchantId: string; shopId: string } & ReturnType<typeof measureClearanceOutcome>> }>}
 */
export async function measureAndRecordClearanceOutcomes(prisma, input = {}) {
  const now = input.now ?? new Date();
  const windowDays = Number.isFinite(Number(input.measurementWindowDays))
    ? Number(input.measurementWindowDays)
    : 14;
  const cutoff = new Date(now.getTime() - windowDays * 86400000);

  // Applied runs past their measurement window that haven't been scored yet.
  const runs = await prisma.actionExecution.findMany({
    where: {
      actionType: "price_markdown",
      status: { in: ["applied", "partially_applied"] },
      outcomeStatus: "pending",
      appliedAt: { lte: cutoff },
    },
    select: { id: true, runId: true, merchantId: true, shopId: true, appliedAt: true, preview: true },
    orderBy: { appliedAt: "asc" },
    take: Number.isFinite(Number(input.limit)) ? Number(input.limit) : 100,
  });

  const results = [];
  for (const run of runs) {
    const preview = /** @type {any} */ (run.preview) ?? {};
    const rawChanges = Array.isArray(preview.changes) ? preview.changes : [];
    /** @type {Array<{ variantId: string; toPrice: number }>} */
    const changes = [];
    for (const change of rawChanges) {
      if (change && change.variantId) {
        changes.push({ variantId: String(change.variantId), toPrice: Number(change.toPrice) });
      }
    }
    const variantIds = changes.map((change) => change.variantId);
    const appliedAt = run.appliedAt ?? now;

    /** @type {Array<{ variantId: string; quantity: number; unitPrice: number | null; processedAt: Date }>} */
    let lines = [];
    if (variantIds.length > 0) {
      const lineItems = await prisma.orderLineItem.findMany({
        where: {
          merchantId: run.merchantId,
          shopId: run.shopId,
          variantId: { in: variantIds },
          order: { processedAt: { gte: appliedAt } },
        },
        select: {
          variantId: true,
          quantity: true,
          unitPrice: true,
          order: { select: { processedAt: true } },
        },
      });
      lines = lineItems.map((line) => ({
        variantId: String(line.variantId ?? ""),
        quantity: Number(line.quantity) || 0,
        unitPrice: line.unitPrice == null ? null : Number(line.unitPrice),
        processedAt: line.order?.processedAt ?? now,
      }));
    }

    const outcome = measureClearanceOutcome({ appliedAt, changes }, lines);
    await prisma.actionExecution.update({
      where: { id: run.id },
      data: {
        outcome: /** @type {any} */ (outcome),
        outcomeStatus: "measured",
        outcomeMeasuredAt: now,
      },
    });
    results.push({ runId: run.runId, merchantId: run.merchantId, shopId: run.shopId, ...outcome });
  }

  input.logger?.info?.("clearance outcomes measured", { measured: results.length, windowDays });
  return { measured: results.length, results };
}
