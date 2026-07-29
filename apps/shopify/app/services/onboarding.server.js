// @ts-check

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
 * can resume there instead of resetting to "connect". Additive merge onto the
 * existing metadata — the caller decides (via step ordering) whether the step is
 * actually an advance before calling.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; step: string; currentMetadata?: unknown }} input
 */
export async function recordFurthestOnboardingStep(prisma, input) {
  return prisma.shop.update({
    where: { id: input.shopId },
    data: {
      onboardingMetadata: /** @type {any} */ (
        mergeJsonObject(input.currentMetadata, { furthestStep: input.step })
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
