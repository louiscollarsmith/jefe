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
 * @param {unknown} value
 * @param {Record<string, unknown>} update
 */
function mergeJsonObject(value, update) {
  const current =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { ...current, ...update };
}
