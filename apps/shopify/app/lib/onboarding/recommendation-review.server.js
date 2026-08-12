// @ts-check

const REVIEW_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Review every due track-only recommendation for a shop. This never overrides
 * typed ActionExecution outcomes: rows with a linked execution are excluded.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function reviewDueRecommendations(prisma, input) {
  const now = new Date();
  const due = await prisma.merchantPlanRecommendation.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceMode: "bootstrap",
      reviewStatus: "accepted",
      outcomeStatus: { in: ["pending", "insufficient"] },
      reviewAt: { lte: now },
      actionExecution: null,
    },
    orderBy: [{ reviewAt: "asc" }, { createdAt: "asc" }],
  });

  const results = [];
  for (const recommendation of due) {
    // The initial bootstrap recommendations intentionally have no typed
    // baseline/current evaluator yet. Re-observing a cited belief is not a
    // success measurement, so fail closed and schedule another deterministic
    // review instead of claiming an outcome.
    const nextReviewAt = new Date(now.getTime() + REVIEW_INTERVAL_MS);
    const outcomeStatus = "insufficient";
    const outcome = {
      result: "success_signal_not_yet_measurable",
      contractKey: contractKeyFromRecommendation(recommendation),
      reviewedAt: now.toISOString(),
      nextReviewAt: nextReviewAt.toISOString(),
    };
    await prisma.merchantPlanRecommendation.update({
      where: { id: recommendation.id },
      data: {
        outcomeStatus,
        outcomeMeasuredAt: now,
        outcome,
        completedAt: null,
        reviewAt: nextReviewAt,
      },
    });
    results.push({ recommendationId: recommendation.id, outcomeStatus });
  }

  const next = await prisma.merchantPlanRecommendation.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceMode: "bootstrap",
      reviewStatus: "accepted",
      outcomeStatus: { in: ["pending", "insufficient"] },
      reviewAt: { gt: now },
      actionExecution: null,
    },
    orderBy: { reviewAt: "asc" },
    select: { reviewAt: true },
  });
  input.logger?.info("Tracked recommendation review completed", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    reviewedCount: results.length,
    nextRunAfter: next?.reviewAt?.toISOString() ?? null,
  });
  return {
    reviewed: results.length,
    results,
    nextRunAfter: next?.reviewAt?.toISOString() ?? null,
  };
}

/** @param {any} recommendation */
function contractKeyFromRecommendation(recommendation) {
  const intent = recommendation.actionIntent;
  if (intent && typeof intent === "object" && !Array.isArray(intent)) {
    return typeof intent.contractKey === "string" ? intent.contractKey : null;
  }
  return null;
}
