// @ts-check
import { ShopifyAdminGraphqlClient, normalizeShopDomain } from "../../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";
import { resolveShopifyAccessToken } from "./credentials.mjs";
import { assertWriteSafety } from "./safety.mjs";

const PAGE_SIZE = 50;

const WIPE_SCAN = `query SyntheticWipeScan($productsAfter: String, $collectionsAfter: String, $customersAfter: String, $ordersAfter: String, $ordersQuery: String) {
  shop { id name myshopifyDomain }
  products(first: 50, after: $productsAfter, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle createdAt }
  }
  collections(first: 50, after: $collectionsAfter) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle }
  }
  customers(first: 50, after: $customersAfter, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id displayName email createdAt numberOfOrders }
  }
  orders(first: 50, after: $ordersAfter, sortKey: CREATED_AT, query: $ordersQuery) {
    pageInfo { hasNextPage endCursor }
    nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus }
  }
}`;

const PRODUCT_DELETE = `mutation SyntheticWipeProductDelete($input: ProductDeleteInput!) {
  productDelete(input: $input, synchronous: true) {
    deletedProductId
    productDeleteOperation { id status deletedProductId }
    userErrors { field message }
  }
}`;

const CUSTOMER_DELETE = `mutation SyntheticWipeCustomerDelete($id: ID!) {
  customerDelete(input: {id: $id}) {
    deletedCustomerId
    userErrors { field message }
  }
}`;

const COLLECTION_DELETE = `mutation SyntheticWipeCollectionDelete($input: CollectionDeleteInput!) {
  collectionDelete(input: $input) {
    deletedCollectionId
    userErrors { field message }
  }
}`;

const ORDER_DELETE = `mutation SyntheticWipeOrderDelete($orderId: ID!) {
  orderDelete(orderId: $orderId) {
    deletedId
    userErrors { field message }
  }
}`;

const ACCESS_SCOPES = `query SyntheticWipeAccessScopes {
  currentAppInstallation {
    accessScopes { handle }
  }
}`;

