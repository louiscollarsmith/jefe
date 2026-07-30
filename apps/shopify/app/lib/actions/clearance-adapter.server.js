// @ts-check

// Clearance execution adapter — the EXECUTION half of Jefe's first action.
//
// ⚠️  ONE-WAY DOOR / NOT LIVE. This is the only place in the action loop that
// would write to a merchant's Shopify store (variant prices). It is deliberately
// built so it CANNOT run by accident, pending founder + architecture sign-off:
//   - FLAGGED OFF   — CLEARANCE_EXECUTE_ENABLED must be exactly "true" (default off).
//   - UNWIRED       — nothing in the app calls applyClearance().
//   - INJECTED      — applyClearance() requires a shopifyClient to be passed in;
//                     no code here constructs a real one.
// The safety logic (preview, blast-radius cap, auto-eligibility gate,
// reversibility plan) is pure and fully tested. Turning this on is a reviewed,
// deliberate step — not a code path that can fire unattended.

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

/** @param {number} value */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Build the preview a merchant approves: the exact per-variant price change and
 * the reversibility plan (prior prices to restore). Pure; writes nothing. Only
 * genuine markdowns (to-price strictly below from-price, both positive) survive.
 * @param {{ items?: Array<{ variantId: string; title?: string | null; currentPrice: number; suggestedPrice: number }> }} proposal
 */
export function buildClearancePreview(proposal) {
  const changes = [];
  for (const item of proposal?.items ?? []) {
    const from = round2(item.currentPrice);
    const to = round2(item.suggestedPrice);
    if (!(from > 0) || !(to > 0) || to >= from) continue;
    changes.push({
      variantId: item.variantId,
      title: item.title ?? null,
      fromPrice: from,
      toPrice: to,
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
    // Reversibility: restore each variant to the price it had before.
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
 * The auto-eligibility gate: an action may auto-run ONLY if it structurally clears
 * reversible ∧ blast_radius ≤ cap ∧ confidence ≥ threshold. Computed here, never
 * trusted from a prompt. A clearance is always reversible (restore prices), so it
 * comes down to cap + confidence. Fail any → not auto-eligible → ask-then-act.
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
 * Execute an approved clearance preview. ⚠️ THE ONLY WRITE PATH. Refuses to run
 * unless execution is explicitly enabled AND an injected shopifyClient is
 * provided, and it re-checks the blast-radius cap before writing anything. Writes
 * one variant price at a time via the injected client (idempotent per
 * variant+target-price). Returns what it applied plus the reversibility plan.
 * @param {{ updateVariantPrice: (variantId: string, price: number) => Promise<unknown> }} shopifyClient
 * @param {ReturnType<typeof buildClearancePreview>} preview
 * @param {{ caps?: typeof DEFAULT_CLEARANCE_CAPS }} [options]
 */
export async function applyClearance(shopifyClient, preview, options = {}) {
  if (!isClearanceExecuteEnabled()) {
    throw new Error(
      "Clearance execution is disabled (CLEARANCE_EXECUTE_ENABLED is not 'true').",
    );
  }
  if (!shopifyClient || typeof shopifyClient.updateVariantPrice !== "function") {
    throw new Error("Clearance execution requires an injected shopifyClient.");
  }
  const cap = enforceBlastRadiusCap(preview, options.caps ?? DEFAULT_CLEARANCE_CAPS);
  if (!cap.withinCap) {
    throw new Error(
      `Clearance exceeds blast-radius cap: ${JSON.stringify(cap.violations)}`,
    );
  }
  const applied = [];
  for (const change of preview.changes) {
    await shopifyClient.updateVariantPrice(change.variantId, change.toPrice);
    applied.push({ variantId: change.variantId, toPrice: change.toPrice });
  }
  return {
    applied,
    appliedCount: applied.length,
    reversibilityPlan: preview.reversibilityPlan,
  };
}
