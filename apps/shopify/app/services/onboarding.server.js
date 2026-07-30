// @ts-check

import {
  onboardingStepIndex,
  readFurthestStep,
} from "../lib/onboarding/steps.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; metadata?: Record<string, unknown> }} input
 */
export async function completePlanOnboarding(prisma, input) {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: input.shopId },
    select: { onboardingMetadata: true },
  });
  return prisma.shop.update({
    where: { id: input.shopId },
    data: {
      onboardingCompletedAt: new Date(),
      onboardingMetadata: /** @type {any} */ (
        mergeJsonObject(shop.onboardingMetadata, {
          completedStep: "plan",
          completedSource: "jefe_onboarding_plan",
          ...(input.metadata ?? {}),
        })
      ),
    },
  });
}

/**
 * Record the furthest onboarding step a merchant has reached, so a later visit
 * can resume there instead of resetting to "connect".
 *
 * Self-guarding (belt-and-suspenders with the call-site check):
 *  - Reads the current metadata FRESH inside this call rather than trusting the
 *    caller's `currentMetadata` snapshot, so a concurrent write (e.g. plan
 *    completion's `completedStep`) isn't clobbered by a stale merge base.
 *  - MONOTONIC: only ever advances the furthest step, never regresses a
 *    returning merchant's resume point (a backward `?step=` nav, or a future
 *    caller that forgets to guard, can't rewind it).
 *  - Ignores an unknown step (no-op) rather than writing a bad value.
 *
 * `currentMetadata` is retained for call-site compatibility but is no longer the
 * merge base — the fresh read is.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; step: string; currentMetadata?: unknown }} input
 * @returns {Promise<{ onboardingMetadata: unknown } | null>}
 */
export async function recordFurthestOnboardingStep(prisma, input) {
  const stepIndex = onboardingStepIndex(input.step);
  if (stepIndex < 0) return null;

  const shop = await prisma.shop.findUnique({
    where: { id: input.shopId },
    select: { onboardingMetadata: true },
  });
  if (!shop) return null;

  const currentFurthest = readFurthestStep(shop.onboardingMetadata);
  if (stepIndex <= onboardingStepIndex(currentFurthest)) {
    return shop;
  }

  return prisma.shop.update({
    where: { id: input.shopId },
    data: {
      onboardingMetadata: /** @type {any} */ (
        mergeJsonObject(shop.onboardingMetadata, { furthestStep: input.step })
      ),
    },
  });
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} update
 */
function mergeJsonObject(value, update) {
  const current =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { ...current, ...update };
}
