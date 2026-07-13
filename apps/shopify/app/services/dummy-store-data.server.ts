import fixture from "../fixtures/dummy-store-data.json";

const MARKER_NAMESPACE = "jefe_dummy_data";
const MARKER_KEY = "seeded";
const DUMMY_TAG = "jefe-dummy";
const REFUND_RETRY_DELAYS_MS = [1500, 3000, 6000, 10000, 15000];
const REQUIRED_DUMMY_DATA_SCOPES = [
  "read_locations",
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_orders",
  "write_orders",
] as const;

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type UserError = {
  field?: string[] | string | null;
  message: string;
  code?: string | null;
};

type DummyVariant = {
  sku: string;
  option: string;
  price: string;
  inventory: number;
};

type DummyProduct = {
  title: string;
  handle: string;
  status: "ACTIVE" | "DRAFT";
  vendor: string;
  productType: string;
  scenario: string;
  cogsHint: string | null;
  variants: DummyVariant[];
};

type DummyOrderLineItem = {
  sku: string;
  quantity: number;
};

type DummyOrder = {
  name: string;
  daysAgo: number;
  scenario: string;
  discountPercentage: number | null;
  refundSku: string | null;
  lineItems: DummyOrderLineItem[];
};

type DummyFixture = {
  version: string;
  currency: "GBP";
  tags: string[];
  products: DummyProduct[];
  orders: DummyOrder[];
};

type SeededMarker = {
  seededAt: string;
  fixtureVersion: string;
  shop: string;
  productCount: number;
  orderCount: number;
  refundCount: number;
};

type DummyDataStatus =
  | {
      seeded: false;
      seededAt: null;
      marker: null;
    }
  | {
      seeded: true;
      seededAt: string;
      marker: SeededMarker;
    };

type CreatedVariant = {
  id: string;
  sku: string;
  price: string;
};

type CreatedOrder = {
  id: string;
  name: string;
  lineItems: Array<{
    id: string;
    sku: string | null;
    quantity: number;
  }>;
};

type ShopifyCreatedOrder = Omit<CreatedOrder, "lineItems"> & {
  lineItems: {
    nodes: CreatedOrder["lineItems"];
  };
};

type SeedDummyStoreDataResult = {
  marker: SeededMarker;
  productsCreated: number;
  variantsCreated: number;
  ordersCreated: number;
  refundsCreated: number;
};

const dummyFixture = fixture as DummyFixture;

const STATUS_QUERY = `#graphql
  query JefeDummyDataStatus {
    currentAppInstallation {
      id
      metafield(namespace: "${MARKER_NAMESPACE}", key: "${MARKER_KEY}") {
        value
        updatedAt
      }
    }
  }
`;

const EXISTING_DUMMY_PRODUCTS_QUERY = `#graphql
  query JefeExistingDummyProducts($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        createdAt
      }
    }
  }
`;

const LOCATIONS_QUERY = `#graphql
  query JefeDummyDataLocations {
    locations(first: 1) {
      nodes {
        id
        name
      }
    }
  }
`;

const ORDER_ACCESS_QUERY = `#graphql
  query JefeDummyDataOrderAccess {
    orders(first: 1) {
      nodes {
        id
      }
    }
  }
`;

