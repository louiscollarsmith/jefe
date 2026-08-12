// @ts-check

// The `listing_copy` typed adapter — Jefe's THIRD executable action: fill in the product type
// on sellable products that have none. A faithful parallel of the clearance and
// product-status adapters (flag gate, blast-radius cap, idempotent per-target ledger writes,
// compare-and-set, auto-revert on partial failure, un-gated revert), reusing the generic
// `action_executions` / `action_execution_writes` ledger with NO migration.
//
// Built DARK behind `LISTING_COPY_EXECUTE_ENABLED` (default off). Settings → Autonomy shows
// "Listing copy" as SOON precisely because the dial needs registered + flag-on, so this file
// landing changes nothing a merchant sees.
//
// ⚠️ PRODUCT TYPE ONLY. The Autonomy row reads "descriptions, titles, product types", but
// those are not one job. A product type is a structured taxonomy string: reversible to the
// exact previous value, no voice, no judgement — and it is the field Jefe's own
// `business.range_composition` belief is gated on. Descriptions and titles are marketing
// PROSE on a live storefront in the merchant's voice; a wrong price is obviously wrong, wrong
// copy just sounds like the merchant wrote it. Widening this to prose is a deliberate step
// with a voice decision behind it, never a config tweak.
//
// Reference + recipe: docs/action-layer-implementation.md. Contract: context/11_actions_and_autonomy.md.

/** Blast-radius caps for a single listing-copy run. Setting a text field has no magnitude, so no discount cap. */
export const DEFAULT_LISTING_COPY_CAPS = {
  maxProducts: 100,
  minConfidence: 0.9,
  maxTypeLength: 60,
};

/** Exact-string, default-off — identical discipline to CLEARANCE_EXECUTE_ENABLED. */
export function isListingCopyExecuteEnabled() {
  return process.env.LISTING_COPY_EXECUTE_ENABLED === "true";
}

