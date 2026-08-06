// @ts-check

/**
 * Single source of truth for onboarding step order + the pure step-resolution
 * logic. Kept as a plain (client-safe, non-`.server`) module so both the route
 * component and the plain-Node test suite can import it — the resolution logic
 * takes primitives (no URL / no Prisma) precisely so it stays unit-testable.
 */

/** @typedef {"connect" | "insights" | "goals" | "plan"} OnboardingStep */

/** Ordered onboarding steps. Index order defines "furthest reached". */
/** @type {readonly OnboardingStep[]} */
export const ONBOARDING_STEPS = ["connect", "insights", "goals", "plan"];

/**
 * Position of a step in the onboarding order; -1 if it isn't a known step.
 * @param {string | null | undefined} step
 */
export function onboardingStepIndex(step) {
  return /** @type {readonly string[]} */ (ONBOARDING_STEPS).indexOf(step ?? "");
}

/**
 * Read + validate the persisted furthest step from a shop's onboarding metadata.
 * Always returns a valid step, defaulting to "connect" (never advanced).
 * @param {unknown} metadata
 * @returns {OnboardingStep}
 */
export function readFurthestStep(metadata) {
  const value =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? /** @type {Record<string, unknown>} */ (metadata).furthestStep
      : null;
  return typeof value === "string" &&
    /** @type {readonly string[]} */ (ONBOARDING_STEPS).includes(value)
    ? /** @type {OnboardingStep} */ (value)
    : "connect";
}

/**
 * Resolve which onboarding step to show. Pure + primitive-only so it is
 * unit-testable without a URL or the DB.
 *
 * - An explicit Insights/Goals/Plan request is honored even before the data is
 *   ready — the step renders its OWN "still building…" waiting scene rather than
 *   bouncing to Connect (that dead-end is what left those scenes unreachable).
 * - Only the no-explicit-step path gates on readiness, then resumes at the
 *   FURTHEST step reached rather than resetting to Connect.
 *
 * @param {{
 *   requestedStep?: string | null;
 *   memoryReady: boolean;
 *   backfillComplete: boolean;
 *   furthestStep?: OnboardingStep;
 * }} input
 * @returns {OnboardingStep}
 */
export function resolveOnboardingStep(input) {
  const requested = input.requestedStep ?? null;
  const furthest = input.furthestStep ?? "connect";
  // Honor an explicit content-step request even while memory/backfill are still
  // running: that step renders its OWN "still building…" waiting scene, which is
  // both a better experience than silently bouncing the merchant back to Connect
  // AND the only way those waiting scenes are ever reachable.
  if (requested === "insights") return "insights";
  if (requested === "goals") return "goals";
  if (requested === "plan") return "plan";
  if (requested === "connect") return "connect";
  // No explicit step: gate on readiness (still generating → Connect), otherwise
  // resume at the furthest step reached.
  if (!input.memoryReady || !input.backfillComplete) return "connect";
  return furthest;
}
