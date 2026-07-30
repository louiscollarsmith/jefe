// @ts-check

// Clearance execution adapter — the EXECUTION half of Jefe's first action.
//
// ⚠️  ONE-WAY DOOR / NOT LIVE. This is the only place in the action loop that
// writes to a merchant's Shopify store (variant prices). It is deliberately
// built so it CANNOT run by accident, pending founder + architecture sign-off:
//   - FLAGGED OFF   — CLEARANCE_EXECUTE_ENABLED must be exactly "true" (default off).
//   - UNWIRED       — nothing in the app calls applyClearance().
//   - INJECTED      — applyClearance() requires an injected prisma + shopifyClient;
//                     no code here constructs a real one.
//
// Safety contract (all pure + tested, except the write path which is triple-guarded):
//   - preview          — deterministic dry-run; only genuine markdowns survive.
//   - floor-at-gate     — refuses any price BELOW the per-item cost floor, even if
//                         the decision engine proposed it (defense-in-depth; the gate
//                         never trusts the sizing).
//   - blast-radius cap  — blocks (never trims) an over-cap run.
//   - auto-eligibility  — reversible ∧ cap ∧ confident, computed here, never trusted.
//   - autonomy mode     — resolveAutonomyMode(merchantSetting, eligibility): auto only
//                         if the merchant opted in AND it's structurally eligible.
//   - compare-and-set   — refuses to write if the live price has drifted from the
//                         previewed prior value (never applies an approval to a
//                         changed store state).
//   - audit + idempotency — every intended write is a row in action_execution_writes
//                         (unique per run+target+value), so a retry can't double-apply.
//   - auto-revert-partial — a mid-run failure restores everything already applied.

/** Default blast-radius caps for a single clearance run. */
export const DEFAULT_CLEARANCE_CAPS = {
  maxVariants: 50, // never reprice more than this many variants in one run
  maxDiscountPercent: 60, // never apply a markdown deeper than this
  minConfidence: 0.9, // auto-eligibility confidence floor
};

/**
 * Whether autonomous clearance execution is enabled. Off unless the env var is
 * exactly "true". Turning it on is a deliberate, reviewed decision.
 */
export function isClearanceExecuteEnabled() {
  return process.env.CLEARANCE_EXECUTE_ENABLED === "true";
}

/** @param {unknown} value @returns {number} */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Build the preview a merchant approves: the exact per-variant price change plus
 * the prior price to restore. Pure; writes nothing. A change survives only if it
 * is a genuine markdown (0 < toPrice < fromPrice) AND at or above its cost floor.
 * Below-floor or missing-floor items are REFUSED (recorded, never applied) — the
 * "never sell below cost" invariant enforced structurally at the gate.
 * @param {{ items?: Array<{ variantId: string; title?: string | null; currentPrice: number; suggestedPrice: number; floorPrice?: number | null }> }} proposal
 */
export function buildClearancePreview(proposal) {
  const changes = [];
  const refused = [];
  for (const item of proposal?.items ?? []) {
    const from = round2(item.currentPrice);
    const to = round2(item.suggestedPrice);
    if (!(from > 0) || !(to > 0) || to >= from) continue; // not a valid markdown
    const floor = item.floorPrice == null ? null : round2(item.floorPrice);
    if (floor == null) {
      refused.push({ variantId: item.variantId, toPrice: to, reason: "missing_floor" });
      continue; // fail-closed: no verified cost floor → never write
    }
    if (to < floor) {
      refused.push({ variantId: item.variantId, toPrice: to, floorPrice: floor, reason: "below_floor" });
      continue; // would sell below cost → refuse
    }
    changes.push({
      variantId: item.variantId,
      title: item.title ?? null,
      fromPrice: from,
      toPrice: to,
      floorPrice: floor,
      discountPercent: round2(((from - to) / from) * 100),
    });
  }
  const maxDiscountPercent = changes.reduce(
    (max, change) => Math.max(max, change.discountPercent),
    0,
  );
  return {
    changes,
    variantCount: changes.length,
    maxDiscountPercent: round2(maxDiscountPercent),
    refused,
    // Prior prices, per target — the authoritative restore source (also written
    // to each ActionExecutionWrite.expectedFrom).
    reversibilityPlan: changes.map((change) => ({
      variantId: change.variantId,
      restorePrice: change.fromPrice,
    })),
  };
}

