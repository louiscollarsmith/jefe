// @ts-check
import { ShopifyAdminGraphqlClient, normalizeShopDomain } from "../../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";
import { persistRun, markPhase, recordFailure, recordMapping } from "./manifest.mjs";
import { resolveShopifyAccessToken } from "./credentials.mjs";
import { assertWriteSafety } from "./safety.mjs";
import { runDirectory, writeJson } from "../output-paths.mjs";
import { validateSyntheticDataset } from "../validators/dataset.mjs";
import { buildBeliefCoverageReport } from "../validators/coverage.mjs";

export class ShopifyMutationUserError extends Error {
  constructor(operationName, sourceId, userErrors) {
    super(`Shopify user errors for ${sourceId}`);
    this.name = "ShopifyMutationUserError";
    this.operationName = operationName;
    this.sourceId = sourceId;
    this.userErrors = userErrors;
  }
}

const SHOP_INSPECTION = `query SyntheticShopInspection($ordersQuery: String!) {
  shop { id name myshopifyDomain }
  productsCount { count }
  ordersCount(query: $ordersQuery, limit: null) { count }
  locations(first: 20) { nodes { id name } }
}`;

const CUSTOMER_COUNT_INSPECTION = `query SyntheticCustomerCountInspection {
  customersCount { count }
}`;

export async function inspectDestination({ shopDomain, accessToken }) {
  const client = createClient({ shopDomain, accessToken });
  const inspection = await client.request(SHOP_INSPECTION, {
    ordersQuery: "test:false",
  });
  try {
    const customers = await client.request(CUSTOMER_COUNT_INSPECTION);
    return { ...inspection, customersCount: customers.customersCount };
  } catch (error) {
    if (hasAccessDenied(error, "customersCount")) {
      return {
        ...inspection,
        customersCount: null,
        customerInspectionUnavailable: "Missing read_customers scope; customersCount inspection skipped.",
      };
    }
    throw error;
  }
}

export async function ensureEmptyOrAllowed({ shopDomain, accessToken, allowNonemptyStore }) {
  const inspection = await inspectDestination({ shopDomain, accessToken });
  const meaningfulProducts = inspection.productsCount?.count || 0;
  const meaningfulOrders = inspection.ordersCount?.count || 0;
  const meaningfulCustomers = inspection.customersCount?.count || 0;
  if (!allowNonemptyStore && (meaningfulProducts > 0 || meaningfulOrders > 0 || meaningfulCustomers > 0)) {
    return {
      ...inspection,
      nonemptyResumeNotice: `Found ${meaningfulProducts} products, ${meaningfulOrders} orders and ${meaningfulCustomers} customers. Seed will try to resume by mapping existing synthetic records before writing missing records.`,
    };
  }
  return inspection;
}

