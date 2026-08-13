// @ts-check

// The `product_status_change` typed adapter — Jefe's SECOND executable action (archive a product
// that didn't clear = set status ARCHIVED; reversible via ACTIVE). A faithful parallel of the
// dead-stock clearance adapter: same guardrails (flag gate, blast-radius cap, idempotent
// per-target ledger writes, compare-and-set, auto-revert on partial failure, un-gated revert),
// reusing the generic `action_executions` / `action_execution_writes` ledger with NO migration.
//
// Built DARK behind `PRODUCT_STATUS_EXECUTE_ENABLED` (default off) and UNWIRED to any surface —
// nothing calls `applyProductStatusChange` yet. It exists to (a) give the merchant a second real
// action and (b) make the shared adapter shape concrete (two primitives → the interface). The
// safe "flag off = no-op" entry lives in the wire layer (as with clearance); the adapter itself
// hard-throws when disabled, so a mis-call can never write.
//
// Reference + recipe: docs/action-layer-implementation.md. Contract: context/11_actions_and_autonomy.md.

/** Blast-radius caps for a single product-status run. A status flip has no magnitude, so no discount cap. */
export const DEFAULT_PRODUCT_STATUS_CAPS = {
  maxProducts: 50,
  minConfidence: 0.9,
};

/** Exact-string, default-off — identical discipline to CLEARANCE_EXECUTE_ENABLED. */
export function isProductStatusExecuteEnabled() {
  return process.env.PRODUCT_STATUS_EXECUTE_ENABLED === "true";
}

const VALID_STATUSES = new Set(["ACTIVE", "ARCHIVED", "DRAFT"]);

/**
 * Pure dry-run. A change survives only if it's a real transition (from !== to) with both
 * statuses valid. No-ops and unknown statuses are refused (recorded, never applied). Writes nothing.
 * @param {{ items?: Array<{ productId: string | null, title?: string | null, currentStatus: string, targetStatus: string }> }} proposal
 */
export function buildProductStatusPreview(proposal) {
  const changes = [];
  const refused = [];
  for (const item of proposal?.items ?? []) {
    if (!item?.productId) continue;
    const from = item.currentStatus;
    const to = item.targetStatus;
    if (!VALID_STATUSES.has(to) || !VALID_STATUSES.has(from)) {
      refused.push({ productId: item.productId, toStatus: to, reason: "invalid_status" });
      continue;
    }
    if (from === to) {
      refused.push({ productId: item.productId, toStatus: to, reason: "noop" });
      continue;
    }
    changes.push({ productId: item.productId, title: item.title ?? null, fromStatus: from, toStatus: to });
  }
  return {
    changes,
    productCount: changes.length,
    refused,
    // Authoritative restore source; mirrored per-target into ActionExecutionWrite.expectedFrom.
    reversibilityPlan: changes.map((change) => ({
      productId: change.productId,
      restoreStatus: change.fromStatus,
    })),
  };
}

/** Blocks (never trims) an over-cap run.
 * @param {ReturnType<typeof buildProductStatusPreview>} preview
 * @param {typeof DEFAULT_PRODUCT_STATUS_CAPS} [caps] */
export function enforceBlastRadiusCap(preview, caps = DEFAULT_PRODUCT_STATUS_CAPS) {
  const violations = [];
  if (preview.productCount > caps.maxProducts) {
    violations.push({ cap: "maxProducts", limit: caps.maxProducts, actual: preview.productCount });
  }
  return { withinCap: violations.length === 0, violations };
}

/** reversible ∧ within-cap ∧ confident — computed here, never trusted from upstream.
 * @param {ReturnType<typeof buildProductStatusPreview>} preview
 * @param {unknown} confidence
 * @param {typeof DEFAULT_PRODUCT_STATUS_CAPS} [caps] */
