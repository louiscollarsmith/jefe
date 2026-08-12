// @ts-check
//
// Load mapped Quiver rows into a corpus database.
//
// The corpus database has the SAME schema as the Shopify app — it is the same
// Prisma schema pointed at a different database. That is the whole trick: once the
// rows are in, every downstream stage (derivations → beliefs → evidence → insights
// → goals → plan → action proposals) runs unmodified.
//
// SCOPE (architecture ruling, 2026-08-12): loaded data → derivations → beliefs →
// action PROPOSALS. Corpus shops must never be routed through the Shopify backfill
// worker or the action-execution adapters — both assume a Shopify session and
// offline token a corpus shop does not have.

import {
  CORPUS_PLATFORM,
  corpusShopMetadata,
  deriveCatalog,
  dominantCurrency,
  mapQuiverOrder,
} from "./map.mjs";
import { assertCorpusShop, corpusShopDomain } from "./safety.mjs";

/**
 * Structured log line. Tools in this repo log JSON to stdout rather than importing
 * the app's server logger (which pulls in app runtime config); same discipline —
 * identifiers and counts, never customer data.
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
function log(event, fields = {}) {
  console.log(JSON.stringify({ component: "quiver-corpus", event, ...fields }));
}

/**
 * Create (or reuse) the Merchant + Shop a Quiver merchant is simulated under.
 *
 * The Shop is stamped `platform: "quiver_sim"` with an unresolvable
 * `*.corpus.invalid` domain, and carries the coverage gaps in `onboardingMetadata`
 * so the limits of this data travel with it rather than living only in a README.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ quiverMerchantId: string | number, merchantName?: string | null, platform?: string | null }} merchant
 */
export async function ensureCorpusShop(prisma, merchant) {
  const shopDomain = corpusShopDomain(merchant.quiverMerchantId);
  const displayName = merchant.merchantName?.trim() || `Quiver merchant ${merchant.quiverMerchantId}`;

  const existing = await prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: CORPUS_PLATFORM, shopDomain } },
  });
  if (existing) {
    log("shop.reused", { shopDomain, shopId: existing.id });
    return assertCorpusShop(existing);
  }

  const merchantRow = await prisma.merchant.create({
    data: { name: `[corpus] ${displayName}`, status: "active" },
  });
  const shop = await prisma.shop.create({
    data: {
      merchantId: merchantRow.id,
      platform: CORPUS_PLATFORM,
      shopDomain,
      externalShopId: String(merchant.quiverMerchantId),
      status: "active",
      // Not "installed": a corpus shop was never installed and has no session. Any
      // code reading setupStatus should see something it does not recognise as a
      // live tenant rather than something it mistakes for one.
      setupStatus: "corpus",
      historicalOrderAccess: "full",
      onboardingMetadata: corpusShopMetadata({
        platform: merchant.platform,
        merchantName: displayName,
      }),
    },
  });
  log("shop.created", { shopDomain, shopId: shop.id, merchantId: merchantRow.id });
  return assertCorpusShop(shop);
}

/**
 * Load one merchant's mapped orders into the corpus database.
 *
 * Idempotent: re-running with the same source produces the same state, because
 * every external id is derived deterministically (see `map.mjs` — Quiver's own row
 * ids are per-ETL-run uuids and cannot be used for this).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchant: { quiverMerchantId: string | number, merchantName?: string | null, platform?: string | null },
 *   orders: Array<{ order: Record<string, any>, prices?: Array<Record<string, any>>, lineItems?: Array<Record<string, any>> }>,
 * }} source
 * @param {{
 *   customerSalt: string,
 *   includePersonalFields?: boolean,
 *   quarantineAnomalies?: boolean,
 *   batchSize?: number,
 * }} options
 */
export async function loadCorpusMerchant(prisma, source, options) {
  const {
    customerSalt,
    includePersonalFields = false,
    quarantineAnomalies = true,
    batchSize = 200,
  } = options;

  const shop = await ensureCorpusShop(prisma, source.merchant);

  // Pick the merchant's single currency BEFORE mapping. Quiver stores
  // presentmentMoney, so its amounts are in whatever the customer paid in and are
  // not summable — but Jefe sums `totalPrice` assuming one currency. Loading one
  // currency per corpus shop is what makes the corpus semantically the same shape
  // as a real Shopify store. See the note above `dominantCurrency` in map.mjs.
  const base = dominantCurrency(
    (source.orders ?? []).flatMap((row) =>
      (row.prices ?? []).map((price) => price?.currency_code)),
  );
  log("currency.selected", {
    shopDomain: shop.shopDomain,
    baseCurrency: base.currency,
    share: Math.round(base.share * 1000) / 1000,
  });

  const context = {
    merchantId: shop.merchantId,
    shopId: shop.id,
    customerSalt,
    includePersonalFields,
    baseCurrency: base.currency,
    preferredCurrency: base.currency ?? "GBP",
  };

  const mapped = [];
  const quarantined = [];
  /** @type {Record<string, number>} */
  const anomalyCounts = {};

  for (const row of source.orders ?? []) {
    const result = mapQuiverOrder(row, context);
    for (const code of result.anomalies) {
      anomalyCounts[code] = (anomalyCounts[code] ?? 0) + 1;
    }
    if (result.anomalies.length && quarantineAnomalies) {
      quarantined.push({ externalId: result.order.externalId, anomalies: result.anomalies });
      continue;
    }
    mapped.push(result);
  }

  // Counted and logged even when zero, so "no anomalies" is a stated result rather
  // than an absent line someone reads as "the check didn't run".
  log("orders.mapped", {
    shopDomain: shop.shopDomain,
    mapped: mapped.length,
    quarantined: quarantined.length,
    anomalyCounts,
  });

  const written = await loadCorpusRows(prisma, shop, mapped, { batchSize });

  const summary = {
    ...written,
    baseCurrency: base.currency,
    // What fraction of the merchant's orders this corpus shop actually represents.
    // Stated always, so "we loaded this store" is never mistaken for "we loaded all
    // of it" — the foreign-currency orders are real trade we could not carry.
    currencyCoverage: Math.round(base.share * 1000) / 1000,
    quarantined: quarantined.length,
    anomalyCounts,
  };
  log("load.complete", summary);
  return { ...summary, quarantinedOrders: quarantined };
}

