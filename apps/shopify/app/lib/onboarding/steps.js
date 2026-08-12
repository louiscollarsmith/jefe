// @ts-check

/**
 * Single source of truth for onboarding step order + the pure step-resolution
 * logic. Kept as a plain (client-safe, non-`.server`) module so both the route
 * component and the plain-Node test suite can import it — the resolution logic
 * takes primitives (no URL / no Prisma) precisely so it stays unit-testable.
 */

/** @typedef {"connect" | "context" | "insight" | "action" | "app"} OnboardingStep */

/** Ordered onboarding steps. Index order defines "furthest reached". */
/** @type {readonly OnboardingStep[]} */
export const ONBOARDING_STEPS = ["connect", "context", "insight", "action", "app"];

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
  if (["insights", "goals", "plan"].includes(String(value))) return "context";
  return typeof value === "string" &&
    /** @type {readonly string[]} */ (ONBOARDING_STEPS).includes(value)
    ? /** @type {OnboardingStep} */ (value)
    : "connect";
}

/**
 * Resolve which onboarding step to show. Pure + primitive-only so it is
 * unit-testable without a URL or the DB.
 *
 * - Legacy Insights/Goals/Plan requests map into Context so unfinished merchants
 *   resume in the new flow without losing their existing records.
 * - Explicit fast-flow scenes are honored; the normal path uses persisted
 *   bootstrap state to select what is actually ready to show.
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
  // Legacy links converge on the one-question Context scene.
  if (["insights", "goals", "plan"].includes(String(requested))) return "context";
  if (requested === "context") return "context";
  if (requested === "insight") return "insight";
  if (requested === "action") return "action";
  if (requested === "app") return "app";
  if (requested === "connect") return "connect";
  // Retained for rollback callers; the fast loader resolves from bootstrap state.
  if (!input.memoryReady || !input.backfillComplete) return "connect";
  return furthest;
}
