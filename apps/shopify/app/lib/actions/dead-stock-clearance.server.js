// @ts-check

// Dead-stock clearance — the DECISION engine for Jefe's first executable action.
//
// This is the "belief → decision" half of the action loop: it turns what memory
// knows (which products aren't selling, what they cost, how much stock is on
// hand) into a concrete, safe clearance PROPOSAL. It performs NO external write —
// it produces a proposal object that the typed clearance adapter (execution layer)
// consumes behind a preview + approval + cap + reversibility contract.
//
// The uniquely-Jefe part is the safety floor: every suggested markdown is floored
// at unit cost, so Jefe never proposes selling a product below what it cost. A
// generic tool can't do this — it needs the per-variant cost (the margin/unitCost
// foundation). Variants already priced at or below cost are excluded from the
// auto-markdown and surfaced separately, because clearing them means taking a
// loss — a merchant judgement, not something to propose blindly.

/** @param {number} value */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
/** @param {number} value */
function round1(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}
/** @param {number} value */
function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Size a safe clearance markdown for each dead-stock item. Pure and deterministic.
 * Every suggested price is floored at unit cost (never below). Items already at or
 * below cost are excluded from the markdown set and only counted (belowCostCount),
 * since discounting them further is a loss the merchant must choose.
 * @param {Array<{ productId?: string; variantId?: string; title?: string | null; unitsOnHand: number; currentPrice: number; unitCost: number }>} items
 * @param {{ defaultDiscountPercent?: number }} [options]
 */
export function sizeClearanceMarkdowns(items, options = {}) {
  const defaultDiscount = clampPercent(options.defaultDiscountPercent ?? 30) / 100;
  const results = [];
  let totalTrappedCapital = 0;
  let totalProjectedRecovery = 0;
  let belowCostCount = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const units = Number(item.unitsOnHand) || 0;
    const price = Number(item.currentPrice) || 0;
    const cost = Number(item.unitCost);
    if (units <= 0 || price <= 0 || !Number.isFinite(cost) || cost < 0) continue;
    if (price <= cost) {
      // Already at or below cost — clearing means a loss; the merchant's call.
      belowCostCount += 1;
      continue;
    }
    const floorPrice = cost;
    const suggestedPrice = Math.max(price * (1 - defaultDiscount), floorPrice);
    const discountPercent = round1(((price - suggestedPrice) / price) * 100);
    const trappedCapital = round2(units * cost);
    const projectedRecovery = round2(units * suggestedPrice);
    totalTrappedCapital += trappedCapital;
    totalProjectedRecovery += projectedRecovery;
    results.push({
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      title: item.title ?? null,
      unitsOnHand: units,
      unitCost: round2(cost),
      currentPrice: round2(price),
      suggestedPrice: round2(suggestedPrice),
      floorPrice: round2(floorPrice),
      discountPercent,
      trappedCapital,
      projectedRecovery,
    });
  }

  results.sort((a, b) => b.trappedCapital - a.trappedCapital);
  return {
    items: results,
    deadStockVariantCount: results.length,
    belowCostCount,
    totalTrappedCapital: round2(totalTrappedCapital),
    totalProjectedRecovery: round2(totalProjectedRecovery),
  };
}

/**
 * Build a dead-stock clearance proposal for a merchant. Identifies dead stock —
 * variants of active products that have inventory on hand, no sales in the window,
 * and a KNOWN unit cost (so the markdown can be safely floored) — and sizes the
 * markdowns. Read-only: returns a proposal, writes nothing.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; windowDays?: number; now?: Date; options?: { defaultDiscountPercent?: number } }} input
 */
