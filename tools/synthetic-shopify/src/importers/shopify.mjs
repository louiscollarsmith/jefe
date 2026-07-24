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
        customerInspectionUnavailable:
          "Missing read_customers scope; customersCount inspection skipped.",
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
  if (
    !allowNonemptyStore &&
    (meaningfulProducts > 0 || meaningfulOrders > 0 || meaningfulCustomers > 0)
  ) {
    throw new Error(
      `Refusing to seed non-empty store: found ${meaningfulProducts} products, ${meaningfulOrders} orders and ${meaningfulCustomers} customers. Pass --allow-nonempty-store only for disposable synthetic stores.`,
    );
  }
  return inspection;
}

export async function importDatasetToShopify({
  dataset,
  manifest,
  dryRun = false,
  allowNonemptyStore = false,
  credentialSource = "db",
  logger = console,
}) {
  const safe = assertWriteSafety({ shopDomain: manifest.shopDomain, allowNonemptyStore });
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
  await importProducts(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importCollections(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importVariants(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importLocations(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importInventory(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importCustomers(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importOrders(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await importRefunds(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  resolveCompletedFailures(manifest);
  await validateShopifyCounts(client, dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await writeCommercialReconciliation(dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  await writeBeliefCoverage(dataset, manifest, () =>
    persistRun({ dataset, manifest }),
  );
  persistRun({ dataset, manifest });
  return { dryRun: false, manifest };
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
        product: {
          title: product.title,
          handle: product.handle,
          descriptionHtml: product.descriptionHtml,
          vendor: product.vendor,
          productType: product.productType,
          status: product.status,
          tags: product.tags,
          productOptions: [
            {
              name: "Format",
              position: 1,
              values: unique(product.variants.map((variant) => variant.optionValue))
                .map((name) => ({ name })),
            },
          ],
        },
      });
      assertUserErrors(
        "productCreate",
        product.sourceId,
        data.productCreate?.userErrors,
      );
      recordMapping(manifest, "products", product.sourceId, data.productCreate.product.id);
      persist();
    } catch (error) {
      recordFailure(manifest, "product", product.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(manifest, "create_products", "completed", Object.keys(manifest.sourceToShopifyIds.products).length);
  persist();
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
      assertUserErrors(
        "collectionCreate",
        collection.sourceId,
        data.collectionCreate?.userErrors,
      );
      recordMapping(
        manifest,
        "collections",
        collection.sourceId,
        data.collectionCreate.collection.id,
      );
      persist();
    } catch (error) {
      recordFailure(manifest, "collection", collection.sourceId, error, true);
      persist();
      throw error;
    }
  }

  for (const collection of dataset.collections) {
    const collectionId = manifest.sourceToShopifyIds.collections[collection.sourceId];
    const productIds = collection.productSourceIds
      .map((sourceId) => manifest.sourceToShopifyIds.products[sourceId])
      .filter(Boolean);
    for (const productId of productIds) {
      const data = await client.request(PRODUCT_UPDATE_COLLECTIONS, {
        product: {
          id: productId,
          collectionsToJoin: [collectionId],
        },
      });
      assertUserErrors(
        "productUpdate.collectionsToJoin",
        `${collection.sourceId}:${productId}`,
        data.productUpdate?.userErrors,
      );
    }
    persist();
  }
  markPhase(
    manifest,
    "create_collections",
    "completed",
    Object.keys(manifest.sourceToShopifyIds.collections).length,
  );
  persist();
}

async function importVariants(client, dataset, manifest, persist) {
  markPhase(manifest, "create_variants", "running", 0);
  for (const product of dataset.products) {
    const productId = manifest.sourceToShopifyIds.products[product.sourceId];
    if (!productId) throw new Error(`Missing Shopify product ID for ${product.sourceId}`);
    const missingVariants = product.variants.filter(
      (variant) => !manifest.sourceToShopifyIds.variants[variant.sourceId],
    );
    if (!missingVariants.length) continue;

    try {
      const data = await client.request(PRODUCT_VARIANTS_BULK_CREATE, {
        productId,
        strategy: "REMOVE_STANDALONE_VARIANT",
        variants: product.variants.map((variant) => ({
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
      assertUserErrors(
        "productVariantsBulkCreate",
        product.sourceId,
        data.productVariantsBulkCreate?.userErrors,
      );
      const returned = data.productVariantsBulkCreate?.productVariants || [];
      for (const variant of product.variants) {
        const match =
          returned.find((item) => item.sku && item.sku === variant.sku) ||
          returned.find((item) =>
            item.selectedOptions?.some(
              (option) => option.value === variant.optionValue,
            ),
          );
        if (!match) {
          throw new Error(`Could not map Shopify variant for ${variant.sourceId}`);
        }
        recordMapping(manifest, "variants", variant.sourceId, match.id);
        if (match.inventoryItem?.id) {
          recordMapping(
            manifest,
            "inventoryItems",
            `ii_${variant.sourceId}`,
            match.inventoryItem.id,
          );
        }
      }
      persist();
    } catch (error) {
      recordFailure(manifest, "variant", product.sourceId, error, true);
      persist();
      throw error;
    }
  }
  markPhase(
    manifest,
    "create_variants",
    "completed",
    Object.keys(manifest.sourceToShopifyIds.variants).length,
  );
  persist();
}

async function importLocations(client, dataset, manifest, persist) {
  markPhase(manifest, "create_locations", "running", 0);
  const existing = await client.request(LOCATIONS_QUERY);
  const existingByName = new Map(
    (existing.locations?.nodes || []).map((location) => [location.name, location.id]),
  );

  for (const location of dataset.inventoryLocations) {
    if (manifest.sourceToShopifyIds.locations[location.sourceId]) continue;
    if (existingByName.has(location.name)) {
      recordMapping(
        manifest,
        "locations",
        location.sourceId,
        existingByName.get(location.name),
      );
      persist();
      continue;
    }
    try {
      const data = await client.request(LOCATION_ADD, {
        input: {
          name: location.name,
          fulfillsOnlineOrders: location.name === "London Warehouse",
          address: location.name === "London Warehouse"
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
  markPhase(
    manifest,
    "create_locations",
    "completed",
    Object.keys(manifest.sourceToShopifyIds.locations).length,
  );
  persist();
}

async function importInventory(client, dataset, manifest, persist) {
  markPhase(manifest, "set_inventory", "running", 0);
  const quantities = [];
  for (const level of dataset.inventoryLevels) {
    const inventoryItemId = manifest.sourceToShopifyIds.inventoryItems[level.inventoryItemSourceId];
    const locationId = manifest.sourceToShopifyIds.locations[level.locationSourceId];
    if (!inventoryItemId || !locationId) {
      throw new Error(`Missing inventory mapping for ${level.sourceId}`);
    }
    const activationKey = `${inventoryItemId}:${locationId}`;
    if (!manifest.sourceToShopifyIds.inventoryActivations) {
      manifest.sourceToShopifyIds.inventoryActivations = {};
    }
    if (!manifest.sourceToShopifyIds.inventoryActivations[activationKey]) {
      const activated = await client.request(INVENTORY_ACTIVATE, {
        inventoryItemId,
        locationId,
        available: level.available,
        idempotencyKey: [
          "synthetic-shopify",
          manifest.runId,
          level.sourceId,
          gidTail(inventoryItemId),
          gidTail(locationId),
        ].join(":"),
      });
      assertUserErrors(
        "inventoryActivate",
        level.sourceId,
        activated.inventoryActivate?.userErrors,
      );
      manifest.sourceToShopifyIds.inventoryActivations[activationKey] = activationKey;
      persist();
    }
    quantities.push({
      inventoryItemId,
      locationId,
      quantity: level.available,
      changeFromQuantity: level.available,
    });
  }

  for (const [batchIndex, batch] of chunk(quantities, 100).entries()) {
    const data = await client.request(INVENTORY_SET_QUANTITIES, {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `jefe://synthetic-shopify/${manifest.runId}`,
        quantities: batch,
      },
      idempotencyKey: [
        "synthetic-shopify",
        manifest.runId,
        "set-quantities",
        batchIndex,
        batch.length,
        gidTail(batch[0]?.inventoryItemId),
        gidTail(batch.at(-1)?.inventoryItemId),
      ].join(":"),
    });
    assertUserErrors(
      "inventorySetQuantities",
      manifest.runId,
      data.inventorySetQuantities?.userErrors,
    );
    persist();
  }

  markPhase(manifest, "set_inventory", "completed", quantities.length);
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
      assertUserErrors(
        "customerCreate",
        customer.sourceId,
        data.customerCreate?.userErrors,
      );
      recordMapping(manifest, "customers", customer.sourceId, data.customerCreate.customer.id);
      persist();
    } catch (error) {
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
  markPhase(
    manifest,
    "create_orders",
    "completed",
    Object.keys(manifest.sourceToShopifyIds.orders).length,
  );
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
        refundLineItems: refund.refundLineItems.map((item) => ({
          lineItemId: manifest.sourceToShopifyIds.lineItems[item.orderLineItemSourceId],
          quantity: item.quantity,
          restockType: item.restockType,
          locationId: item.restockType === "NO_RESTOCK" ? null : mainLocationId,
        })).filter((item) => item.lineItemId),
        shipping: refund.shippingRefund
          ? { amount: String(refund.shippingRefund.amount) }
          : null,
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
        idempotencyKey: [
          "synthetic-shopify",
          manifest.runId,
          refund.sourceId,
          gidTail(orderId),
        ].join(":"),
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
  markPhase(
    manifest,
    "create_refunds",
    "completed",
    Object.keys(manifest.sourceToShopifyIds.refunds).length,
  );
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
        customerInspectionUnavailable:
          "Missing read_customers scope; customersCount inspection skipped.",
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
  const customerId = order.customerSourceId
    ? manifest.sourceToShopifyIds.customers[order.customerSourceId]
    : null;
  const input = {
    name: order.name,
    email: order.email,
    currency: order.currency,
    presentmentCurrency: order.currency,
    processedAt: order.processedAt,
    financialStatus: order.financialStatus,
    lineItems: order.lineItems.map((line) => ({
      productId: line.productSourceId
        ? manifest.sourceToShopifyIds.products[line.productSourceId]
        : null,
      variantId: line.variantSourceId
        ? manifest.sourceToShopifyIds.variants[line.variantSourceId]
        : null,
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

async function requestMutationWithUserErrorRetry({
  client,
  query,
  variables,
  dataPath,
  operationName,
  sourceId,
  maxAttempts,
  initialDelayMs,
}) {
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
  return Array.isArray(errors) && errors.some((error) =>
    String(error?.message || "").toLowerCase().includes("too many attempts"),
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
  return Array.isArray(error?.errors)
    ? error.errors.some(
        (item) =>
          item?.extensions?.code === "ACCESS_DENIED" &&
          item?.path?.includes(fieldName),
      )
    : false;
}

async function withAuthContext(operation, context) {
  try {
    return await operation();
  } catch (error) {
    if (error?.status === 401) {
      throw new Error(
        `Shopify rejected the stored access token for ${context.shopDomain} with HTTP 401. Credential source was ${context.credentialSource}. Reopen/reinstall the local Shopify app for this shop to refresh the offline session, or pass --credential-source env with SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN.`,
      );
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

const COLLECTION_CREATE = `mutation SyntheticCollectionCreate($collection: CollectionCreateInput!) {
  collectionCreate(collection: $collection) {
    collection { id }
    userErrors { field message }
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

const INVENTORY_SET_QUANTITIES = `mutation SyntheticInventorySetQuantities(
  $input: InventorySetQuantitiesInput!
  $idempotencyKey: String!
) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { field message }
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