export function computeProductStatusAutoEligibility(preview, confidence, caps = DEFAULT_PRODUCT_STATUS_CAPS) {
  const reversible = preview.productCount > 0 && preview.reversibilityPlan.length === preview.productCount;
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

/** Best-effort restore of already-applied changes (the auto-revert-on-partial-failure path).
 * @param {{ updateProductStatus: (productId: string, status: string) => Promise<unknown> }} shopifyClient
 * @param {Array<{ productId: string, restoreStatus: string }>} plan */
async function restoreApplied(shopifyClient, plan) {
  const restored = [];
  const failed = [];
  for (const entry of plan ?? []) {
    if (!entry?.productId || !VALID_STATUSES.has(entry?.restoreStatus)) continue;
    try {
      await shopifyClient.updateProductStatus(entry.productId, entry.restoreStatus);
      restored.push({ productId: entry.productId, restoreStatus: entry.restoreStatus });
    } catch (err) {
      failed.push({ productId: entry.productId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { restored, failed };
}

/**
 * Execute an approved product-status change. THE ONLY WRITE PATH. Triple-guarded (flag → injected
 * ledger → injected client → recommend-mode refusal → cap re-check); idempotent per target;
 * compare-and-set against the live status; auto-reverts already-applied changes on partial failure.
 *
 * @param {{ prisma: any, shopifyClient: { getProductStatus: (id: string) => Promise<string | null>, updateProductStatus: (id: string, status: string) => Promise<unknown> }, execution: any }} deps
 * @param {ReturnType<typeof buildProductStatusPreview>} preview
 * @param {{ caps?: typeof DEFAULT_PRODUCT_STATUS_CAPS }} [options]
 */
export async function applyProductStatusChange({ prisma, shopifyClient, execution }, preview, options = {}) {
  if (!isProductStatusExecuteEnabled()) {
    throw new Error("Product status execution is disabled (PRODUCT_STATUS_EXECUTE_ENABLED is not 'true').");
  }
  if (!prisma?.actionExecution || !prisma?.actionExecutionWrite) {
    throw new Error("Product status execution requires an injected prisma client with the action-execution ledger.");
  }
  if (!shopifyClient || typeof shopifyClient.updateProductStatus !== "function" || typeof shopifyClient.getProductStatus !== "function") {
    throw new Error("Product status execution requires an injected shopifyClient with getProductStatus + updateProductStatus.");
  }
  if (execution?.resolvedMode === "recommend") {
    throw new Error("Product status execution called in 'recommend' mode — advisory actions do not execute.");
  }
  const caps = options.caps ?? DEFAULT_PRODUCT_STATUS_CAPS;
  const cap = enforceBlastRadiusCap(preview, caps);
  if (!cap.withinCap) {
    throw new Error(`Product status change exceeds blast-radius cap: ${JSON.stringify(cap.violations)}`);
  }

  const parent = await prisma.actionExecution.upsert({
    where: { runId: execution.runId },
    create: {
      runId: execution.runId,
      merchantId: execution.merchantId,
      shopId: execution.shopId,
      actionType: execution.actionType ?? "product_status_change",
      actionKind: execution.actionKind ?? "archive_product",
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
      const targetValueKey = `status:${change.toStatus}`;
      const write = await prisma.actionExecutionWrite.upsert({
        where: { executionId_targetRef_targetValueKey: { executionId: parent.id, targetRef: change.productId, targetValueKey } },
        create: {
          executionId: parent.id,
          targetRef: change.productId,
          targetValueKey,
          expectedFrom: { status: change.fromStatus },
          targetValue: { status: change.toStatus },
          status: "pending",
        },
        update: {},
      });
      if (write.status === "applied") {
        applied.push({ productId: change.productId, toStatus: change.toStatus, fromStatus: change.fromStatus, idempotent: true });
        continue;
      }
      // Compare-and-set — string equality (no numeric magnitude). Never apply to a drifted store.
      const live = await shopifyClient.getProductStatus(change.productId);
      if (live != null && live !== change.fromStatus) {
        await prisma.actionExecutionWrite.update({ where: { id: write.id }, data: { status: "skipped_drift" } });
        skipped.push({ productId: change.productId, reason: "status_drift", expected: change.fromStatus, actual: live });
        continue;
      }
      await shopifyClient.updateProductStatus(change.productId, change.toStatus);
      await prisma.actionExecutionWrite.update({ where: { id: write.id }, data: { status: "applied", appliedAt: new Date() } });
      applied.push({ productId: change.productId, toStatus: change.toStatus, fromStatus: change.fromStatus });
    }
  } catch (err) {
    const undo = await restoreApplied(shopifyClient, applied.map((a) => ({ productId: a.productId, restoreStatus: a.fromStatus })));
    await prisma.actionExecution.update({
      where: { id: parent.id },
      data: { status: "reverted", revertedAt: new Date(), error: err instanceof Error ? err.message : String(err) },
    });
    return { ok: false, executionId: parent.id, error: err instanceof Error ? err.message : String(err), revertedCount: undo.restored.length, revertFailures: undo.failed };
  }

  const status = skipped.length === 0 ? "applied" : applied.length === 0 ? "failed" : "partially_applied";
  await prisma.actionExecution.update({ where: { id: parent.id }, data: { status, appliedAt: new Date() } });
  return { ok: true, executionId: parent.id, status, applied, appliedCount: applied.length, skipped, skippedCount: skipped.length };
}

/**
 * Reverse an applied change — restore each product's prior status. NOT gated on the flag (undo
 * must never be trappable). Requires the injected client; only restores from the plan; skips
 * malformed entries.
 * @param {{ updateProductStatus: (productId: string, status: string) => Promise<unknown> }} shopifyClient
 * @param {Array<{ productId: string, restoreStatus: string }>} reversibilityPlan
 */
export async function revertProductStatusChange(shopifyClient, reversibilityPlan) {
  if (!shopifyClient || typeof shopifyClient.updateProductStatus !== "function") {
    throw new Error("Product status reversal requires an injected shopifyClient.");
  }
  const restored = [];
  const skipped = [];
  for (const entry of reversibilityPlan ?? []) {
    if (!entry?.productId || !VALID_STATUSES.has(entry?.restoreStatus)) {
      skipped.push({ productId: entry?.productId ?? null, reason: "malformed_plan_entry" });
      continue;
    }
    await shopifyClient.updateProductStatus(entry.productId, entry.restoreStatus);
    restored.push({ productId: entry.productId, restoreStatus: entry.restoreStatus });
  }
  return { restored, restoredCount: restored.length, skipped, skippedCount: skipped.length };
}
