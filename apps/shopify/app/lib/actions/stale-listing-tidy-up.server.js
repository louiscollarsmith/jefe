// @ts-check

// Which products should Jefe tidy off the storefront?
//
// The `tidy_up` family's first target: a product that is LIVE, has NOTHING left to sell, and
// has sold nothing for a long time. A shopper who lands on it cannot buy — it is shelf space
// in a shop with no stock behind it, and it dilutes search, collections and the merchant's own
// read of their range. Archiving it is reversible to the exact previous status.
//
// ⛔ THREE GUARDS, and every one of them exists because without it Jefe proposes something
// catastrophic on a perfectly healthy store:
//
//   1. NEW-STORE GUARD. "No sales in 180 days" is trivially true of every product in a store
//      Jefe connected three weeks ago. Without a history check, day one of an install proposes
//      archiving the entire catalogue. So: propose nothing until the shop's own order history
//      is at least as long as the window.
//   2. UNKNOWN IS NOT ZERO. A variant with no ingested inventory level has unknown stock, not
//      zero stock. Treating unknown as zero would archive products that are actually in stock
//      and simply not synced yet. A product qualifies only if at least one of its variants has
//      a KNOWN level and none of the known ones are positive.
//   3. STOCK BEATS SILENCE. Any positive stock anywhere disqualifies the product outright,
//      whatever the sales history says. A slow seller with stock is dead stock — that is
//      clearance's job (mark it down and try to sell it), not tidy-up's. Tidy-up only touches
//      what cannot be sold at any price.
//
// Deterministic and pure at the core — no LLM. The decision to hide a merchant's product from
// their storefront is not one a model should be making from prose.
//
// Shape mirrors dead-stock-clearance.server.js: a pure core (`selectStaleListings`) that takes
// plain rows, and a thin DB layer (`buildStaleListingTidyUpProposal`) that queries and calls it.

/** How long a product must have sold nothing before it counts as stale. */
export const STALE_LISTING_WINDOW_DAYS = 180;

/** Never propose more than this in one run — the adapter caps too, this keeps the CARD honest. */
export const MAX_STALE_LISTINGS = 50;

/**
 * @typedef {Object} TidyProduct
 * @property {string} productId       internal uuid, for joining to variants
 * @property {string} externalId      the Shopify GID — the id the write client needs
 * @property {string | null} [title]
 * @property {string} status
 */
/**
 * @typedef {Object} TidyVariant
 * @property {string} variantId
 * @property {string} productId
 */

/**
 * The pure core. Given products, their variants, which variants sold in the window, and the
 * KNOWN available-unit totals per variant, return the products safe to archive.
 *
 * @param {{
 *   products: TidyProduct[],
 *   variants: TidyVariant[],
 *   soldVariantIds: Set<string>,
 *   availableByVariant: Map<string, number>,
 *   maxProducts?: number,
 * }} input
 * @returns {Array<{ productId: string, title: string | null, currentStatus: string, targetStatus: string, reason: string }>}
 */
export function selectStaleListings(input) {
  const variantsByProduct = new Map();
  for (const variant of input.variants) {
    const list = variantsByProduct.get(variant.productId) ?? [];
    list.push(variant);
    variantsByProduct.set(variant.productId, list);
  }

  const selected = [];
  for (const product of input.products) {
    if (product.status !== "ACTIVE") continue; // only live products are clutter
    const variants = variantsByProduct.get(product.productId) ?? [];
    if (variants.length === 0) continue; // nothing to reason about

    // Guard 3: sold anything in the window → not stale, whatever the stock says.
    if (variants.some((/** @type {TidyVariant} */ v) => input.soldVariantIds.has(v.variantId))) {
      continue;
    }

    // Guard 2: unknown is not zero. Need at least one KNOWN level, and no known level positive.
    let knownLevels = 0;
    let anyStock = false;
    for (const variant of variants) {
      const units = input.availableByVariant.get(variant.variantId);
      if (units === undefined) continue; // not synced — tells us nothing
      knownLevels += 1;
      if (units > 0) anyStock = true;
    }
    if (knownLevels === 0) continue; // stock entirely unknown → never act
    if (anyStock) continue; // clearance's problem, not tidy-up's

    selected.push({
      productId: product.externalId,
      title: product.title ?? null,
      currentStatus: "ACTIVE",
      targetStatus: "ARCHIVED",
      reason: "no_stock_no_sales",
    });
  }

  // Stable order so a rerun proposes the same set in the same order.
  selected.sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")) || a.productId.localeCompare(b.productId));
  const cap = Number.isInteger(input.maxProducts) && Number(input.maxProducts) > 0
    ? Math.min(Number(input.maxProducts), MAX_STALE_LISTINGS)
    : MAX_STALE_LISTINGS;
  return selected.slice(0, cap);
}

/**
 * Live proposal: read real store rows and return the products safe to archive. Read-only.
 * Returns `status: "no_stale_listings"` with an empty item list when there is nothing to do —
 * including on a store too new to judge, which is the common case at install.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; windowDays?: number; now?: Date; options?: { maxProducts?: number } }} input
 */
export async function buildStaleListingTidyUpProposal(prisma, input) {
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? STALE_LISTING_WINDOW_DAYS;
  const cutoff = new Date(now.getTime() - windowDays * 86400000);

  // Guard 1: the new-store guard, checked FIRST and cheaply. A shop whose own history is
  // shorter than the window cannot distinguish "never sells" from "we only just arrived".
  const firstOrder = await prisma.order.findFirst({
    where: { merchantId: input.merchantId, shopId: input.shopId },
    orderBy: { processedAt: "asc" },
    select: { processedAt: true },
  });
  if (!firstOrder?.processedAt || firstOrder.processedAt > cutoff) {
    return { status: "insufficient_history", windowDays, items: [], productCount: 0 };
  }

  const [products, variants, inventoryLevels, soldLineItems] = await Promise.all([
    prisma.product.findMany({
      where: { merchantId: input.merchantId, shopId: input.shopId, status: "ACTIVE" },
      select: { id: true, externalId: true, title: true, status: true },
    }),
    prisma.variant.findMany({
      where: { merchantId: input.merchantId, shopId: input.shopId },
      select: { id: true, productId: true },
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
    soldLineItems.map((/** @type {any} */ line) => line.variantId).filter(Boolean),
  );
  /** @type {Map<string, number>} */
  const availableByVariant = new Map();
  for (const level of inventoryLevels) {
    // `available == null` is UNKNOWN and must not become a 0 in this map — see guard 2.
    if (!level.variantId || level.available == null) continue;
    availableByVariant.set(
      level.variantId,
      (availableByVariant.get(level.variantId) ?? 0) + level.available,
    );
  }

  const items = selectStaleListings({
    products: products.map((/** @type {any} */ p) => ({
      productId: p.id,
      externalId: p.externalId,
      title: p.title,
      status: p.status,
    })),
    variants: variants.map((/** @type {any} */ v) => ({
      variantId: v.id,
      productId: v.productId,
    })),
    soldVariantIds,
    availableByVariant,
    maxProducts: input.options?.maxProducts,
  });

  return {
    status: items.length > 0 ? "proposed" : "no_stale_listings",
    windowDays,
    items,
    productCount: items.length,
  };
}
