// @ts-check

// The autonomy dial's storage — the merchant's mode per action-type. This is the
// "how policy is used" half: the surface (the 3-mode picker) sets + shows the mode;
// the resolution layer reads it to drive resolveAutonomyMode (auto vs propose vs
// recommend-only). One row per (merchant, action-type); absent = the safe default.
//
//   recommend       → advisory only, no execute (Jefe suggests; the merchant acts).
//   approve_execute → Jefe proposes, the merchant approves, Jefe executes (default).
//   autonomous      → Jefe auto-executes when structurally eligible.

/** The valid autonomy modes (the stored setting values). */
export const ACTION_MODES = /** @type {const} */ (["recommend", "approve_execute", "autonomous"]);

/** Default when a merchant hasn't set a dial for an action-type: propose-first. */
export const DEFAULT_ACTION_MODE = "approve_execute";

/** @param {any} mode */
export function isValidActionMode(mode) {
  return typeof mode === "string" && ACTION_MODES.includes(/** @type {any} */ (mode));
}

/**
 * Read the merchant's autonomy mode for an action-type. Defaults to approve_execute
 * (propose-first) when no dial has been set — never auto by default.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionType: string }} input
 * @returns {Promise<"recommend" | "approve_execute" | "autonomous">}
 */
export async function getActionMode(prisma, input) {
  const row = await prisma.actionAutonomyPolicy.findUnique({
    where: { merchantId_actionType: { merchantId: input.merchantId, actionType: input.actionType } },
    select: { mode: true },
  });
  if (row && isValidActionMode(row.mode)) return /** @type {any} */ (row.mode);
  return DEFAULT_ACTION_MODE;
}

/**
 * Set (upsert) the merchant's autonomy mode for an action-type. Validates the mode —
 * an unknown value is refused, never stored (so the gate can trust what it reads).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionType: string; mode: string }} input
 */
export async function setActionMode(prisma, input) {
  if (!isValidActionMode(input.mode)) return { status: "invalid_mode", mode: input.mode };
  await prisma.actionAutonomyPolicy.upsert({
    where: { merchantId_actionType: { merchantId: input.merchantId, actionType: input.actionType } },
    create: { merchantId: input.merchantId, actionType: input.actionType, mode: input.mode },
    update: { mode: input.mode },
  });
  return { status: "ok", mode: input.mode };
}

// ---------------------------------------------------------------------------
// Autonomy-as-policy — the governance layer on top of the mode dial. Matt's steer:
// broad per-action-type policies ("clear dead stock autonomously up to £X"), NOT a
// settings page of minute caps. A policy only ever CONSTRAINS the "autonomous" mode:
// an auto run that exceeds a cap degrades to approve-first (never widens). Built AFTER
// the dial works (it does), and orthogonal to the structural safety caps, which always
// apply underneath regardless of policy.
// ---------------------------------------------------------------------------

/** The autonomy-policy caps a merchant can set per action-type (all optional). */
export const AUTONOMY_POLICY_KEYS = /** @type {const} */ ([
  "autoMaxTrappedCapital", // max £ tied up in a single auto run
  "autoMaxVariants", // max variants touched in a single auto run
  "autoMaxDiscountPercent", // max markdown auto-applied
]);

/**
 * Read the merchant's autonomy POLICY for an action-type (the caps that gate the
 * "autonomous" mode). Returns {} when none is set. Only finite, non-negative numeric
 * caps are kept — an unparseable stored value is ignored, so the gate can trust it.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionType: string }} input
 * @returns {Promise<Record<string, number>>}
 */
export async function getActionPolicy(prisma, input) {
  const row = await prisma.actionAutonomyPolicy.findUnique({
    where: { merchantId_actionType: { merchantId: input.merchantId, actionType: input.actionType } },
    select: { policy: true },
  });
  return normalizeAutonomyPolicy(row?.policy);
}

/**
 * Set (upsert) the merchant's autonomy policy for an action-type. Only the known caps
 * are stored, each a finite non-negative number — anything else is dropped, so a bad
 * value can never widen autonomy. Passing {} clears the caps.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionType: string; policy: Record<string, unknown> }} input
 */
export async function setActionPolicy(prisma, input) {
  const policy = normalizeAutonomyPolicy(input.policy);
  await prisma.actionAutonomyPolicy.upsert({
    where: { merchantId_actionType: { merchantId: input.merchantId, actionType: input.actionType } },
    create: { merchantId: input.merchantId, actionType: input.actionType, mode: DEFAULT_ACTION_MODE, policy: /** @type {any} */ (policy) },
    update: { policy: /** @type {any} */ (policy) },
  });
  return { status: "ok", policy };
}

/** Keep only known, finite, non-negative numeric caps. @param {unknown} raw */
function normalizeAutonomyPolicy(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of AUTONOMY_POLICY_KEYS) {
    const value = Number(/** @type {any} */ (raw)[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * Apply the autonomy POLICY on top of the resolved mode — the governance gate. Only the
 * "auto" mode is policy-gated: if the run exceeds any set cap, it degrades to "approve"
 * (ask the merchant first) with the violated caps named. Never widens (recommend/approve
 * pass through untouched), and an empty policy is a no-op. Pure. The structural safety
 * caps in the adapter still apply underneath, always.
 * @param {{ mode: "recommend" | "approve" | "auto"; reason: string }} resolved  from resolveAutonomyMode
 * @param {Record<string, number>} policy  from getActionPolicy
 * @param {{ trappedCapital?: number; variantCount?: number; maxDiscountPercent?: number }} context  the run's magnitude
 * @returns {{ mode: "recommend" | "approve" | "auto"; reason: string; policyViolations?: string[] }}
 */
export function applyAutonomyPolicy(resolved, policy, context) {
  if (resolved.mode !== "auto" || !policy) return resolved;
  const violations = [];
  if (policy.autoMaxTrappedCapital != null && Number(context.trappedCapital) > policy.autoMaxTrappedCapital) {
    violations.push("over_auto_max_trapped_capital");
  }
  if (policy.autoMaxVariants != null && Number(context.variantCount) > policy.autoMaxVariants) {
    violations.push("over_auto_max_variants");
  }
  if (policy.autoMaxDiscountPercent != null && Number(context.maxDiscountPercent) > policy.autoMaxDiscountPercent) {
    violations.push("over_auto_max_discount_percent");
  }
  if (violations.length === 0) return resolved;
  return { mode: "approve", reason: "exceeds_autonomy_policy", policyViolations: violations };
}