const PRODUCT_SET_MUTATION = `#graphql
  mutation JefeDummyProductSet(
    $identifier: ProductSetIdentifiers!
    $productSet: ProductSetInput!
    $synchronous: Boolean!
  ) {
    productSet(
      identifier: $identifier
      synchronous: $synchronous
      input: $productSet
    ) {
      product {
        id
        title
        variants(first: 20) {
          nodes {
            id
            sku
            price
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const ORDER_CREATE_MUTATION = `#graphql
  mutation JefeDummyOrderCreate($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order {
        id
        name
        lineItems(first: 20) {
          nodes {
            id
            sku
            quantity
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_BY_NAME_QUERY = `#graphql
  query JefeDummyOrderByName($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        lineItems(first: 20) {
          nodes {
            id
            sku
            quantity
          }
        }
      }
    }
  }
`;

const REFUND_CREATE_MUTATION = `#graphql
  mutation JefeDummyRefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SET_MARKER_MUTATION = `#graphql
  mutation JefeDummyDataMarker($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        namespace
        value
        updatedAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export function getDummyFixtureSummary() {
  return {
    version: dummyFixture.version,
    productCount: dummyFixture.products.length,
    variantCount: dummyFixture.products.reduce(
      (count, product) => count + product.variants.length,
      0,
    ),
    orderCount: dummyFixture.orders.length,
    refundCount: dummyFixture.orders.filter((order) => order.refundSku).length,
    scenarios: dummyFixture.products.map((product) => product.scenario),
  };
}

export function getMissingDummyDataScopes(grantedScopes?: string | null) {
  const grantedScopeSet = new Set(
    grantedScopes
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) ?? [],
  );

  return REQUIRED_DUMMY_DATA_SCOPES.filter(
    (scope) => !grantedScopeSet.has(scope),
  );
}

export async function getDummyDataStatus(
  admin: AdminGraphqlClient,
  options: { skipExistingProductCheck?: boolean } = {},
): Promise<DummyDataStatus> {
  const data = await graphqlRequest<{
    currentAppInstallation: {
      id: string;
      metafield: { value: string; updatedAt: string } | null;
    };
  }>(admin, STATUS_QUERY);

  const markerValue = data.currentAppInstallation.metafield?.value;

  if (!markerValue && !options.skipExistingProductCheck) {
    const existingDummyProduct = await findExistingDummyProduct(admin);

    if (existingDummyProduct) {
      return {
        seeded: true,
        seededAt: existingDummyProduct.createdAt,
        marker: {
          seededAt: existingDummyProduct.createdAt,
          fixtureVersion: dummyFixture.version,
          shop: "unknown",
          productCount: dummyFixture.products.length,
          orderCount: 0,
          refundCount: 0,
        },
      };
    }
  }

  if (!markerValue) {
    return { seeded: false, seededAt: null, marker: null };
  }

  const marker = JSON.parse(markerValue) as SeededMarker;
  return {
    seeded: true,
    seededAt: marker.seededAt,
    marker,
  };
}

async function findExistingDummyProduct(admin: AdminGraphqlClient) {
  const data = await graphqlRequest<{
    products: {
      nodes: Array<{
        id: string;
        title: string;
        createdAt: string;
      }>;
    };
  }>(admin, EXISTING_DUMMY_PRODUCTS_QUERY, {
    query: `tag:${DUMMY_TAG}`,
  });

  return data.products.nodes[0] ?? null;
}

export async function seedDummyStoreData(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<SeedDummyStoreDataResult> {
  const existingStatus = await getDummyDataStatus(admin);

  if (existingStatus.seeded) {
    throw new Error("Dummy data has already been loaded for this store.");
  }

  await assertOrderObjectAccess(admin);

  const locationId = await getPrimaryLocationId(admin);
  const variantsBySku = new Map<string, CreatedVariant>();

  for (const product of dummyFixture.products) {
    const createdVariants = await upsertProduct(admin, product, locationId);

    for (const variant of createdVariants) {
      variantsBySku.set(variant.sku, variant);
    }
  }

  const createdOrders: CreatedOrder[] = [];

  for (const order of dummyFixture.orders) {
    createdOrders.push(await createOrder(admin, order, variantsBySku));
  }

  let refundCount = 0;

  for (const order of dummyFixture.orders) {
    if (!order.refundSku) {
      continue;
    }

    const createdOrder = createdOrders.find(
      (candidate) => candidate.name === order.name,
    );

    if (!createdOrder) {
      continue;
    }

    const lineItem = createdOrder.lineItems.find(
      (candidate) => candidate.sku === order.refundSku,
    );

    if (!lineItem) {
      throw new Error(`Refund SKU ${order.refundSku} was not found on order.`);
    }

    await createRefund(
      admin,
      createdOrder.id,
      lineItem.id,
      buildIdempotencyKey("refund", order.name, order.refundSku),
    );
    refundCount += 1;
  }

  const marker: SeededMarker = {
    seededAt: new Date().toISOString(),
    fixtureVersion: dummyFixture.version,
    shop,
    productCount: dummyFixture.products.length,
    orderCount: createdOrders.length,
    refundCount,
  };

  await setSeededMarker(admin, marker);

  return {
    marker,
    productsCreated: dummyFixture.products.length,
    variantsCreated: variantsBySku.size,
    ordersCreated: createdOrders.length,
    refundsCreated: refundCount,
  };
}

async function getPrimaryLocationId(admin: AdminGraphqlClient) {
  const data = await graphqlRequest<{
    locations: { nodes: Array<{ id: string; name: string }> };
  }>(admin, LOCATIONS_QUERY);

  const locationId = data.locations.nodes[0]?.id;

  if (!locationId) {
    throw new Error("No active Shopify inventory location was found.");
  }

  return locationId;
}

async function assertOrderObjectAccess(admin: AdminGraphqlClient) {
  try {
    await graphqlRequest<{
      orders: { nodes: Array<{ id: string }> };
    }>(admin, ORDER_ACCESS_QUERY);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("not approved to access the Order object")) {
      throw new Error(
        "Order and refund fixtures require Shopify protected customer data access. In the Partner Dashboard, select protected customer data for this app on development stores, then reinstall or update the app scopes before loading dummy data.",
      );
    }

    throw error;
  }
}

async function upsertProduct(
  admin: AdminGraphqlClient,
  product: DummyProduct,
  locationId: string,
): Promise<CreatedVariant[]> {
  const data = await graphqlRequest<{
    productSet: {
      product: {
        id: string;
        title: string;
        variants: {
          nodes: CreatedVariant[];
        };
      } | null;
      userErrors: UserError[];
    };
  }>(admin, PRODUCT_SET_MUTATION, {
    identifier: { handle: product.handle },
    synchronous: true,
    productSet: buildProductSetInput(product, locationId),
  });

  assertNoUserErrors(data.productSet.userErrors, product.title);

  const createdProduct = data.productSet.product;

  if (!createdProduct) {
    throw new Error(`Shopify did not return product ${product.title}.`);
  }

  return createdProduct.variants.nodes;
}

function buildProductSetInput(product: DummyProduct, locationId: string) {
  return {
    title: product.title,
    handle: product.handle,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: [...dummyFixture.tags, product.scenario],
    descriptionHtml: `<p>Jefe dummy data fixture for ${product.scenario}.</p>`,
    metafields: [
      {
        namespace: "jefe_dummy",
        key: "fixture_version",
        type: "single_line_text_field",
        value: dummyFixture.version,
      },
      {
        namespace: "jefe_dummy",
        key: "scenario",
        type: "single_line_text_field",
        value: product.scenario,
      },
      ...(product.cogsHint
        ? [
            {
              namespace: "jefe_dummy",
              key: "cogs_hint_gbp",
              type: "number_decimal",
              value: product.cogsHint,
            },
          ]
        : []),
    ],
    productOptions: [
      {
        name: "Variant",
        position: 1,
        values: product.variants.map((variant) => ({ name: variant.option })),
      },
    ],
    variants: product.variants.map((variant, index) => ({
      sku: variant.sku,
      price: variant.price,
      taxable: true,
      inventoryPolicy: "DENY",
      optionValues: [
        {
          optionName: "Variant",
          name: variant.option,
        },
      ],
      position: index + 1,
      inventoryItem: {
        tracked: true,
      },
      inventoryQuantities: [
        {
          locationId,
          name: "available",
          quantity: variant.inventory,
        },
      ],
      metafields: [
        {
          namespace: "jefe_dummy",
          key: "scenario",
          type: "single_line_text_field",
          value: product.scenario,
        },
      ],
    })),
  };
}

async function createOrder(
  admin: AdminGraphqlClient,
  order: DummyOrder,
  variantsBySku: Map<string, CreatedVariant>,
): Promise<CreatedOrder> {
  const existingOrder = await findExistingOrder(admin, order.name);

  if (existingOrder) {
    return existingOrder;
  }

  const processedAt = new Date();
  processedAt.setDate(processedAt.getDate() - order.daysAgo);

  const lineItems = order.lineItems.map((lineItem) => {
    const variant = variantsBySku.get(lineItem.sku);

    if (!variant) {
      throw new Error(`Order references unknown SKU ${lineItem.sku}.`);
    }

    return {
      variantId: variant.id,
      quantity: lineItem.quantity,
      priceSet: {
        shopMoney: {
          amount: variant.price,
          currencyCode: dummyFixture.currency,
        },
      },
    };
  });

  const data = await graphqlRequest<{
    orderCreate: {
      order: ShopifyCreatedOrder | null;
      userErrors: UserError[];
    };
  }>(admin, ORDER_CREATE_MUTATION, {
    order: {
      name: order.name,
      currency: dummyFixture.currency,
      financialStatus: "PAID",
      processedAt: processedAt.toISOString(),
      sourceIdentifier: `jefe-dummy-${dummyFixture.version}-${order.name}`,
      sourceName: "jefe_dummy_data_loader",
      tags: [DUMMY_TAG, "ticket-003", order.scenario],
      test: true,
      note: `Jefe dummy order for ${order.scenario}.`,
      customAttributes: [
        { key: "jefe_fixture_version", value: dummyFixture.version },
        { key: "jefe_scenario", value: order.scenario },
      ],
      lineItems,
      ...(order.discountPercentage
        ? {
            discountCode: {
              itemPercentageDiscountCode: {
                code: `JEFE${order.discountPercentage}`,
                percentage: order.discountPercentage,
              },
            },
          }
        : {}),
    },
  });

  assertNoUserErrors(data.orderCreate.userErrors, order.name);

  if (!data.orderCreate.order) {
    throw new Error(`Shopify did not return order ${order.name}.`);
  }

  return {
    id: data.orderCreate.order.id,
    name: data.orderCreate.order.name,
    lineItems: data.orderCreate.order.lineItems.nodes,
  };
}

async function findExistingOrder(
  admin: AdminGraphqlClient,
  orderName: string,
): Promise<CreatedOrder | null> {
  const data = await graphqlRequest<{
    orders: {
      nodes: ShopifyCreatedOrder[];
    };
  }>(admin, ORDER_BY_NAME_QUERY, {
    query: `name:${orderName}`,
  });

  const order = data.orders.nodes.find((candidate) => candidate.name === orderName);

  if (!order) {
    return null;
  }

  return {
    id: order.id,
    name: order.name,
    lineItems: order.lineItems.nodes,
  };
}

async function createRefund(
  admin: AdminGraphqlClient,
  orderId: string,
  lineItemId: string,
  idempotencyKey: string,
) {
  for (const [attemptIndex, delayMs] of [
    0,
    ...REFUND_RETRY_DELAYS_MS,
  ].entries()) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const data = await graphqlRequest<{
        refundCreate: {
          refund: { id: string } | null;
          userErrors: UserError[];
        };
      }>(admin, REFUND_CREATE_MUTATION, {
        input: {
          orderId,
          refundLineItems: [
            {
              lineItemId,
              quantity: 1,
            },
          ],
          note: `Jefe dummy refund for fixture ${dummyFixture.version}.`,
          transactions: [],
        },
        idempotencyKey,
      });

      assertNoUserErrors(data.refundCreate.userErrors, orderId);

      if (!data.refundCreate.refund) {
        throw new Error(`Shopify did not return refund for order ${orderId}.`);
      }

      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hasRetryRemaining = attemptIndex < REFUND_RETRY_DELAYS_MS.length;

      if (isTemporarilyUnavailableOrderError(message) && hasRetryRemaining) {
        continue;
      }

      throw error;
    }
  }
}

function buildIdempotencyKey(...parts: string[]) {
  return ["jefe-dummy", dummyFixture.version, ...parts]
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 255);
}

function isTemporarilyUnavailableOrderError(message: string) {
  return message.includes("Order is temporarily unavailable to be modified");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setSeededMarker(
  admin: AdminGraphqlClient,
  marker: SeededMarker,
) {
  const statusData = await graphqlRequest<{
    currentAppInstallation: { id: string };
  }>(admin, STATUS_QUERY);

  const appInstallationId = statusData.currentAppInstallation.id;

  const data = await graphqlRequest<{
    metafieldsSet: {
      userErrors: UserError[];
    };
  }>(admin, SET_MARKER_MUTATION, {
    metafields: [
      {
        ownerId: appInstallationId,
        namespace: MARKER_NAMESPACE,
        key: MARKER_KEY,
        type: "json",
        value: JSON.stringify(marker),
      },
    ],
  });

  assertNoUserErrors(data.metafieldsSet.userErrors, "seeded marker");
}

async function graphqlRequest<TData>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const response = await admin.graphql(query, variables ? { variables } : {});
  const payload = (await response.json()) as {
    data?: TData;
    errors?: Array<{ message: string }>;
  };

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Shopify returned an empty GraphQL response.");
  }

  return payload.data;
}

function assertNoUserErrors(userErrors: UserError[], label: string) {
  if (userErrors.length === 0) {
    return;
  }

  const messages = userErrors
    .map((error) => {
      const field = Array.isArray(error.field)
        ? error.field.join(".")
        : error.field;

      return field ? `${field}: ${error.message}` : error.message;
    })
    .join("; ");

  throw new Error(`${label}: ${messages}`);
}
