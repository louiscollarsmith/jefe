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
 * Resolve a merchant's product reference against the local Shopify mirror.
 * The LLM supplies the reference; this function supplies identity. It never
 * invents Shopify IDs and it asks for clarification when a reference is broad.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; reference: string; supplierHint?: string | null }} input
 */
export async function resolveShopifyProductReference(prisma, input) {
  const wanted = normalizeMatch(input.reference);
  if (!wanted) return { ok: false, reason: "empty_reference", matches: [] };
  if (!prisma?.product?.findMany) {
    return { ok: false, reason: "catalog_unavailable", matches: [] };
  }

  const products = await prisma.product.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    select: {
      id: true,
      externalId: true,
      title: true,
      handle: true,
      status: true,
      vendor: true,
      productType: true,
      rawPayload: true,
      variants: {
        select: {
          id: true,
          externalId: true,
          title: true,
          sku: true,
          inventoryItemExternalId: true,
          rawPayload: true,
          inventoryLevels: { select: { available: true } },
        },
      },
    },
  });

  const velocityByProduct = await loadVelocityByProduct(prisma, input);
  const supplier = normalizeMatch(input.supplierHint ?? "");
  const scored = [];
  for (const product of products) {
    const base = productMatchScore(product, wanted);
    if (base <= 0) continue;
    const supplierBoost =
      supplier && normalizeMatch(product.vendor).includes(supplier) ? 6 : 0;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const inventory = variants.reduce(
      (/** @type {number} */ sum, /** @type {any} */ variant) =>
        sum + (inventoryFromLevels(variant.inventoryLevels) ?? 0),
      0,
    );
    const payload = jsonObject(product.rawPayload);
    const dailyVelocity =
      numberOrNull(payload.dailyVelocity) ??
      numberOrNull(payload.trailing30DailyVelocity) ??
      velocityByProduct.get(product.id) ??
      null;
    scored.push({
      score: base + supplierBoost,
      item: {
        title: product.title,
        productId: product.externalId,
        variantId: variants.length === 1 ? variants[0]?.externalId ?? null : null,
        inventoryItemId:
          variants.length === 1 ? variants[0]?.inventoryItemExternalId ?? null : null,
        available: inventory,
        dailyVelocity,
        daysOfCover:
          dailyVelocity && dailyVelocity > 0 ? Math.floor(inventory / dailyVelocity) : null,
        vendor: product.vendor ?? null,
        productType: product.productType ?? null,
        status: product.status ?? null,
        source: "merchant_added",
      },
    });
  }

  scored.sort((left, right) => right.score - left.score);
  const strong = scored.filter((row) => row.score >= 90);
  const plausible = scored.filter((row) => row.score >= 50);
  const matches = (strong.length ? strong : plausible).map((row) => row.item);
  if (strong.length === 1) return { ok: true, item: strong[0].item, matches };
  if (strong.length > 1) return { ok: false, reason: "ambiguous", matches };
  if (plausible.length === 1) return { ok: true, item: plausible[0].item, matches };
  if (plausible.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: false, reason: "not_found", matches: [] };
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

/** @param {any} prisma @param {{ merchantId: string; shopId: string }} input */
async function loadVelocityByProduct(prisma, input) {
  const map = new Map();
  if (!prisma?.orderLineItem?.groupBy) return map;
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.orderLineItem.groupBy({
      by: ["productId"],
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        productId: { not: null },
        order: { processedAt: { gte: since } },
      },
      _sum: { quantity: true },
    });
    for (const row of rows ?? []) {
      if (row.productId) map.set(row.productId, Number(row._sum?.quantity ?? 0) / 30);
    }
  } catch {
    return map;
  }
  return map;
}

/** @param {any} product @param {string} wanted */
function productMatchScore(product, wanted) {
  const fields = [
    product?.title,
    product?.handle,
    product?.vendor,
    ...(Array.isArray(product?.variants)
      ? product.variants.flatMap((/** @type {any} */ variant) => [variant?.title, variant?.sku])
      : []),
  ]
    .map(normalizeMatch)
    .filter(Boolean);
  if (fields.some((field) => field === wanted)) return 100;
  if (fields.some((field) => field.includes(wanted))) return 80;
  if (fields.some((field) => wanted.includes(field) && field.length > 3)) return 70;
  const wantedTokens = new Set(wanted.split(/\s+/).filter((token) => token.length > 2));
  let best = 0;
  for (const field of fields) {
    const tokens = field.split(/\s+/).filter((token) => token.length > 2);
    const overlap = tokens.filter((token) => wantedTokens.has(token)).length;
    if (overlap > 0) best = Math.max(best, Math.round((overlap / wantedTokens.size) * 60));
  }
  return best;
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
function normalizeMatch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
