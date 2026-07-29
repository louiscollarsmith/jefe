// @ts-check

/**
 * Single source of truth for onboarding step order + the pure step-resolution
 * logic. Kept as a plain (client-safe, non-`.server`) module so both the route
 * component and the plain-Node test suite can import it — the resolution logic
 * takes primitives (no URL / no Prisma) precisely so it stays unit-testable.
 */

/** @typedef {"connect" | "channels" | "insights" | "goals" | "plan"} OnboardingStep */

/** Ordered onboarding steps. Index order defines "furthest reached". */
/** @type {readonly OnboardingStep[]} */
export const ONBOARDING_STEPS = ["connect", "channels", "insights", "goals", "plan"];

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
 * - Channels stays reachable even while memory is still generating (it needs no
 *   backfilled data) — otherwise "Skip"/"Continue to Channels" bounce to Connect.
 * - Insights / Goals / Plan require the generated memory + a complete backfill.
 * - With no explicit (or not-yet-ready) request, resume at the FURTHEST step
 *   reached rather than resetting to Connect (the resume fix).
 *
 * @param {{
 *   requestedStep?: string | null;
 *   hasChannelProvider?: boolean;
 *   memoryReady: boolean;
 *   backfillComplete: boolean;
 *   furthestStep?: OnboardingStep;
 * }} input
 * @returns {OnboardingStep}
 */
export function resolveOnboardingStep(input) {
  const requested = input.requestedStep ?? null;
  const furthest = input.furthestStep ?? "connect";
  if (requested === "channels" || input.hasChannelProvider) return "channels";
  if (!input.memoryReady || !input.backfillComplete) return "connect";
  if (requested === "insights") return "insights";
  if (requested === "goals") return "goals";
  if (requested === "plan") return "plan";
  if (requested === "connect") return "connect";
  // No explicit step and the data is ready → resume where they left off.
  return furthest;
}
