// @ts-check

/**
 * Bounded, typed reads for focused-action chat. The model never gets arbitrary
 * GraphQL; it asks for inspect/create/apply capabilities that this layer
 * implements against local commerce records (and, for writes, Change Sets).
 */

/**
 * Load local product/variant/inventory facts for the candidate ids on an action.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; changes?: any[] }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function inspectCandidates(prisma, input) {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const productIds = uniqueStrings(changes.map((item) => item?.productId));
  const variantIds = uniqueStrings(changes.map((item) => item?.variantId));
  /** @type {Record<string, any>} */
  const catalog = {};
  if (!productIds.length && !variantIds.length) return catalog;

  const [products, variants] = await Promise.all([
    prisma?.product?.findMany
      ? prisma.product.findMany({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            ...(productIds.length ? { externalId: { in: productIds } } : { id: { in: [] } }),
          },
          select: {
            id: true,
            externalId: true,
            title: true,
            status: true,
            vendor: true,
            productType: true,
            rawPayload: true,
            variants: {
              select: {
                id: true,
                externalId: true,
                title: true,
                price: true,
                inventoryLevels: { select: { available: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    variantIds.length && prisma?.variant?.findMany
      ? prisma.variant.findMany({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            externalId: { in: variantIds },
          },
          select: {
            id: true,
            externalId: true,
            title: true,
            price: true,
            product: {
              select: {
                externalId: true,
                title: true,
                status: true,
                vendor: true,
                productType: true,
                rawPayload: true,
              },
            },
            inventoryLevels: { select: { available: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  for (const product of products) {
    const record = catalogRecordFromProduct(product);
    catalog[product.externalId] = record;
    for (const variant of product.variants ?? []) {
      catalog[variant.externalId] = {
        ...record,
        variantId: variant.externalId,
        variantTitle: variant.title,
        price: numberOrNull(variant.price) ?? record.price,
        inventory: inventoryFromLevels(variant.inventoryLevels) ?? record.inventory,
      };
    }
  }
  for (const variant of variants) {
    const product = variant.product ?? {};
    const record = catalogRecordFromProduct({
      ...product,
      variants: [{ ...variant, inventoryLevels: variant.inventoryLevels }],
    });
    catalog[variant.externalId] = {
      ...record,
      variantId: variant.externalId,
      variantTitle: variant.title,
      price: numberOrNull(variant.price) ?? record.price,
      inventory: inventoryFromLevels(variant.inventoryLevels) ?? record.inventory,
    };
    if (product.externalId && !catalog[product.externalId]) {
      catalog[product.externalId] = record;
    }
  }
  return catalog;
}

/**
 * Restock evidence from Merchant Memory — assist only, no Shopify write.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function inspectRestockEvidence(prisma, input) {
  if (!prisma?.merchantMemoryBelief?.findFirst) return [];
  try {
    const belief = await prisma.merchantMemoryBelief.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        key: "inventory.low_cover_products.trailing_30d",
      },
      orderBy: { updatedAt: "desc" },
      select: { value: true, status: true },
    });
    const status = String(belief?.status ?? "");
    if (!belief || status.includes("superseded") || status.includes("rejected")) {
      return [];
    }
    const items = Array.isArray(belief.value?.items) ? belief.value.items : [];
    return items.slice(0, 40).map((/** @type {any} */ item) => ({
      title: String(item?.title ?? "").trim() || "Untitled product",
      productId: typeof item?.productId === "string" ? item.productId : null,
      available: numberOrNull(item?.available),
      dailyVelocity: numberOrNull(item?.dailyVelocity),
      daysOfCover: numberOrNull(item?.daysOfCover),
    }));
  } catch {
    return [];
  }
}

/**
 * @param {{ available: number | null; dailyVelocity: number | null }} item
 * @param {number} targetCoverDays
 */
export function recommendedPurchaseUnits(item, targetCoverDays) {
  if (item.available == null || item.dailyVelocity == null) return null;
  const days = Number(targetCoverDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.max(0, Math.ceil(item.dailyVelocity * days - item.available));
}

/** @param {any} product */
function catalogRecordFromProduct(product) {
  const payload = jsonObject(product?.rawPayload);
  const tags = tagsFromPayload(payload);
  const collections = collectionsFromPayload(payload);
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const inventory = variants.reduce(
    (/** @type {number} */ sum, /** @type {any} */ variant) => sum + (inventoryFromLevels(variant.inventoryLevels) ?? 0),
    0,
  );
  const price = numberOrNull(variants[0]?.price);
  return {
    productId: product?.externalId ?? null,
    title: product?.title ?? null,
    status: product?.status ?? null,
    vendor: product?.vendor ?? null,
    productType: product?.productType ?? null,
    tags,
    collections,
    inventory: variants.length ? inventory : null,
    price,
  };
}

/** @param {any} payload */
function tagsFromPayload(payload) {
  if (Array.isArray(payload.tags)) {
    return payload.tags.map((/** @type {any} */ tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof payload.tags === "string") {
    return payload.tags.split(",").map((/** @type {string} */ tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

/** @param {any} payload */
function collectionsFromPayload(payload) {
  const nodes =
    payload?.collections?.nodes ??
    payload?.collections ??
    payload?.collectionList ??
    [];
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((item) => ({
      id: item?.id ?? item?.externalId ?? null,
      title: item?.title ?? null,
      handle: item?.handle ?? null,
    }))
    .filter((item) => item.title || item.handle);
}

/** @param {any[]} levels */
function inventoryFromLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  return levels.reduce((sum, row) => sum + (Number(row?.available) || 0), 0);
}

/** @param {unknown[]} values */
function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

/** @param {unknown} value */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