export async function buildDeadStockClearanceProposal(prisma, input) {
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? 90;
  const cutoff = new Date(now.getTime() - windowDays * 86400000);

  const [variants, inventoryLevels, soldLineItems] = await Promise.all([
    prisma.variant.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        product: { status: "ACTIVE" },
      },
      select: {
        id: true,
        productId: true,
        price: true,
        unitCost: true,
        product: { select: { title: true } },
      },
    }),
    prisma.inventoryLevel.findMany({
      where: { merchantId: input.merchantId, shopId: input.shopId },
      select: { variantId: true, available: true },
    }),
    prisma.orderLineItem.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        order: { processedAt: { gte: cutoff } },
      },
      select: { variantId: true },
    }),
  ]);

  const soldVariantIds = new Set(
    soldLineItems.map((line) => line.variantId).filter(Boolean),
  );
  const availableByVariant = new Map();
  for (const level of inventoryLevels) {
    if (!level.variantId || level.available == null) continue;
    availableByVariant.set(
      level.variantId,
      (availableByVariant.get(level.variantId) ?? 0) + level.available,
    );
  }

  const deadItems = [];
  for (const variant of variants) {
    if (soldVariantIds.has(variant.id)) continue; // sold in window → not dead
    const units = availableByVariant.get(variant.id) ?? 0;
    if (units <= 0) continue; // no stock → nothing trapped
    if (variant.unitCost == null) continue; // need cost to floor safely
    const price = variant.price == null ? 0 : Number(variant.price);
    if (price <= 0) continue;
    deadItems.push({
      productId: variant.productId,
      variantId: variant.id,
      title: variant.product?.title ?? null,
      unitsOnHand: units,
      currentPrice: price,
      unitCost: Number(variant.unitCost),
    });
  }

  const sized = sizeClearanceMarkdowns(deadItems, input.options);
  return {
    status: sized.items.length > 0 ? "proposed" : "no_dead_stock",
    windowDays,
    ...sized,
  };
}

/**
 * Shape a clearance proposal into a merchant-facing ADVISORY recommendation —
 * the propose-first front-end of the action. Pure: takes a proposal, returns a
 * render-ready object (structured numbers, not pre-formatted copy, so the surface
 * owns currency + voice). `executable: false` marks it advisory-only — the typed
 * execution adapter is separate and gated, so surfacing this can never trigger a
 * write. Returns `{ status: "no_opportunity" }` when there's nothing to clear.
 * @param {{ status?: string; windowDays?: number; deadStockVariantCount?: number; belowCostCount?: number; totalTrappedCapital?: number; totalProjectedRecovery?: number; items?: Array<{ productId?: string | null; variantId?: string | null; title?: string | null; unitsOnHand: number; currentPrice: number; suggestedPrice: number; discountPercent: number; trappedCapital: number }> }} proposal
 */
export function toClearanceRecommendation(proposal) {
  const windowDays = proposal?.windowDays ?? null;
  if (!proposal || proposal.status !== "proposed" || (proposal.deadStockVariantCount ?? 0) === 0) {
    return { status: "no_opportunity", windowDays };
  }
  const items = Array.isArray(proposal.items) ? proposal.items : [];
  return {
    status: "available",
    kind: "dead_stock_clearance",
    windowDays,
    variantCount: proposal.deadStockVariantCount ?? items.length,
    // Trapped cash the merchant would free, and the deterministic recovery estimate
    // at the cost-floored markdowns — both straight from the proposal, never guessed.
    trappedCapital: proposal.totalTrappedCapital ?? 0,
    projectedRecovery: proposal.totalProjectedRecovery ?? 0,
    // Variants already at/below cost — surfaced as a count, not auto-marked-down
    // (clearing at a loss is the merchant's call).
    belowCostCount: proposal.belowCostCount ?? 0,
    topItems: items.slice(0, 3).map((it) => ({
      title: it.title ?? null,
      variantId: it.variantId ?? null,
      unitsOnHand: it.unitsOnHand,
      currentPrice: it.currentPrice,
      suggestedPrice: it.suggestedPrice,
      discountPercent: it.discountPercent,
      trappedCapital: it.trappedCapital,
    })),
    executable: false,
  };
}

/**
 * Load a merchant's dead-stock clearance opportunity as an advisory recommendation.
 * Read-only wrapper over the decision engine + the advisory shaper. Writes nothing.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; windowDays?: number; now?: Date; options?: { defaultDiscountPercent?: number } }} input
 */
export async function buildClearanceRecommendation(prisma, input) {
  return toClearanceRecommendation(await buildDeadStockClearanceProposal(prisma, input));
}