/**
 * @param {{
 *   shopDomain: string;
 *   dryRun?: boolean;
 *   allowNonemptyStore?: boolean;
 *   credentialSource?: string;
 *   includeOrders?: boolean;
 *   yes?: boolean;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function wipeStore(input) {
  const dryRun = input.dryRun ?? true;
  const shopDomain = normalizeShopDomain(input.shopDomain);
  assertWriteSafety({
    shopDomain,
    allowNonemptyStore: input.allowNonemptyStore ?? true,
  });
  if (!dryRun && !input.yes) {
    throw new Error("Refusing live wipe without --yes. Run with --dry-run first, then pass --yes for a disposable store.");
  }

  const { accessToken, source } = await resolveShopifyAccessToken({
    shopDomain,
    source: input.credentialSource || "db",
  });
  const client = new ShopifyAdminGraphqlClient({
    shopDomain,
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  });

  const currentScopes = await readCurrentScopes(client);
  const required = requiredScopes(Boolean(input.includeOrders));
  const missingScopes = required.filter((scope) => !currentScopes.includes(scope));
  const targets = await scanWipeTargets(client, { includeOrders: Boolean(input.includeOrders) });
  const summary = {
    shopDomain,
    dryRun,
    credentialSource: source,
    requiredScopes: required,
    currentScopes,
    missingScopes,
    counts: {
      products: targets.products.length,
      collections: targets.collections.length,
      customers: targets.customers.length,
      orders: targets.orders.length,
    },
    skipped: [],
    deleted: {
      products: [],
      collections: [],
      customers: [],
      orders: [],
    },
  };

  if (!input.includeOrders && targets.orders.length > 0) {
    summary.skipped.push(
      `Found ${targets.orders.length} non-test orders. Orders are not deleted unless --include-orders is passed.`,
    );
  }

  if (dryRun) return summary;
  if (missingScopes.length > 0) {
    throw new Error(
      `Refusing live wipe because the Shopify token is missing required scopes: ${missingScopes.join(", ")}.`,
    );
  }

  for (const order of targets.orders) {
    const data = await client.request(ORDER_DELETE, { orderId: order.id });
    const errors = data.orderDelete?.userErrors || [];
    if (errors.length) {
      summary.skipped.push(`Order ${order.name}: ${errors.map((error) => error.message).join("; ")}`);
    } else {
      summary.deleted.orders.push(data.orderDelete.deletedId || order.id);
    }
  }

  for (const customer of targets.customers) {
    const data = await client.request(CUSTOMER_DELETE, { id: customer.id });
    const errors = data.customerDelete?.userErrors || [];
    if (errors.length) {
      summary.skipped.push(`Customer ${customer.displayName || customer.id}: ${errors.map((error) => error.message).join("; ")}`);
    } else {
      summary.deleted.customers.push(data.customerDelete.deletedCustomerId || customer.id);
    }
  }

  for (const collection of targets.collections) {
    const data = await client.request(COLLECTION_DELETE, {
      input: { id: collection.id },
    });
    const errors = data.collectionDelete?.userErrors || [];
    if (errors.length) {
      summary.skipped.push(`Collection ${collection.title}: ${errors.map((error) => error.message).join("; ")}`);
    } else {
      summary.deleted.collections.push(
        data.collectionDelete.deletedCollectionId || collection.id,
      );
    }
  }

  for (const product of targets.products) {
    const data = await client.request(PRODUCT_DELETE, {
      input: { id: product.id },
    });
    const errors = data.productDelete?.userErrors || [];
    if (errors.length) {
      summary.skipped.push(`Product ${product.title}: ${errors.map((error) => error.message).join("; ")}`);
    } else {
      summary.deleted.products.push(
        data.productDelete.deletedProductId ||
          data.productDelete.productDeleteOperation?.deletedProductId ||
          product.id,
      );
    }
  }

  return summary;
}

async function scanWipeTargets(client, { includeOrders }) {
  const products = [];
  const collections = [];
  const customers = [];
  const orders = [];
  let productsAfter = null;
  let collectionsAfter = null;
  let customersAfter = null;
  let ordersAfter = null;

  while (true) {
    const data = await client.request(WIPE_SCAN, {
      productsAfter,
      collectionsAfter,
      customersAfter,
      ordersAfter,
      ordersQuery: includeOrders ? "" : "test:false",
    });

    products.push(...data.products.nodes);
    collections.push(...data.collections.nodes);
    customers.push(...data.customers.nodes);
    if (includeOrders) orders.push(...data.orders.nodes);
    else if (data.orders.nodes.length) orders.push(...data.orders.nodes);

    productsAfter = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
    collectionsAfter = data.collections.pageInfo.hasNextPage
      ? data.collections.pageInfo.endCursor
      : null;
    customersAfter = data.customers.pageInfo.hasNextPage
      ? data.customers.pageInfo.endCursor
      : null;
    ordersAfter = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;

    if (!productsAfter && !collectionsAfter && !customersAfter && (!includeOrders || !ordersAfter)) {
      break;
    }
    if (products.length + collections.length + customers.length + orders.length > 10_000) {
      throw new Error("Refusing wipe scan above 10,000 records. Use a narrower disposable store.");
    }
  }

  return {
    products: dedupe(products),
    collections: dedupe(collections),
    customers: includeOrders
      ? dedupe(customers)
      : dedupe(customers).filter((customer) => Number(customer.numberOfOrders || 0) === 0),
    orders: includeOrders ? dedupe(orders) : dedupe(orders),
  };
}

function dedupe(rows) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function requiredScopes(includeOrders) {
  const scopes = ["write_products", "write_customers", "read_products", "read_customers"];
  if (includeOrders) scopes.push("write_orders", "read_orders");
  return scopes;
}

async function readCurrentScopes(client) {
  const data = await client.request(ACCESS_SCOPES);
  return (data.currentAppInstallation?.accessScopes || [])
    .map((scope) => scope.handle)
    .filter(Boolean);
}