/**
 * Write already-mapped rows against a corpus shop.
 *
 * Exported deliberately: this is THE entry point for anything that writes corpus
 * data, and the `assertCorpusShop` below is the single enforcement point. It is
 * reachable — and tested — independently of `ensureCorpusShop`, which is what makes
 * the isolation enforced rather than conventional: a future caller that resolves a
 * shop itself and skips `ensureCorpusShop` still cannot write through here.
 *
 * ⚠️ An earlier version also re-asserted inside every write batch. Mutation testing
 * showed that check was dead — deleting it left every test green, because the entry
 * assertion already caught it. Removed rather than kept as decoration; if you add a
 * write path that does NOT come through here, it needs its own assertion and its own
 * test, because this one will not cover you.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ id: string, merchantId: string, platform: string, shopDomain: string }} shop
 * @param {Array<{ order: Record<string, any>, lineItems: Array<Record<string, any>>, refund: Record<string, any> | null }>} mapped
 * @param {{ batchSize?: number }} [options]
 */
export async function loadCorpusRows(prisma, shop, mapped, options = {}) {
  const batchSize = options.batchSize ?? 200;
  assertCorpusShop(shop);

  const catalog = deriveCatalog(mapped.flatMap((entry) => entry.lineItems), {
    merchantId: shop.merchantId,
    shopId: shop.id,
  });

  const productIds = await loadProducts(prisma, shop, catalog.products, batchSize);
  const variantIds = await loadVariants(prisma, shop, catalog.variants, productIds, batchSize);
  const orders = await loadOrders(prisma, shop, mapped, { productIds, variantIds, batchSize });

  return {
    shopDomain: shop.shopDomain,
    shopId: shop.id,
    merchantId: shop.merchantId,
    products: productIds.size,
    variants: variantIds.size,
    orders,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} shop
 * @param {Array<Record<string, any>>} products
 * @param {number} batchSize
 */
async function loadProducts(prisma, shop, products, batchSize) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  for (const batch of chunk(products, batchSize)) {
    for (const product of batch) {
      const row = await prisma.product.upsert({
        where: { shopId_externalId: { shopId: shop.id, externalId: product.externalId } },
        create: product,
        update: { title: product.title, rawPayload: product.rawPayload },
      });
      ids.set(product.externalId, row.id);
    }
  }
  return ids;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} shop
 * @param {Array<Record<string, any>>} variants
 * @param {Map<string, string>} productIds
 * @param {number} batchSize
 */
async function loadVariants(prisma, shop, variants, productIds, batchSize) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  for (const batch of chunk(variants, batchSize)) {
    for (const variant of batch) {
      const productId = productIds.get(variant.productExternalId);
      // Variant.productId is required and non-null; a variant whose product never
      // materialised is dropped rather than attached to an arbitrary product.
      if (!productId) continue;
      const { productExternalId, ...data } = variant;
      const row = await prisma.variant.upsert({
        where: { shopId_externalId: { shopId: shop.id, externalId: variant.externalId } },
        create: { ...data, productId },
        update: { sku: variant.sku, title: variant.title, rawPayload: variant.rawPayload },
      });
      ids.set(variant.externalId, row.id);
    }
  }
  return ids;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} shop
 * @param {Array<{ order: Record<string, any>, lineItems: Array<Record<string, any>>, refund: Record<string, any> | null }>} entries
 * @param {{ productIds: Map<string, string>, variantIds: Map<string, string>, batchSize: number }} context
 */
async function loadOrders(prisma, shop, entries, { productIds, variantIds, batchSize }) {
  let loaded = 0;
  for (const batch of chunk(entries, batchSize)) {
    for (const entry of batch) {
      const { order, lineItems, refund } = entry;
      const row = await prisma.order.upsert({
        where: { shopId_externalId: { shopId: shop.id, externalId: order.externalId } },
        create: order,
        update: {
          subtotalPrice: order.subtotalPrice,
          totalPrice: order.totalPrice,
          totalDiscount: order.totalDiscount,
          totalShipping: order.totalShipping,
          currency: order.currency,
          rawPayload: order.rawPayload,
        },
      });

      for (const line of lineItems) {
        const { productExternalId, variantExternalId, ...data } = line;
        await prisma.orderLineItem.upsert({
          where: { orderId_externalId: { orderId: row.id, externalId: line.externalId } },
          create: {
            ...data,
            orderId: row.id,
            productId: productIds.get(productExternalId) ?? null,
            variantId: variantIds.get(variantExternalId) ?? null,
          },
          update: { quantity: line.quantity, rawPayload: line.rawPayload },
        });
      }

      if (refund) {
        await prisma.refund.upsert({
          where: { shopId_externalId: { shopId: shop.id, externalId: refund.externalId } },
          create: { ...refund, orderId: row.id },
          update: { amount: refund.amount, currency: refund.currency },
        });
      }
      loaded += 1;
    }
    log("orders.batch", { shopDomain: shop.shopDomain, loaded });
  }
  return loaded;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