/**
 * Enforce blast-radius caps on a preview. Never trims silently — a violation
 * blocks; an over-cap run must be re-scoped or explicitly approved.
 * @param {ReturnType<typeof buildClearancePreview>} preview
 * @param {typeof DEFAULT_CLEARANCE_CAPS} [caps]
 */
export function enforceBlastRadiusCap(preview, caps = DEFAULT_CLEARANCE_CAPS) {
  const violations = [];
  if (preview.variantCount > caps.maxVariants) {
    violations.push({ cap: "maxVariants", limit: caps.maxVariants, actual: preview.variantCount });
  }
  if (preview.maxDiscountPercent > caps.maxDiscountPercent) {
    violations.push({ cap: "maxDiscountPercent", limit: caps.maxDiscountPercent, actual: preview.maxDiscountPercent });
  }
  return { withinCap: violations.length === 0, violations };
}

/**
 * The structural auto-eligibility gate: reversible ∧ blast_radius ≤ cap ∧
 * confidence ≥ threshold. Computed here, never trusted from a prompt. A clearance
 * is reversible (restore prices), so it comes down to cap + confidence. Fail any →
 * not auto-eligible → ask-then-act.
 * @param {ReturnType<typeof buildClearancePreview>} preview
 * @param {number} confidence
 * @param {typeof DEFAULT_CLEARANCE_CAPS} [caps]
 */
export function computeClearanceAutoEligibility(preview, confidence, caps = DEFAULT_CLEARANCE_CAPS) {
  const reversible =
    preview.variantCount > 0 &&
    preview.reversibilityPlan.length === preview.variantCount;
  const cap = enforceBlastRadiusCap(preview, caps);
  const confident = Number(confidence) >= caps.minConfidence;
  return {
    autoEligible: reversible && cap.withinCap && confident,
    reversible,
    withinCap: cap.withinCap,
    confident,
    reasons: [
      ...(reversible ? [] : ["not_reversible"]),
      ...(cap.withinCap ? [] : ["over_blast_radius_cap"]),
      ...(confident ? [] : ["below_confidence_threshold"]),
    ],
  };
}

/**
 * Resolve the autonomy mode for a run: the merchant's dial × the structural gate.
 * Auto ONLY if the merchant opted into auto for this action class AND the action
 * is structurally auto-eligible. The irreversible floor is explicit here too
 * (`reversible !== false`) as defense-in-depth: a non-reversible action can never
 * auto-run regardless of the merchant setting. Everything else → propose (ask).
 * @param {string} merchantSetting  "propose" | "auto"
 * @param {{ autoEligible?: boolean; reversible?: boolean }} eligibility
 * @returns {{ mode: "propose" | "auto"; reason: string }}
 */
export function resolveAutonomyMode(merchantSetting, eligibility) {
  const wantsAuto = merchantSetting === "auto";
  const eligible = eligibility?.autoEligible === true && eligibility?.reversible !== false;
  const mode = wantsAuto && eligible ? "auto" : "propose";
  return {
    mode,
    reason: mode === "auto"
      ? "merchant_auto_and_eligible"
      : !wantsAuto
        ? "merchant_setting_propose"
        : "not_auto_eligible",
  };
}

/**
 * Restore a set of applied changes to their prior prices. Best-effort per target;
 * a restore failure is recorded, not thrown, so one bad restore can't strand the
 * rest. Only ever *restores* a prior price — cannot set an arbitrary value.
 * @param {{ updateVariantPrice: (variantId: string, price: number) => Promise<unknown> }} shopifyClient
 * @param {Array<{ variantId: string; restorePrice: number }>} plan
 */