/** Shopify stores an unset product type as "", and whitespace is just as unset. */
function isBlankType(value) {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Pure dry-run. Writes nothing.
 *
 * ⛔ THE LOAD-BEARING RULE: a change survives only when the CURRENT type is blank. Jefe fills
 * gaps; it never re-categorises a product the merchant has already typed. Someone who has
 * curated their taxonomy — even into categories Jefe would not have chosen — has made a
 * decision, and silently rewriting it would be Jefe overruling the merchant about their own
 * catalogue. Everything non-blank is REFUSED and recorded as such, not quietly dropped.
 * @param {{ items?: Array<{ productId: string | null, title?: string | null, currentType?: string | null, proposedType: string }> }} proposal
 * @param {typeof DEFAULT_LISTING_COPY_CAPS} [caps]
 */
export function buildListingCopyPreview(proposal, caps = DEFAULT_LISTING_COPY_CAPS) {
  const changes = [];
  const refused = [];
  const seen = new Set();
  for (const item of proposal?.items ?? []) {
    if (!item?.productId) continue;
    if (seen.has(item.productId)) {
      refused.push({ productId: item.productId, reason: "duplicate_target" });
      continue;
    }
    seen.add(item.productId);
    const proposed = typeof item.proposedType === "string" ? item.proposedType.trim() : "";
    if (!isBlankType(item.currentType)) {
      refused.push({ productId: item.productId, reason: "already_typed" });
      continue;
    }
    if (!proposed) {
      refused.push({ productId: item.productId, reason: "empty_proposed_type" });
      continue;
    }
    if (proposed.length > caps.maxTypeLength) {
      // A product type is a category, not a sentence. An over-long one is a sign the
      // generator has written a description into the wrong field.
      refused.push({ productId: item.productId, reason: "proposed_type_too_long" });
      continue;
    }
    changes.push({
      productId: item.productId,
      title: item.title ?? null,
      fromType: "",
      toType: proposed,
    });
  }
  return {
    changes,
    productCount: changes.length,
    refused,
    // Authoritative restore source; mirrored per-target into ActionExecutionWrite.expectedFrom.
    // Restoring means putting the field back to empty — the merchant had no type before and
    // undoing must leave no trace, not a guess at what they might have wanted.
    reversibilityPlan: changes.map((change) => ({
      productId: change.productId,
      restoreType: change.fromType,
    })),
  };
}

/** Blocks (never trims) an over-cap run. */
export function enforceBlastRadiusCap(preview, caps = DEFAULT_LISTING_COPY_CAPS) {
  const violations = [];
  if (preview.productCount > caps.maxProducts) {
    violations.push({ cap: "maxProducts", limit: caps.maxProducts, actual: preview.productCount });
  }
  return { withinCap: violations.length === 0, violations };
}

/** reversible ∧ within-cap ∧ confident — computed here, never trusted from upstream. */
export function computeListingCopyAutoEligibility(preview, confidence, caps = DEFAULT_LISTING_COPY_CAPS) {
  const reversible =
    preview.productCount > 0 && preview.reversibilityPlan.length === preview.productCount;
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

/** Best-effort restore of already-applied changes (the auto-revert-on-partial-failure path). */
async function restoreApplied(shopifyClient, plan) {
  const restored = [];
  const failed = [];
  for (const entry of plan ?? []) {
    if (!entry?.productId) continue;
    try {
      await shopifyClient.updateProductType(entry.productId, entry.restoreType ?? "");
      restored.push({ productId: entry.productId, restoreType: entry.restoreType ?? "" });
    } catch (err) {
      failed.push({
        productId: entry.productId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { restored, failed };
}

/**
 * Un-gated revert. Deliberately NOT behind the execute flag: turning the feature off must
 * never strand a merchant with changes they cannot undo.
 * @param {{ updateProductType: (id: string, type: string) => Promise<unknown> }} shopifyClient
 * @param {Array<{ productId: string, restoreType?: string }>} reversibilityPlan
 */
export async function revertListingCopyChange(shopifyClient, reversibilityPlan) {
  if (!shopifyClient || typeof shopifyClient.updateProductType !== "function") {
    throw new Error("Listing-copy revert requires an injected shopifyClient with updateProductType.");
  }
  return restoreApplied(shopifyClient, reversibilityPlan);
}

/**
 * Execute an approved listing-copy change. THE ONLY WRITE PATH. Triple-guarded (flag →
 * injected ledger → injected client → recommend-mode refusal → cap re-check); idempotent per
 * target; compare-and-set against the live product type; auto-reverts already-applied changes
 * on partial failure.
 *
 * @param {{ prisma: any, shopifyClient: { getProductType: (id: string) => Promise<string | null>, updateProductType: (id: string, type: string) => Promise<unknown> }, execution: any }} deps
 * @param {ReturnType<typeof buildListingCopyPreview>} preview
 * @param {{ caps?: typeof DEFAULT_LISTING_COPY_CAPS }} [options]
 */
export async function applyListingCopyChange({ prisma, shopifyClient, execution }, preview, options = {}) {
  if (!isListingCopyExecuteEnabled()) {
    throw new Error("Listing-copy execution is disabled (LISTING_COPY_EXECUTE_ENABLED is not 'true').");
  }
  if (!prisma?.actionExecution || !prisma?.actionExecutionWrite) {
    throw new Error("Listing-copy execution requires an injected prisma client with the action-execution ledger.");
  }
  if (
    !shopifyClient ||
    typeof shopifyClient.updateProductType !== "function" ||
    typeof shopifyClient.getProductType !== "function"
  ) {
    throw new Error("Listing-copy execution requires an injected shopifyClient with getProductType + updateProductType.");
  }
  if (execution?.resolvedMode === "recommend") {
    throw new Error("Listing-copy execution called in 'recommend' mode — advisory actions do not execute.");
  }
  const caps = options.caps ?? DEFAULT_LISTING_COPY_CAPS;
  const cap = enforceBlastRadiusCap(preview, caps);
  if (!cap.withinCap) {
    throw new Error(`Listing-copy change exceeds blast-radius cap: ${JSON.stringify(cap.violations)}`);
  }

  const parent = await prisma.actionExecution.upsert({
    where: { runId: execution.runId },
    create: {
      runId: execution.runId,
      merchantId: execution.merchantId,
      shopId: execution.shopId,
      actionType: execution.actionType ?? "listing_copy",
      actionKind: execution.actionKind ?? "set_product_type",
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
      const targetValueKey = `productType:${change.toType}`;
      const write = await prisma.actionExecutionWrite.upsert({
        where: {
          executionId_targetRef_targetValueKey: {
            executionId: parent.id,
            targetRef: change.productId,
            targetValueKey,
          },
        },
        create: {
          executionId: parent.id,
          targetRef: change.productId,
          targetValueKey,
          expectedFrom: { productType: change.fromType },
          targetValue: { productType: change.toType },
          status: "pending",
        },
        update: {},
      });
      if (write.status === "applied") {
        applied.push({ productId: change.productId, toType: change.toType, idempotent: true });
        continue;
      }

      // Compare-and-set against the LIVE value. Between proposal and execution the merchant
      // may well have typed the product themselves — that is the likeliest race here, and
      // overwriting their choice is exactly the failure this action must not have.
      const liveType = await shopifyClient.getProductType(change.productId);
      if (!isBlankType(liveType)) {
        await prisma.actionExecutionWrite.update({
          where: { id: write.id },
          data: { status: "skipped", skipReason: "already_typed_upstream", observedFrom: { productType: liveType } },
        });
        skipped.push({ productId: change.productId, reason: "already_typed_upstream", liveType });
        continue;
      }

      await shopifyClient.updateProductType(change.productId, change.toType);
      await prisma.actionExecutionWrite.update({
        where: { id: write.id },
        data: { status: "applied", appliedAt: new Date() },
      });
      applied.push({ productId: change.productId, toType: change.toType, idempotent: false });
    }
  } catch (error) {
    // Partial failure: put back only what this run actually changed, then surface the error.
    const revert = await restoreApplied(
      shopifyClient,
      applied.filter((entry) => !entry.idempotent).map((entry) => ({ productId: entry.productId, restoreType: "" })),
    );
    await prisma.actionExecution.update({
      where: { id: parent.id },
      data: {
        status: "reverted",
        outcomeStatus: "failed",
        outcome: {
          error: error instanceof Error ? error.message : String(error),
          appliedBeforeFailure: applied.length,
          revert,
        },
      },
    });
    throw error;
  }

  await prisma.actionExecution.update({
    where: { id: parent.id },
    data: {
      status: "applied",
      appliedAt: new Date(),
      outcomeStatus: "applied",
      outcome: { appliedCount: applied.length, skippedCount: skipped.length },
    },
  });
  return { applied, skipped, refused: preview.refused, executionId: parent.id };
}