export async function importDatasetToShopify({ dataset, manifest, dryRun = false, allowNonemptyStore = false, credentialSource = "db", logger = console }) {
  const safe = assertWriteSafety({
    shopDomain: manifest.shopDomain,
    allowNonemptyStore,
  });
  const { accessToken, source } = await resolveShopifyAccessToken({
    shopDomain: safe.shopDomain,
    source: credentialSource,
  });
  const inspection = await withAuthContext(
    () =>
      ensureEmptyOrAllowed({
        shopDomain: safe.shopDomain,
        accessToken,
        allowNonemptyStore,
      }),
    { shopDomain: safe.shopDomain, credentialSource: source },
  );
  markPhase(manifest, "create_manifest", "completed", 1);
  markPhase(manifest, "generate_dataset", "completed", 1);
  markPhase(manifest, "validate_destination", "completed", 1);
  persistRun({ dataset, manifest });

  logger.info("Synthetic Shopify write plan", {
    shopDomain: safe.shopDomain,
    dryRun,
    plannedCounts: manifest.plannedCounts,
    existingCounts: {
      products: inspection.productsCount?.count,
      customers: inspection.customersCount?.count,
      orders: inspection.ordersCount?.count,
    },
    customerInspectionUnavailable: inspection.customerInspectionUnavailable,
    credentialSource: source,
  });

  if (dryRun) return { dryRun: true, manifest, inspection };

  const client = createClient({ shopDomain: safe.shopDomain, accessToken });
  await hydrateExistingSyntheticMappings(client, dataset, manifest, inspection, logger, () => persistRun({ dataset, manifest }));
  await importProducts(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importCollections(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importVariants(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importLocations(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importInventory(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importCustomers(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importOrders(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await importRefunds(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  resolveCompletedFailures(manifest);
  await validateShopifyCounts(client, dataset, manifest, () => persistRun({ dataset, manifest }));
  await writeCommercialReconciliation(dataset, manifest, () => persistRun({ dataset, manifest }));
  await writeBeliefCoverage(dataset, manifest, () => persistRun({ dataset, manifest }));
  persistRun({ dataset, manifest });
  return { dryRun: false, manifest };
}

export async function hydrateExistingSyntheticMappings(client, dataset, manifest, inspection, logger, persist) {
  const before = estimateImportProgress(dataset, manifest);
  await removeStaleProductMappings(client, dataset, manifest, logger, persist);
  await hydrateExistingProducts(client, dataset, manifest, persist);
  await hydrateExistingCollections(client, dataset, manifest, persist);
  if ((inspection.customersCount?.count || 0) > 0) {
    await hydrateExistingCustomers(client, dataset, manifest, logger, persist);
  }
  if ((inspection.ordersCount?.count || 0) > 0) {
    await hydrateExistingOrders(client, dataset, manifest, persist);
  }
  const after = estimateImportProgress(dataset, manifest);
  manifest.resumeProgress = {
    estimatedAt: new Date().toISOString(),
    before,
    after,
    existingCounts: {
      products: inspection.productsCount?.count ?? null,
      customers: inspection.customersCount?.count ?? null,
      orders: inspection.ordersCount?.count ?? null,
    },
    notice: inspection.nonemptyResumeNotice || null,
  };
  persist();
  if (inspection.nonemptyResumeNotice || after.percentComplete > before.percentComplete) {
    logger.info("Synthetic Shopify resume progress", manifest.resumeProgress);
  }
}

async function removeStaleProductMappings(client, dataset, manifest, logger, persist) {
  for (const product of dataset.products) {
    const productId = manifest.sourceToShopifyIds.products[product.sourceId];
    if (!productId) continue;
    const data = await client.request(PRODUCT_RESUME_STATE_QUERY, {
      productId,
    });
    if (!data.product?.id) {
      clearProductMappings(manifest, product);
      logger.warn("Synthetic Shopify resume dropped stale product mapping because Shopify no longer returns the product.", {
        productSourceId: product.sourceId,
        productId,
      });
      persist();
      continue;
    }
    mapExistingProductVariants({
      manifest,
      product,
      shopifyVariants: data.product.variants?.nodes || [],
    });
    persist();
  }
}

async function hydrateExistingProducts(client, dataset, manifest, persist) {
  for (const product of dataset.products) {
    if (manifest.sourceToShopifyIds.products[product.sourceId]) continue;
    const shopifyProduct =
      (await findExistingProductByHandle(client, product.handle)) ||
      (await findExistingProductByHandle(client, recoveredProductHandle(manifest, product))) ||
      (manifest.inventoryRecoveryHandles?.[product.sourceId]
        ? await findExistingProductByHandle(client, manifest.inventoryRecoveryHandles[product.sourceId])
        : null);
    if (!shopifyProduct?.id) continue;
    recordMapping(manifest, "products", product.sourceId, shopifyProduct.id);
    mapExistingProductVariants({
      manifest,
      product,
      shopifyVariants: shopifyProduct.variants?.nodes || [],
    });
    persist();
  }
}

async function hydrateExistingCollections(client, dataset, manifest, persist) {
  for (const collection of dataset.collections) {
    if (manifest.sourceToShopifyIds.collections[collection.sourceId]) continue;
    const data = await client.request(COLLECTION_BY_HANDLE_QUERY, {
      handle: collection.handle,
    });
    const shopifyCollection = data.collectionByHandle;
    if (!shopifyCollection?.id || shopifyCollection.handle !== collection.handle) continue;
    recordMapping(manifest, "collections", collection.sourceId, shopifyCollection.id);
    persist();
  }
}

async function hydrateExistingCustomers(client, dataset, manifest, logger, persist) {
  try {
    for (const customer of dataset.customers) {
      if (manifest.sourceToShopifyIds.customers[customer.sourceId]) continue;
      const data = await client.request(CUSTOMER_BY_EMAIL_QUERY, {
        query: `email:${customer.email}`,
      });
      const shopifyCustomer = (data.customers?.nodes || []).find((candidate) => sameEmail(candidate.email, customer.email));
      if (!shopifyCustomer?.id) continue;
      recordMapping(manifest, "customers", customer.sourceId, shopifyCustomer.id);
      persist();
    }
  } catch (error) {
    if (hasAccessDenied(error, "customers")) {
      logger.warn("Synthetic Shopify customer resume mapping skipped because read_customers is unavailable.");
      return;
    }
    throw error;
  }
}

async function hydrateExistingOrders(client, dataset, manifest, persist) {
  for (const order of dataset.orders) {
    if (manifest.sourceToShopifyIds.orders[order.sourceId]) continue;
    const data = await client.request(ORDER_BY_NAME_QUERY, {
      query: `name:${escapeSearchValue(order.name)}`,
    });
    const shopifyOrder = (data.orders?.nodes || []).find((candidate) => candidate.name === order.name);
    if (!shopifyOrder?.id) continue;
    recordExistingOrderMapping(manifest, order, shopifyOrder);
    persist();
  }
}

async function mapExistingProductAfterCreateFailure(client, manifest, product, error) {
  if (!isAlreadyExistsError(error)) return false;
  const shopifyProduct = await findExistingProductByHandle(client, product.handle);
  if (!shopifyProduct?.id) return false;
  recordMapping(manifest, "products", product.sourceId, shopifyProduct.id);
  mapExistingProductVariants({
    manifest,
    product,
    shopifyVariants: shopifyProduct.variants?.nodes || [],
  });
  return true;
}

export async function createProductWithRecoveredHandle(client, manifest, product, error) {
  if (!isProductHandleConflictError(error)) return false;
  const handle = recoveredProductHandle(manifest, product);
  await createOrMapProductWithHandle(client, manifest, product, handle);
  manifest.recoveredProductHandles = {
    ...(manifest.recoveredProductHandles || {}),
    [product.sourceId]: handle,
  };
  return true;
}

async function createOrMapProductWithHandle(client, manifest, product, handle) {
  const existing = await findExistingProductByHandle(client, handle);
  if (existing?.id) {
    recordMapping(manifest, "products", product.sourceId, existing.id);
    mapExistingProductVariants({
      manifest,
      product,
      shopifyVariants: existing.variants?.nodes || [],
    });
    return;
  }
  const data = await client.request(PRODUCT_CREATE, {
    product: productCreateInput(product, handle),
  });
  assertUserErrors("productCreate", product.sourceId, data.productCreate?.userErrors);
  recordMapping(manifest, "products", product.sourceId, data.productCreate.product.id);
}

function recoveredProductHandle(manifest, product) {
  if (manifest.recoveredProductHandles?.[product.sourceId]) {
    return manifest.recoveredProductHandles[product.sourceId];
  }
  return `${product.handle}-${String(manifest.runId || "resume").replace(/^synth_/, "").slice(0, 8)}`;
}

async function findExistingProductByHandle(client, handle) {
  const direct = await client.request(PRODUCT_BY_HANDLE_QUERY, {
    handle,
  });
  if (direct.productByHandle?.id && direct.productByHandle.handle === handle) {
    return direct.productByHandle;
  }
  const search = await client.request(PRODUCT_BY_HANDLE_SEARCH_QUERY, {
    query: `handle:${escapeSearchToken(handle)}`,
  });
  return (search.products?.nodes || []).find((product) => product.handle === handle) || null;
}

async function mapExistingCollectionAfterCreateFailure(client, manifest, collection, error) {
  if (!isAlreadyExistsError(error)) return false;
  const data = await client.request(COLLECTION_BY_HANDLE_QUERY, {
    handle: collection.handle,
  });
  const shopifyCollection = data.collectionByHandle;
  if (!shopifyCollection?.id || shopifyCollection.handle !== collection.handle) return false;
  recordMapping(manifest, "collections", collection.sourceId, shopifyCollection.id);
  return true;
}

async function mapExistingCustomerAfterCreateFailure(client, manifest, customer, error) {
  if (!isAlreadyExistsError(error)) return false;
  const data = await client.request(CUSTOMER_BY_EMAIL_QUERY, {
    query: `email:${customer.email}`,
  });
  const shopifyCustomer = (data.customers?.nodes || []).find((candidate) => sameEmail(candidate.email, customer.email));
  if (!shopifyCustomer?.id) return false;
  recordMapping(manifest, "customers", customer.sourceId, shopifyCustomer.id);
  return true;
}

function recordExistingOrderMapping(manifest, order, shopifyOrder) {
  recordMapping(manifest, "orders", order.sourceId, shopifyOrder.id);
  for (const [index, line] of order.lineItems.entries()) {
    const createdLine = shopifyOrder.lineItems?.nodes?.[index];
    if (createdLine?.id) {
      recordMapping(manifest, "lineItems", line.sourceId, createdLine.id);
    }
  }
  const transaction = shopifyOrder.transactions?.[0];
  if (transaction?.id) {
    recordMapping(manifest, "transactions", order.sourceId, transaction.id);
  }
}

function clearProductMappings(manifest, product) {
  delete manifest.sourceToShopifyIds.products[product.sourceId];
  for (const variant of product.variants) {
    clearVariantMapping(manifest, variant);
  }
}

function clearVariantMapping(manifest, variant) {
  const variantId = manifest.sourceToShopifyIds.variants[variant.sourceId];
  const inventoryItemId = manifest.sourceToShopifyIds.inventoryItems[`ii_${variant.sourceId}`];
  delete manifest.sourceToShopifyIds.variants[variant.sourceId];
  delete manifest.sourceToShopifyIds.inventoryItems[`ii_${variant.sourceId}`];
  clearInventoryActivationsForIds(manifest, [variantId, inventoryItemId].filter(Boolean));
}

function clearInventoryActivationsForIds(manifest, ids) {
  if (!manifest.sourceToShopifyIds.inventoryActivations || !ids.length) return;
  for (const activationKey of Object.keys(manifest.sourceToShopifyIds.inventoryActivations)) {
    if (ids.some((id) => activationKey.includes(id))) {
      delete manifest.sourceToShopifyIds.inventoryActivations[activationKey];
    }
  }
}

async function ensureInventoryActivation(client, dataset, manifest, level, inventoryItemId, locationId, persist, allowRecovery = true) {
  const activationKey = `${inventoryItemId}:${locationId}`;
  if (!manifest.sourceToShopifyIds.inventoryActivations) {
    manifest.sourceToShopifyIds.inventoryActivations = {};
  }
  if (manifest.sourceToShopifyIds.inventoryActivations[activationKey]) {
    return inventoryItemId;
  }
  const activated = await client.request(INVENTORY_ACTIVATE, {
    inventoryItemId,
    locationId,
    available: level.available,
    idempotencyKey: ["synthetic-shopify", manifest.runId, level.sourceId, gidTail(inventoryItemId), gidTail(locationId)].join(":"),
  });
  try {
    assertUserErrors("inventoryActivate", level.sourceId, activated.inventoryActivate?.userErrors);
  } catch (error) {
    if (!allowRecovery || (!isDeletedProductInventoryError(error) && !isMissingInventoryItemError(error))) throw error;
    const recoveredInventoryItemId = await recoverProductWithValidInventory(client, dataset, manifest, level, persist);
    return ensureInventoryActivation(client, dataset, manifest, level, recoveredInventoryItemId, locationId, persist, false);
  }
  manifest.sourceToShopifyIds.inventoryActivations[activationKey] = activationKey;
  persist();
  return inventoryItemId;
}

async function recoverInventoryQuantityBatch(client, dataset, manifest, quantityEntries, batch, staleIndexes, persist) {
  const recoveredProducts = new Map();
  for (const index of staleIndexes) {
    const entry = batch[index];
    if (!entry) continue;
    const product = sourceProductForInventoryLevel(dataset, entry.level);
    if (!product) {
      throw new Error(`Could not find source product for stale inventory mapping ${entry.level.inventoryItemSourceId}`);
    }
    if (!recoveredProducts.has(product.sourceId)) {
      recoveredProducts.set(product.sourceId, product);
      await recoverProductWithValidInventory(client, dataset, manifest, entry.level, persist);
    }
  }

  for (const product of recoveredProducts.values()) {
    await refreshInventoryQuantityEntriesForProduct({
      client,
      dataset,
      manifest,
      quantityEntries,
      product,
      persist,
    });
  }
}

export async function refreshInventoryQuantityEntriesForProduct({ client, dataset, manifest, quantityEntries, product, persist }) {
  for (const entry of quantityEntries) {
    const entryProduct = sourceProductForInventoryLevel(dataset, entry.level);
    if (entryProduct?.sourceId !== product.sourceId) continue;
    const locationId = manifest.sourceToShopifyIds.locations[entry.level.locationSourceId];
    if (!locationId) {
      throw new Error(`Missing location mapping while recovering ${entry.level.sourceId}`);
    }
    const inventoryItemId = manifest.sourceToShopifyIds.inventoryItems[entry.level.inventoryItemSourceId];
    if (!inventoryItemId) {
      throw new Error(`Could not recover Shopify inventory item for ${entry.level.inventoryItemSourceId}`);
    }
    const activatedInventoryItemId = await ensureInventoryActivation(client, dataset, manifest, entry.level, inventoryItemId, locationId, persist);
    entry.quantity.inventoryItemId = activatedInventoryItemId;
    entry.quantity.locationId = locationId;
    persist();
  }
}

export function staleInventoryQuantityIndexes(userErrors) {
  return [
    ...new Set(
      (userErrors || [])
        .filter(
          (error) =>
            error?.code === "INVALID_INVENTORY_ITEM" ||
            /inventory item could not be found/i.test(String(error?.message || "")),
        )
        .map((error) => {
          const quantitiesIndex = error?.field?.findIndex((field) => field === "quantities");
          const index = quantitiesIndex >= 0 ? Number(error.field[quantitiesIndex + 1]) : NaN;
          return Number.isInteger(index) ? index : null;
        })
        .filter((index) => index !== null),
    ),
  ];
}

function inventorySetQuantitiesIdempotencyKey(manifest, batchIndex, batch) {
  return [
    "synthetic-shopify",
    manifest.runId,
    "set-quantities",
    batchIndex,
    batch.length,
    gidTail(batch[0]?.quantity?.inventoryItemId),
    gidTail(batch.at(-1)?.quantity?.inventoryItemId),
  ].join(":");
}

async function recoverProductWithValidInventory(client, dataset, manifest, level, persist) {
  const product = sourceProductForInventoryLevel(dataset, level);
  if (!product) {
    throw new Error(`Could not find source product for stale inventory mapping ${level.inventoryItemSourceId}`);
  }

  const currentRecoveryHandle = manifest.inventoryRecoveryHandles?.[product.sourceId];
  if (currentRecoveryHandle) {
    await rebuildProductAtHandle(client, dataset, manifest, product, currentRecoveryHandle, persist);
    if (!(await missingInventoryItemIds(client, inventoryItemIdsForProduct(dataset, manifest, product))).length) {
      return inventoryItemIdForLevel(manifest, level);
    }
  }

  for (let offset = 1; offset <= 3; offset += 1) {
    const attempt = Number(manifest.inventoryRecoveryAttempts?.[product.sourceId] || 0) + 1;
    const handle = inventoryRecoveryProductHandle(manifest, product, attempt);
    manifest.inventoryRecoveryAttempts = {
      ...(manifest.inventoryRecoveryAttempts || {}),
      [product.sourceId]: attempt,
    };
    manifest.inventoryRecoveryHandles = {
      ...(manifest.inventoryRecoveryHandles || {}),
      [product.sourceId]: handle,
    };
    persist();
    await rebuildProductAtHandle(client, dataset, manifest, product, handle, persist);
    if (!(await missingInventoryItemIds(client, inventoryItemIdsForProduct(dataset, manifest, product))).length) {
      return inventoryItemIdForLevel(manifest, level);
    }
  }

  throw new Error(`Shopify returned missing inventory items for ${product.sourceId} after three deterministic recovery attempts.`);
}

async function rebuildProductAtHandle(client, dataset, manifest, product, handle, persist) {
  clearProductMappings(manifest, product);
  persist();
  await createOrMapProductWithHandle(client, manifest, product, handle);
  persist();
  const productDataset = {
    ...dataset,
    products: [product],
  };
  await importVariants(client, productDataset, manifest, persist);
  await importCollections(
    client,
    {
      ...dataset,
      collections: dataset.collections.filter((collection) => collection.productSourceIds.includes(product.sourceId)),
    },
    manifest,
    persist,
  );
}

function inventoryRecoveryProductHandle(manifest, product, attempt) {
  const runId = String(manifest.runId || "resume")
    .replace(/^synth_/, "")
    .slice(0, 8);
  return `${product.handle}-${runId}-stock-${attempt}`;
}

function inventoryItemIdsForProduct(dataset, manifest, product) {
  const productVariantSourceIds = new Set(product.variants.map((variant) => variant.sourceId));
  return [
    ...new Set(
      dataset.inventoryLevels
        .filter((level) => productVariantSourceIds.has(level.inventoryItemSourceId.replace(/^ii_/, "")))
        .map((level) => manifest.sourceToShopifyIds.inventoryItems[level.inventoryItemSourceId])
        .filter(Boolean),
    ),
  ];
}

function inventoryItemIdForLevel(manifest, level) {
  const inventoryItemId = manifest.sourceToShopifyIds.inventoryItems[level.inventoryItemSourceId];
  if (!inventoryItemId) {
    throw new Error(`Could not recover Shopify inventory item for ${level.inventoryItemSourceId}`);
  }
  return inventoryItemId;
}

export async function missingInventoryItemIds(client, inventoryItemIds) {
  const expectedIds = [...new Set(inventoryItemIds.filter(Boolean))];
  const existingIds = new Set();
  for (const ids of chunk(expectedIds, 100)) {
    const data = await client.request(INVENTORY_ITEMS_BY_IDS_QUERY, { ids });
    for (const node of data.nodes || []) {
      if (node?.id) existingIds.add(node.id);
    }
  }
  return expectedIds.filter((id) => !existingIds.has(id));
}

async function repairMissingInventoryMappings(client, dataset, manifest, persist) {
  const inventoryItemIds = dataset.inventoryLevels
    .map((level) => manifest.sourceToShopifyIds.inventoryItems[level.inventoryItemSourceId])
    .filter(Boolean);
  const missingIds = new Set(await missingInventoryItemIds(client, inventoryItemIds));
  if (!missingIds.size) return;

  const recoveredProducts = new Set();
  for (const level of dataset.inventoryLevels) {
    const inventoryItemId = manifest.sourceToShopifyIds.inventoryItems[level.inventoryItemSourceId];
    if (!missingIds.has(inventoryItemId)) continue;
    const product = sourceProductForInventoryLevel(dataset, level);
    if (!product || recoveredProducts.has(product.sourceId)) continue;
    recoveredProducts.add(product.sourceId);
    await recoverProductWithValidInventory(client, dataset, manifest, level, persist);
  }
}

function sourceProductForInventoryLevel(dataset, level) {
  const variantSourceId = level.inventoryItemSourceId.replace(/^ii_/, "");
  return dataset.products.find((candidate) => candidate.variants.some((variant) => variant.sourceId === variantSourceId));
}

export function estimateImportProgress(dataset, manifest) {
  const planned = {
    products: dataset.products.length,
    variants: dataset.products.flatMap((product) => product.variants).length,
    collections: dataset.collections.length,
    locations: dataset.inventoryLocations.length,
    customers: dataset.customers.length,
    orders: dataset.orders.length,
    refunds: dataset.refunds.length,
  };
  const mapped = {
    products: Object.keys(manifest.sourceToShopifyIds.products).length,
    variants: Object.keys(manifest.sourceToShopifyIds.variants).length,
    collections: Object.keys(manifest.sourceToShopifyIds.collections).length,
    locations: Object.keys(manifest.sourceToShopifyIds.locations).length,
    customers: Object.keys(manifest.sourceToShopifyIds.customers).length,
    orders: Object.keys(manifest.sourceToShopifyIds.orders).length,
    refunds: Object.keys(manifest.sourceToShopifyIds.refunds).length,
  };
  const remaining = Object.fromEntries(Object.entries(planned).map(([key, count]) => [key, Math.max(0, count - (mapped[key] || 0))]));
  const totalPlanned = Object.values(planned).reduce((sum, count) => sum + count, 0);
  const totalMapped = Object.values(mapped).reduce((sum, count) => sum + count, 0);
  return {
    planned,
    mapped,
    remaining,
    percentComplete: totalPlanned > 0 ? Math.round((Math.min(totalMapped, totalPlanned) / totalPlanned) * 1000) / 10 : 100,
  };
}

function createClient({ shopDomain, accessToken }) {
  return new ShopifyAdminGraphqlClient({
    shopDomain: normalizeShopDomain(shopDomain),
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  });
}

async function importProducts(client, dataset, manifest, persist) {
  markPhase(manifest, "create_products", "running", 0);
  for (const product of dataset.products) {
    if (manifest.sourceToShopifyIds.products[product.sourceId]) continue;
    try {
      const data = await client.request(PRODUCT_CREATE, {
        product: productCreateInput(product),
      });
      assertUserErrors("productCreate", product.sourceId, data.productCreate?.userErrors);
      recordMapping(manifest, "products", product.sourceId, data.productCreate.product.id);
      persist();
    } catch (error) {
      const mapped = await mapExistingProductAfterCreateFailure(client, manifest, product, error);
      if (mapped) {
        persist();
        continue;
      }
      const recovered = await createProductWithRecoveredHandle(client, manifest, product, error);
      if (recovered) {
        persist();
        continue;
      }
      recordFailure(manifest, "product", product.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_products", "completed", Object.keys(manifest.sourceToShopifyIds.products).length);
  persist();
}

function productCreateInput(product, handle = product.handle) {
  return {
    title: product.title,
    handle,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    status: product.status,
    tags: product.tags,
    productOptions: [
      {
        name: "Format",
        position: 1,
        values: unique(product.variants.map((variant) => variant.optionValue)).map((name) => ({ name })),
      },
    ],
  };
}

async function importCollections(client, dataset, manifest, persist) {
  markPhase(manifest, "create_collections", "running", 0);
  for (const collection of dataset.collections) {
    if (manifest.sourceToShopifyIds.collections[collection.sourceId]) continue;
    try {
      const data = await client.request(COLLECTION_CREATE, {
        collection: {
          title: collection.title,
          handle: collection.handle,
          descriptionHtml: `<p>Synthetic ${collection.title} collection for Jefe testing.</p>`,
        },
      });
      assertUserErrors("collectionCreate", collection.sourceId, data.collectionCreate?.userErrors);
      recordMapping(manifest, "collections", collection.sourceId, data.collectionCreate.collection.id);
      persist();
    } catch (error) {
      const mapped = await mapExistingCollectionAfterCreateFailure(client, manifest, collection, error);
      if (mapped) {
        persist();
        continue;
      }
      recordFailure(manifest, "collection", collection.sourceId, error, true);
      persist();
      throw error;
    }
  }

  for (const collection of dataset.collections) {
    const collectionId = manifest.sourceToShopifyIds.collections[collection.sourceId];
    const productIds = collection.productSourceIds.map((sourceId) => manifest.sourceToShopifyIds.products[sourceId]).filter(Boolean);
    for (const productId of productIds) {
      const data = await client.request(PRODUCT_UPDATE_COLLECTIONS, {
        product: {
          id: productId,
          collectionsToJoin: [collectionId],
        },
      });
      assertUserErrors("productUpdate.collectionsToJoin", `${collection.sourceId}:${productId}`, data.productUpdate?.userErrors);
    }
    persist();
  }
  markPhase(manifest, "create_collections", "completed", Object.keys(manifest.sourceToShopifyIds.collections).length);
  persist();
}

async function importVariants(client, dataset, manifest, persist) {
  markPhase(manifest, "create_variants", "running", 0);
  for (const product of dataset.products) {
    const productId = manifest.sourceToShopifyIds.products[product.sourceId];
    if (!productId) throw new Error(`Missing Shopify product ID for ${product.sourceId}`);

    try {
      const existing = await client.request(PRODUCT_VARIANTS_QUERY, {
        productId,
      });
      mapExistingProductVariants({
        manifest,
        product,
        shopifyVariants: existing.product?.variants?.nodes || [],
      });
      persist();

      const missingVariants = product.variants.filter((variant) => !manifest.sourceToShopifyIds.variants[variant.sourceId]);
      if (!missingVariants.length) continue;

      const data = await client.request(PRODUCT_VARIANTS_BULK_CREATE, {
        productId,
        strategy: "REMOVE_STANDALONE_VARIANT",
        variants: missingVariants.map((variant) => ({
          barcode: variant.barcode,
          compareAtPrice: variant.compareAtPrice == null ? null : String(variant.compareAtPrice),
          inventoryItem: {
            sku: variant.sku || null,
            tracked: Boolean(variant.inventoryTracked),
            requiresShipping: Boolean(variant.requiresShipping),
          },
          inventoryPolicy: variant.inventoryPolicy,
          optionValues: [
            {
              optionName: variant.optionName || "Format",
              name: variant.optionValue || variant.title || "Default",
            },
          ],
          price: String(variant.price),
          taxable: Boolean(variant.taxable),
        })),
      });
      assertUserErrors("productVariantsBulkCreate", product.sourceId, data.productVariantsBulkCreate?.userErrors);
      const returned = data.productVariantsBulkCreate?.productVariants || [];
      for (const variant of missingVariants) {
        const match = findShopifyVariantMatch(returned, variant);
        if (!match) {
          throw new Error(`Could not map Shopify variant for ${variant.sourceId}`);
        }
        recordVariantMapping(manifest, variant, match);
      }
      persist();
    } catch (error) {
      recordFailure(manifest, "variant", product.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_variants", "completed", Object.keys(manifest.sourceToShopifyIds.variants).length);
  persist();
}

export function mapExistingProductVariants({ manifest, product, shopifyVariants }) {
  for (const variant of product.variants) {
    const match = findShopifyVariantMatch(shopifyVariants, variant);
    if (match) {
      recordVariantMapping(manifest, variant, match);
    } else {
      clearVariantMapping(manifest, variant);
    }
  }
}

function findShopifyVariantMatch(shopifyVariants, variant) {
  return shopifyVariants.find((item) => item.sku && variant.sku && item.sku === variant.sku) || shopifyVariants.find((item) => item.selectedOptions?.some((option) => option.value === variant.optionValue));
}

function recordVariantMapping(manifest, variant, shopifyVariant) {
  const previousVariantId = manifest.sourceToShopifyIds.variants[variant.sourceId];
  const previousInventoryItemId = manifest.sourceToShopifyIds.inventoryItems[`ii_${variant.sourceId}`];
  recordMapping(manifest, "variants", variant.sourceId, shopifyVariant.id);
  if (shopifyVariant.inventoryItem?.id) {
    recordMapping(manifest, "inventoryItems", `ii_${variant.sourceId}`, shopifyVariant.inventoryItem.id);
  }
  clearInventoryActivationsForIds(
    manifest,
    [previousVariantId, previousInventoryItemId].filter((id) => id && id !== shopifyVariant.id && id !== shopifyVariant.inventoryItem?.id),
  );
}

async function importLocations(client, dataset, manifest, persist) {
  markPhase(manifest, "create_locations", "running", 0);
  const existing = await client.request(LOCATIONS_QUERY);
  const existingByName = new Map((existing.locations?.nodes || []).map((location) => [location.name, location.id]));

  for (const location of dataset.inventoryLocations) {
    if (manifest.sourceToShopifyIds.locations[location.sourceId]) continue;
    if (existingByName.has(location.name)) {
      recordMapping(manifest, "locations", location.sourceId, existingByName.get(location.name));
      persist();
      continue;
    }
    try {
      const data = await client.request(LOCATION_ADD, {
        input: {
          name: location.name,
          fulfillsOnlineOrders: location.name === "London Warehouse",
          address:
            location.name === "London Warehouse"
              ? {
                  address1: "1 Synthetic Warehouse Yard",
                  city: "London",
                  zip: "E1 1AA",
                  countryCode: "GB",
                }
              : {
                  address1: "2 Synthetic Sampling Mews",
                  city: "London",
                  zip: "E2 2BB",
                  countryCode: "GB",
                },
        },
      });
      assertUserErrors("locationAdd", location.sourceId, data.locationAdd?.userErrors);
      recordMapping(manifest, "locations", location.sourceId, data.locationAdd.location.id);
      persist();
    } catch (error) {
      recordFailure(manifest, "location", location.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_locations", "completed", Object.keys(manifest.sourceToShopifyIds.locations).length);
  persist();
}

async function importInventory(client, dataset, manifest, persist) {
  markPhase(manifest, "set_inventory", "running", 0);
  await repairMissingInventoryMappings(client, dataset, manifest, persist);
  const quantityEntries = [];
  for (const level of dataset.inventoryLevels) {
    let inventoryItemId = manifest.sourceToShopifyIds.inventoryItems[level.inventoryItemSourceId];
    const locationId = manifest.sourceToShopifyIds.locations[level.locationSourceId];
    if (!inventoryItemId || !locationId) {
      throw new Error(`Missing inventory mapping for ${level.sourceId}`);
    }
    inventoryItemId = await ensureInventoryActivation(client, dataset, manifest, level, inventoryItemId, locationId, persist);
    quantityEntries.push({
      level,
      quantity: {
        inventoryItemId,
        locationId,
        quantity: level.available,
        changeFromQuantity: level.available,
      },
    });
  }

  for (const [batchIndex, batch] of chunk(quantityEntries, 100).entries()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const data = await client.request(INVENTORY_SET_QUANTITIES, {
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `jefe://synthetic-shopify/${manifest.runId}`,
          quantities: batch.map((entry) => entry.quantity),
        },
        idempotencyKey: inventorySetQuantitiesIdempotencyKey(manifest, `${batchIndex}:${attempt}`, batch),
      });
      const userErrors = data.inventorySetQuantities?.userErrors || [];
      if (!userErrors.length) break;
      const staleIndexes = staleInventoryQuantityIndexes(userErrors);
      if (!staleIndexes.length || attempt === 2) {
        assertUserErrors("inventorySetQuantities", manifest.runId, userErrors);
      }
      await recoverInventoryQuantityBatch(client, dataset, manifest, quantityEntries, batch, staleIndexes, persist);
    }
    persist();
  }

  markPhase(manifest, "set_inventory", "completed", quantityEntries.length);
  persist();
}

async function importCustomers(client, dataset, manifest, persist) {
  markPhase(manifest, "create_customers", "running", 0);
  for (const customer of dataset.customers) {
    if (manifest.sourceToShopifyIds.customers[customer.sourceId]) continue;
    try {
      const data = await client.request(CUSTOMER_CREATE, {
        input: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          tags: customer.tags,
          addresses: [customer.defaultAddress],
        },
      });
      assertUserErrors("customerCreate", customer.sourceId, data.customerCreate?.userErrors);
      recordMapping(manifest, "customers", customer.sourceId, data.customerCreate.customer.id);
      persist();
    } catch (error) {
      const mapped = await mapExistingCustomerAfterCreateFailure(client, manifest, customer, error);
      if (mapped) {
        persist();
        continue;
      }
      recordFailure(manifest, "customer", customer.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_customers", "completed", Object.keys(manifest.sourceToShopifyIds.customers).length);
  persist();
}

async function importOrders(client, dataset, manifest, persist) {
  markPhase(manifest, "create_orders", "running", 0);
  const mainLocationId = manifest.sourceToShopifyIds.locations.loc_london_warehouse;
  for (const order of dataset.orders) {
    if (manifest.sourceToShopifyIds.orders[order.sourceId]) continue;
    try {
      const data = await requestMutationWithUserErrorRetry({
        client,
        query: ORDER_CREATE,
        variables: {
          order: buildOrderInput(order, dataset, manifest, mainLocationId),
          options: {
            inventoryBehaviour: "BYPASS",
            sendReceipt: false,
            sendFulfillmentReceipt: false,
          },
        },
        dataPath: "orderCreate",
        operationName: "orderCreate",
        sourceId: order.sourceId,
        maxAttempts: 8,
        initialDelayMs: orderRetryDelayMs(),
      });
      const created = data.orderCreate.order;
      recordMapping(manifest, "orders", order.sourceId, created.id);
      for (const [index, line] of order.lineItems.entries()) {
        const createdLine = created.lineItems?.nodes?.[index];
        if (createdLine?.id) {
          recordMapping(manifest, "lineItems", line.sourceId, createdLine.id);
        }
      }
      const transaction = created.transactions?.[0];
      if (transaction?.id) {
        recordMapping(manifest, "transactions", order.sourceId, transaction.id);
      }
      persist();
      await sleep(orderDelayMs());
    } catch (error) {
      recordFailure(manifest, "order", order.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_orders", "completed", Object.keys(manifest.sourceToShopifyIds.orders).length);
  persist();
}

async function importRefunds(client, dataset, manifest, persist) {
  markPhase(manifest, "create_refunds", "running", 0);
  const mainLocationId = manifest.sourceToShopifyIds.locations.loc_london_warehouse;
  for (const refund of dataset.refunds) {
    if (manifest.sourceToShopifyIds.refunds[refund.sourceId]) continue;
    try {
      const orderId = manifest.sourceToShopifyIds.orders[refund.orderSourceId];
      if (!orderId) throw new Error(`Missing Shopify order for ${refund.sourceId}`);
      const input = {
        orderId,
        currency: refund.currency,
        note: refund.note,
        notify: false,
        processedAt: refund.processedAt,
        refundLineItems: refund.refundLineItems
          .map((item) => ({
            lineItemId: manifest.sourceToShopifyIds.lineItems[item.orderLineItemSourceId],
            quantity: item.quantity,
            restockType: item.restockType,
            locationId: item.restockType === "NO_RESTOCK" ? null : mainLocationId,
          }))
          .filter((item) => item.lineItemId),
        shipping: refund.shippingRefund ? { amount: String(refund.shippingRefund.amount) } : null,
        transactions: refund.transactions.map((transaction) => ({
          orderId,
          parentId: manifest.sourceToShopifyIds.transactions[refund.orderSourceId] || null,
          gateway: transaction.gateway,
          kind: "REFUND",
          amount: String(transaction.amount),
        })),
      };
      const data = await client.request(REFUND_CREATE, {
        input,
        idempotencyKey: ["synthetic-shopify", manifest.runId, refund.sourceId, gidTail(orderId)].join(":"),
      });
      assertUserErrors("refundCreate", refund.sourceId, data.refundCreate?.userErrors);
      recordMapping(manifest, "refunds", refund.sourceId, data.refundCreate.refund.id);
      persist();
    } catch (error) {
      recordFailure(manifest, "refund", refund.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_refunds", "completed", Object.keys(manifest.sourceToShopifyIds.refunds).length);
  persist();
}

async function validateShopifyCounts(client, dataset, manifest, persist) {
  markPhase(manifest, "validate_shopify_counts", "running", 0);
  persist();
  const inspection = await inspectDestinationWithClient(client);
  const report = {
    plannedCounts: manifest.plannedCounts,
    shopifyCounts: {
      products: inspection.productsCount?.count ?? null,
      customers: inspection.customersCount?.count ?? null,
      nonTestOrders: inspection.ordersCount?.count ?? null,
    },
    mappedCounts: {
      products: Object.keys(manifest.sourceToShopifyIds.products).length,
      variants: Object.keys(manifest.sourceToShopifyIds.variants).length,
      collections: Object.keys(manifest.sourceToShopifyIds.collections).length,
      customers: Object.keys(manifest.sourceToShopifyIds.customers).length,
      orders: Object.keys(manifest.sourceToShopifyIds.orders).length,
      refunds: Object.keys(manifest.sourceToShopifyIds.refunds).length,
      lineItems: Object.keys(manifest.sourceToShopifyIds.lineItems).length,
      inventoryLevels: manifest.completedCounts.set_inventory,
    },
    customerInspectionUnavailable: inspection.customerInspectionUnavailable,
    ok: true,
    failures: [],
  };

  expectAtLeast(report, "shopify products", report.shopifyCounts.products, dataset.plannedCounts.products);
  if (report.shopifyCounts.customers != null) {
    expectAtLeast(report, "shopify customers", report.shopifyCounts.customers, dataset.plannedCounts.customers);
  }
  expectEqualReport(report, "shopify non-test orders", report.shopifyCounts.nonTestOrders, dataset.plannedCounts.expectedNonTestOrders);
  expectEqualReport(report, "mapped products", report.mappedCounts.products, dataset.plannedCounts.products);
  expectEqualReport(report, "mapped variants", report.mappedCounts.variants, dataset.plannedCounts.variants);
  expectEqualReport(report, "mapped collections", report.mappedCounts.collections, dataset.plannedCounts.collections);
  expectEqualReport(report, "mapped customers", report.mappedCounts.customers, dataset.plannedCounts.customers);
  expectEqualReport(report, "mapped orders", report.mappedCounts.orders, dataset.plannedCounts.orders);
  expectEqualReport(report, "mapped refunds", report.mappedCounts.refunds, dataset.plannedCounts.refunds);
  report.ok = report.failures.length === 0;
  writeJson(`${runDirectory(manifest.shopDomain, manifest.runId)}/shopify-count-validation.json`, report);
  if (!report.ok) {
    markPhase(manifest, "validate_shopify_counts", "failed", report.failures.length);
    persist();
    throw new Error(`Shopify count validation failed:\n${report.failures.join("\n")}`);
  }
  markPhase(manifest, "validate_shopify_counts", "completed", 1);
  persist();
}

async function inspectDestinationWithClient(client) {
  const inspection = await client.request(SHOP_INSPECTION, {
    ordersQuery: "test:false",
  });
  try {
    const customers = await client.request(CUSTOMER_COUNT_INSPECTION);
    return { ...inspection, customersCount: customers.customersCount };
  } catch (error) {
    if (hasAccessDenied(error, "customersCount")) {
      return {
        ...inspection,
        customersCount: null,
        customerInspectionUnavailable: "Missing read_customers scope; customersCount inspection skipped.",
      };
    }
    throw error;
  }
}

async function writeCommercialReconciliation(dataset, manifest, persist) {
  markPhase(manifest, "commercial_reconciliation", "running", 0);
  persist();
  const report = validateSyntheticDataset(dataset);
  writeJson(`${runDirectory(manifest.shopDomain, manifest.runId)}/commercial-reconciliation.json`, report);
  if (!report.ok) {
    markPhase(manifest, "commercial_reconciliation", "failed", report.failures.length);
    persist();
    throw new Error(`Commercial reconciliation failed:\n${report.failures.join("\n")}`);
  }
  markPhase(manifest, "commercial_reconciliation", "completed", 1);
  persist();
}

async function writeBeliefCoverage(dataset, manifest, persist) {
  markPhase(manifest, "belief_coverage", "running", 0);
  persist();
  const report = buildBeliefCoverageReport(dataset);
  writeJson(`${runDirectory(manifest.shopDomain, manifest.runId)}/belief-coverage.json`, report);
  markPhase(manifest, "belief_coverage", "completed", report.length);
  persist();
}

function buildOrderInput(order, dataset, manifest, mainLocationId) {
  const products = new Map(dataset.products.map((product) => [product.sourceId, product]));
  const customerId = order.customerSourceId ? manifest.sourceToShopifyIds.customers[order.customerSourceId] : null;
  const input = {
    name: order.name,
    email: order.email,
    currency: order.currency,
    presentmentCurrency: order.currency,
    processedAt: order.processedAt,
    financialStatus: order.financialStatus,
    lineItems: order.lineItems.map((line) => ({
      productId: line.productSourceId ? manifest.sourceToShopifyIds.products[line.productSourceId] : null,
      variantId: line.variantSourceId ? manifest.sourceToShopifyIds.variants[line.variantSourceId] : null,
      quantity: line.quantity,
      sku: line.sku || null,
      title: line.title,
      variantTitle: line.variantTitle,
      vendor: line.productSourceId ? products.get(line.productSourceId)?.vendor : null,
      requiresShipping: true,
      taxable: true,
      priceSet: moneyBag(line.unitPrice, order.currency),
    })),
    shippingLines: [
      {
        title: order.shippingLine.title,
        code: order.shippingLine.code,
        source: "synthetic-shopify",
        priceSet: moneyBag(order.totalShipping, order.currency),
      },
    ],
    tags: order.tags,
    test: Boolean(order.isTest),
    note: `Synthetic seed ${order.sourceId}. Notifications disabled.`,
    sourceIdentifier: order.sourceId,
    sourceName: "synthetic-shopify",
    taxesIncluded: false,
    transactions: order.transactions
      .filter((transaction) => Number(transaction.amount) > 0)
      .map((transaction) => ({
        amountSet: moneyBag(transaction.amount, order.currency),
        gateway: transaction.gateway,
        kind: transaction.kind,
        status: transaction.status,
        test: true,
        processedAt: transaction.processedAt,
      })),
    discountCode: discountCodeInput(order),
  };
  if (customerId) {
    input.customer = { toAssociate: { id: customerId } };
  }
  if (order.shippingAddress) input.shippingAddress = mailingAddress(order.shippingAddress);
  if (order.billingAddress) input.billingAddress = mailingAddress(order.billingAddress);
  if (order.fulfillmentStatus === "FULFILLED" && mainLocationId) {
    input.fulfillmentStatus = "FULFILLED";
  } else if (order.fulfillmentStatus === "PARTIALLY_FULFILLED") {
    input.fulfillmentStatus = "PARTIAL";
  }
  return removeNulls(input);
}

function discountCodeInput(order) {
  if (!order.discountCode) return null;
  if (order.discountCode === "SHIPFREE") {
    return { freeShippingDiscountCode: { code: order.discountCode } };
  }
  if (order.totalDiscount <= 0) return null;
  return {
    itemFixedDiscountCode: {
      code: order.discountCode,
      amountSet: moneyBag(order.totalDiscount, order.currency),
    },
  };
}

function mailingAddress(address) {
  return removeNulls({
    firstName: address.firstName,
    lastName: address.lastName,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    country: address.country,
    zip: address.zip,
  });
}

function moneyBag(amount, currencyCode) {
  return {
    shopMoney: { amount: String(amount), currencyCode },
    presentmentMoney: { amount: String(amount), currencyCode },
  };
}

function removeNulls(value) {
  if (Array.isArray(value)) return value.map(removeNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, removeNulls(entry)]),
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function gidTail(id) {
  return String(id).split("/").pop();
}

function sameEmail(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function escapeSearchValue(value) {
  return `"${String(value).replace(/["\\]/g, "\\$&")}"`;
}

function escapeSearchToken(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

export function isAlreadyExistsError(error) {
  if (!(error instanceof ShopifyMutationUserError)) return false;
  return error.userErrors.some((entry) =>
    /(already exists|already been taken|has already been taken|already in use|in use|taken)/i.test(String(entry?.message || "")),
  );
}

function isDeletedProductInventoryError(error) {
  if (!(error instanceof ShopifyMutationUserError)) return false;
  return error.operationName === "inventoryActivate" && error.userErrors.some((entry) => /product was deleted/i.test(String(entry?.message || "")));
}

function isMissingInventoryItemError(error) {
  if (!(error instanceof ShopifyMutationUserError)) return false;
  return error.userErrors.some((entry) => /inventory item could not be found/i.test(String(entry?.message || "")));
}

function isProductHandleConflictError(error) {
  if (!(error instanceof ShopifyMutationUserError)) return false;
  return error.operationName === "productCreate" && error.userErrors.some((entry) => entry?.field?.includes("handle") && /in use|taken|exists/i.test(String(entry?.message || "")));
}

function assertUserErrors(operationName, sourceId, errors) {
  if (Array.isArray(errors) && errors.length) {
    throw new ShopifyMutationUserError(operationName, sourceId, errors);
  }
}

function expectEqualReport(report, label, actual, expected) {
  if (actual !== expected) {
    report.failures.push(`${label}: expected ${expected}, found ${actual}`);
  }
}

function expectAtLeast(report, label, actual, expected) {
  if (actual == null || actual < expected) {
    report.failures.push(`${label}: expected at least ${expected}, found ${actual}`);
  }
}

function resolveCompletedFailures(manifest) {
  const mappingsByEntity = {
    product: manifest.sourceToShopifyIds.products,
    variant: manifest.sourceToShopifyIds.variants,
    customer: manifest.sourceToShopifyIds.customers,
    order: manifest.sourceToShopifyIds.orders,
    refund: manifest.sourceToShopifyIds.refunds,
    collection: manifest.sourceToShopifyIds.collections,
    location: manifest.sourceToShopifyIds.locations,
  };
  for (const failure of manifest.failures) {
    if (!failure.resolvedAt && mappingsByEntity[failure.entityType]?.[failure.sourceId]) {
      failure.resolvedAt = new Date().toISOString();
    }
  }
}

async function requestMutationWithUserErrorRetry({ client, query, variables, dataPath, operationName, sourceId, maxAttempts, initialDelayMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const data = await client.request(query, variables);
    const userErrors = data[dataPath]?.userErrors || [];
    if (!isRetriableUserErrors(userErrors) || attempt === maxAttempts) {
      assertUserErrors(operationName, sourceId, userErrors);
      return data;
    }
    await sleep(initialDelayMs * attempt);
  }
  throw new Error(`Failed ${operationName} for ${sourceId}`);
}

function isRetriableUserErrors(errors) {
  return (
    Array.isArray(errors) &&
    errors.some((error) =>
      String(error?.message || "")
        .toLowerCase()
        .includes("too many attempts"),
    )
  );
}

function orderDelayMs() {
  return readPositiveIntegerEnv("SYNTHETIC_SHOPIFY_ORDER_DELAY_MS", 2500);
}

function orderRetryDelayMs() {
  return readPositiveIntegerEnv("SYNTHETIC_SHOPIFY_ORDER_RETRY_DELAY_MS", 10000);
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function hasAccessDenied(error, fieldName) {
  return Array.isArray(error?.errors) ? error.errors.some((item) => item?.extensions?.code === "ACCESS_DENIED" && item?.path?.includes(fieldName)) : false;
}

async function withAuthContext(operation, context) {
  try {
    return await operation();
  } catch (error) {
    if (error?.status === 401) {
      throw new Error(`Shopify rejected the stored access token for ${context.shopDomain} with HTTP 401. Credential source was ${context.credentialSource}. Reopen/reinstall the local Shopify app for this shop to refresh the offline session, or pass --credential-source env with SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN.`);
    }
    throw error;
  }
}

const PRODUCT_CREATE = `mutation SyntheticProductCreate($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product { id }
    userErrors { field message }
  }
}`;

const PRODUCT_BY_HANDLE_QUERY = `query SyntheticProductByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    handle
    variants(first: 100) {
      nodes {
        id
        sku
        selectedOptions { name value }
        inventoryItem { id tracked }
      }
    }
  }
}`;

const PRODUCT_BY_HANDLE_SEARCH_QUERY = `query SyntheticProductByHandleSearch($query: String!) {
  products(first: 5, query: $query) {
    nodes {
      id
      handle
      variants(first: 100) {
        nodes {
          id
          sku
          selectedOptions { name value }
          inventoryItem { id tracked }
        }
      }
    }
  }
}`;

const PRODUCT_RESUME_STATE_QUERY = `query SyntheticProductResumeState($productId: ID!) {
  product(id: $productId) {
    id
    variants(first: 100) {
      nodes {
        id
        sku
        selectedOptions { name value }
        inventoryItem { id tracked }
      }
    }
  }
}`;

const PRODUCT_VARIANTS_BULK_CREATE = `mutation SyntheticProductVariantsBulkCreate(
  $productId: ID!
  $variants: [ProductVariantsBulkInput!]!
  $strategy: ProductVariantsBulkCreateStrategy
) {
  productVariantsBulkCreate(
    productId: $productId
    variants: $variants
    strategy: $strategy
  ) {
    productVariants {
      id
      sku
      title
      selectedOptions { name value }
      inventoryItem { id tracked }
    }
    userErrors { field message }
  }
}`;

const PRODUCT_VARIANTS_QUERY = `query SyntheticProductVariants($productId: ID!) {
  product(id: $productId) {
    variants(first: 100) {
      nodes {
        id
        sku
        selectedOptions { name value }
        inventoryItem { id tracked }
      }
    }
  }
}`;

const COLLECTION_CREATE = `mutation SyntheticCollectionCreate($collection: CollectionCreateInput!) {
  collectionCreate(collection: $collection) {
    collection { id }
    userErrors { field message }
  }
}`;

const COLLECTION_BY_HANDLE_QUERY = `query SyntheticCollectionByHandle($handle: String!) {
  collectionByHandle(handle: $handle) {
    id
    handle
  }
}`;

const PRODUCT_UPDATE_COLLECTIONS = `mutation SyntheticProductUpdateCollections($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }
  }
}`;

const LOCATIONS_QUERY = `query SyntheticLocations {
  locations(first: 100) {
    nodes { id name }
  }
}`;

const LOCATION_ADD = `mutation SyntheticLocationAdd($input: LocationAddInput!) {
  locationAdd(input: $input) {
    location { id name }
    userErrors { field message }
  }
}`;

const INVENTORY_ACTIVATE = `mutation SyntheticInventoryActivate(
  $inventoryItemId: ID!
  $locationId: ID!
  $available: Int
  $idempotencyKey: String!
) {
  inventoryActivate(
    inventoryItemId: $inventoryItemId
    locationId: $locationId
    available: $available
  ) @idempotent(key: $idempotencyKey) {
    inventoryLevel { id }
    userErrors { field message }
  }
}`;

const INVENTORY_ITEMS_BY_IDS_QUERY = `query SyntheticInventoryItemsByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on InventoryItem {
      id
    }
  }
}`;

const INVENTORY_SET_QUANTITIES = `mutation SyntheticInventorySetQuantities(
  $input: InventorySetQuantitiesInput!
  $idempotencyKey: String!
) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { code field message }
  }
}`;

const ORDER_CREATE = `mutation SyntheticOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order {
      id
      name
      lineItems(first: 100) {
        nodes { id sku quantity title variant { id } }
      }
      transactions(first: 20) {
        id
        kind
        status
      }
    }
    userErrors { field message }
  }
}`;

const REFUND_CREATE = `mutation SyntheticRefundCreate($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund { id }
    userErrors { field message }
  }
}`;

const CUSTOMER_CREATE = `mutation SyntheticCustomerCreate($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { id }
    userErrors { field message }
  }
}`;

const CUSTOMER_BY_EMAIL_QUERY = `query SyntheticCustomerByEmail($query: String!) {
  customers(first: 1, query: $query) {
    nodes {
      id
      email
    }
  }
}`;

const ORDER_BY_NAME_QUERY = `query SyntheticOrderByName($query: String!) {
  orders(first: 1, query: $query) {
    nodes {
      id
      name
      lineItems(first: 100) {
        nodes { id sku quantity title variant { id } }
      }
      transactions(first: 20) {
        id
        kind
        status
      }
    }
  }
}`;