async function restoreApplied(shopifyClient, plan) {
  const restored = [];
  const failed = [];
  for (const entry of plan ?? []) {
    const price = round2(entry?.restorePrice);
    if (!entry?.variantId || !(price > 0)) continue;
    try {
      await shopifyClient.updateVariantPrice(entry.variantId, price);
      restored.push({ variantId: entry.variantId, restorePrice: price });
    } catch (err) {
      failed.push({ variantId: entry.variantId, error: String(err?.message ?? err) });
    }
  }
  return { restored, failed };
}

/**
 * Execute an approved clearance. ⚠️ THE ONLY WRITE PATH.
 * Triple-guarded (enabled + injected prisma + injected shopifyClient), it:
 *  1. re-checks the blast-radius cap,
 *  2. records a parent action_executions row (idempotent on runId) with the
 *     autonomy trio + preview,
 *  3. for each change: upserts a child write row (unique per run+target+value →
 *     a retry can't double-apply), compare-and-sets against the live price
 *     (skip_drift if it moved), then writes,
 *  4. on any failure mid-run, auto-reverts everything applied so far.
 *
 * @param {{
 *   prisma: { actionExecution: any; actionExecutionWrite: any },
 *   shopifyClient: {
 *     getVariantPrice: (variantId: string) => Promise<number | null>,
 *     updateVariantPrice: (variantId: string, price: number) => Promise<unknown>,
 *   },
 *   execution: {
 *     runId: string; merchantId: string; shopId: string;
 *     actionType?: string; actionKind?: string;
 *     merchantSetting: string; resolvedMode: string;
 *     eligibility?: object; confidence?: number | null; approvedBy?: string | null;
 *   },
 * }} deps
 * @param {ReturnType<typeof buildClearancePreview>} preview
 * @param {{ caps?: typeof DEFAULT_CLEARANCE_CAPS }} [options]
 */
