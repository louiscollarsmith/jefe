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
  return isValidActionMode(row?.mode) ? /** @type {any} */ (row.mode) : DEFAULT_ACTION_MODE;
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
