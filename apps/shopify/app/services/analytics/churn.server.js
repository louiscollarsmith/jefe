// @ts-check

import { track } from "./event-log.server.js";

const DAY_MS = 86_400_000;

/**
 * The churn side of the activity log. When a shop uninstalls we capture a
 * PII-free snapshot of *how far it got* before leaving — tenure, onboarding /
 * backfill / goals progress, COGS coverage, and a few aggregate counts — and
 * emit a `shop_uninstalled` event (topic "lifecycle"). That event, not a column
 * on the shop row, is the durable churn record the ops panel reads back.
 *
 * PII posture (mirrors event-log): only counts, booleans and tenure — never
 * customer data. `track()` redacts `properties` as a safety net regardless.
 */

/**
 * @typedef {object} ChurnCounts
 * @property {number} orders
 * @property {number} products
 * @property {number} memoryBeliefs
 */

/**
 * Build a PII-free churn snapshot. Pure + deterministic (clock and counts are
 * injected) so it is unit-testable without a DB.
 *
 * @param {{
 *   createdAt?: Date | string | null;
 *   onboardingCompletedAt?: Date | string | null;
 *   backfillCompletedAt?: Date | string | null;
 *   goalsCompleted?: boolean | null;
 *   houseRulesCompleted?: boolean | null;
 *   cogsCompletionPercentage?: unknown;
 *   cogsConfidenceLevel?: string | null;
 * }} shop
 * @param {ChurnCounts} counts
 * @param {Date} now
 * @returns {Record<string, unknown>}
 */
export function buildChurnSnapshot(shop, counts, now) {
  const createdAt = shop.createdAt ? new Date(shop.createdAt) : now;
  const tenureDays = Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS),
  );
  const cogsPct = Number(shop.cogsCompletionPercentage ?? 0);
  return {
    tenureDays,
    onboardingCompleted: Boolean(shop.onboardingCompletedAt),
    backfillCompleted: Boolean(shop.backfillCompletedAt),
    goalsCompleted: Boolean(shop.goalsCompleted),
    houseRulesCompleted: Boolean(shop.houseRulesCompleted),
    cogsCoveragePct: Number.isFinite(cogsPct) ? cogsPct : 0,
    cogsConfidence: shop.cogsConfidenceLevel ?? "missing",
    orders: counts.orders,
    products: counts.products,
    memoryBeliefs: counts.memoryBeliefs,
    reachedMemory: counts.memoryBeliefs > 0,
  };
}

/**
 * Capture a churn snapshot at uninstall and emit `shop_uninstalled`. Best-effort
 * and non-throwing: a capture failure must never block the uninstall webhook.
 *
 * @param {any} prisma
 * @param {{
 *   id: string;
 *   merchantId: string;
 *   shopDomain: string;
 *   createdAt?: Date | string | null;
 *   onboardingCompletedAt?: Date | string | null;
 *   backfillCompletedAt?: Date | string | null;
 *   goalsCompleted?: boolean | null;
 *   houseRulesCompleted?: boolean | null;
 *   cogsCompletionPercentage?: unknown;
 *   cogsConfidenceLevel?: string | null;
 * }} shop
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<Record<string, unknown> | null>} the snapshot (also emitted), or null on failure
 */
export async function captureShopChurn(prisma, shop, opts = {}) {
  try {
    const now = opts.now ?? new Date();
    const shopId = shop.id;
    const [orders, products, memoryBeliefs] = await Promise.all([
      prisma.order.count({ where: { shopId } }),
      prisma.product.count({ where: { shopId } }),
      prisma.merchantMemoryBelief.count({ where: { shopId } }),
    ]);
    const snapshot = buildChurnSnapshot(
      shop,
      { orders, products, memoryBeliefs },
      now,
    );

    await track(prisma, {
      type: "shop_uninstalled",
      topic: "lifecycle",
      merchantId: shop.merchantId,
      shopId,
      shopDomain: shop.shopDomain,
      summary: `Uninstalled after ${snapshot.tenureDays}d · ${orders} orders · ${products} products · ${memoryBeliefs} beliefs · ${
        snapshot.onboardingCompleted ? "onboarded" : "pre-onboarding"
      }`,
      properties: snapshot,
    });

    return snapshot;
  } catch {
    // Never block the uninstall path on a churn-capture failure.
    return null;
  }
}