export async function applyClearance({ prisma, shopifyClient, execution }, preview, options = {}) {
  if (!isClearanceExecuteEnabled()) {
    throw new Error("Clearance execution is disabled (CLEARANCE_EXECUTE_ENABLED is not 'true').");
  }
  if (!prisma?.actionExecution || !prisma?.actionExecutionWrite) {
    throw new Error("Clearance execution requires an injected prisma client with the action-execution ledger.");
  }
  if (
    !shopifyClient ||
    typeof shopifyClient.updateVariantPrice !== "function" ||
    typeof shopifyClient.getVariantPrice !== "function"
  ) {
    throw new Error("Clearance execution requires an injected shopifyClient with getVariantPrice + updateVariantPrice.");
  }
  const caps = options.caps ?? DEFAULT_CLEARANCE_CAPS;
  const cap = enforceBlastRadiusCap(preview, caps);
  if (!cap.withinCap) {
    throw new Error(`Clearance exceeds blast-radius cap: ${JSON.stringify(cap.violations)}`);
  }

  // Parent ledger row — idempotent on runId; a pre-existing (proposed/approved)
  // row keeps its approval context.
  const parent = await prisma.actionExecution.upsert({
    where: { runId: execution.runId },
    create: {
      runId: execution.runId,
      merchantId: execution.merchantId,
      shopId: execution.shopId,
      actionType: execution.actionType ?? "price_markdown",
      actionKind: execution.actionKind ?? "dead_stock_clearance",
      status: "approved",
      merchantSetting: execution.merchantSetting,
      resolvedMode: execution.resolvedMode,
      eligibility: execution.eligibility ?? {},
      confidence: execution.confidence ?? null,
      approvedBy: execution.approvedBy ?? (execution.resolvedMode === "auto" ? "auto" : null),
      approvedAt: new Date(),
      preview,
      caps,
    },
    update: {},
  });

  const applied = [];
  const skipped = [];
  try {
    for (const change of preview.changes) {
      const targetValueKey = `price:${change.toPrice}`;
      const write = await prisma.actionExecutionWrite.upsert({
        where: {
          executionId_targetRef_targetValueKey: {
            executionId: parent.id,
            targetRef: change.variantId,
            targetValueKey,
          },
        },
        create: {
          executionId: parent.id,
          targetRef: change.variantId,
          targetValueKey,
          expectedFrom: { price: change.fromPrice },
          targetValue: { price: change.toPrice },
          status: "pending",
        },
        update: {},
      });
      if (write.status === "applied") {
        // Already done in a prior run of this runId — idempotent, don't re-write.
        applied.push({ variantId: change.variantId, toPrice: change.toPrice, fromPrice: change.fromPrice, idempotent: true });
        continue;
      }

      // Compare-and-set: never apply an approval to a store that has drifted.
      const live = await shopifyClient.getVariantPrice(change.variantId);
      if (live != null && round2(live) !== change.fromPrice) {
        await prisma.actionExecutionWrite.update({ where: { id: write.id }, data: { status: "skipped_drift" } });
        skipped.push({ variantId: change.variantId, reason: "price_drift", expected: change.fromPrice, actual: round2(live) });
        continue;
      }

      await shopifyClient.updateVariantPrice(change.variantId, change.toPrice);
      await prisma.actionExecutionWrite.update({ where: { id: write.id }, data: { status: "applied", appliedAt: new Date() } });
      applied.push({ variantId: change.variantId, toPrice: change.toPrice, fromPrice: change.fromPrice });
    }
  } catch (err) {
    // Auto-revert the partial: restore every change we applied this run.
    const undo = await restoreApplied(
      shopifyClient,
      applied.map((a) => ({ variantId: a.variantId, restorePrice: a.fromPrice })),
    );
    await prisma.actionExecution.update({
      where: { id: parent.id },
      data: { status: "reverted", revertedAt: new Date(), error: String(err?.message ?? err) },
    });
    return {
      ok: false,
      executionId: parent.id,
      error: String(err?.message ?? err),
      revertedCount: undo.restored.length,
      revertFailures: undo.failed,
    };
  }

  const status = skipped.length === 0 ? "applied" : applied.length === 0 ? "failed" : "partially_applied";
  await prisma.actionExecution.update({ where: { id: parent.id }, data: { status, appliedAt: new Date() } });
  return {
    ok: true,
    executionId: parent.id,
    status,
    applied,
    appliedCount: applied.length,
    skipped,
    skippedCount: skipped.length,
  };
}

/**
 * Reverse an applied clearance — restore each variant to its captured prior price.
 * This is what makes "reversible" a real guarantee, not a stored intention.
 *
 * ⚠️ Also a Shopify write path, but deliberately **not** gated on
 * `CLEARANCE_EXECUTE_ENABLED`: the undo must never be harder to reach than the
 * action it undoes, or disabling the feature after a run would trap a merchant in
 * a clearance they can't reverse. Safe because (a) it requires an injected
 * `shopifyClient`, and (b) it only ever *restores* prices from a plan — it can't
 * set an arbitrary price. Idempotent; skips malformed entries.
 * @param {{ updateVariantPrice: (variantId: string, price: number) => Promise<unknown> }} shopifyClient
 * @param {Array<{ variantId: string; restorePrice: number }>} reversibilityPlan
 */
export async function revertClearance(shopifyClient, reversibilityPlan) {
  if (!shopifyClient || typeof shopifyClient.updateVariantPrice !== "function") {
    throw new Error("Clearance reversal requires an injected shopifyClient.");
  }
  const restored = [];
  const skipped = [];
  for (const entry of reversibilityPlan ?? []) {
    const price = round2(entry?.restorePrice);
    if (!entry?.variantId || !(price > 0)) {
      skipped.push({ variantId: entry?.variantId ?? null, reason: "malformed_plan_entry" });
      continue;
    }
    await shopifyClient.updateVariantPrice(entry.variantId, price);
    restored.push({ variantId: entry.variantId, restorePrice: price });
  }
  return { restored, restoredCount: restored.length, skipped, skippedCount: skipped.length };
}
