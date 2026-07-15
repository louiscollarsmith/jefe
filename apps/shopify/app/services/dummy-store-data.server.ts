import fixture from "../fixtures/dummy-store-data.json";
import klaviyoWinbackScenarioFixture from "../fixtures/klaviyo-winback-scenario-data.json";
import watchdogScenarioFixture from "../fixtures/watchdog-scenario-data.json";
import { getMissingShopifyScopes } from "./shopify-scopes.server.js";

const MARKER_NAMESPACE = "jefe_dummy_data";
const MARKER_KEY = "seeded";
const DUMMY_TAG = "jefe-dummy";
const WATCHDOG_MARKER_NAMESPACE = "jefe_watchdog_scenarios";
const WATCHDOG_MARKER_KEY = "seeded";
const WATCHDOG_TAG = "jefe-watchdog-scenario";
const KLAVIYO_WINBACK_MARKER_NAMESPACE = "jefe_klaviyo_winback_scenarios";
const KLAVIYO_WINBACK_MARKER_KEY = "seeded";
const KLAVIYO_WINBACK_TAG = "jefe-klaviyo-winback-scenario";
const REFUND_RETRY_DELAYS_MS = [1500, 3000, 6000, 10000, 15000];
const SHOPIFY_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000, 20000, 30000];
const REQUIRED_DUMMY_DATA_SCOPES = [
  "read_locations",
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_customers",
  "write_customers",
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
  finalStatus?: "ACTIVE" | "DRAFT";
  finalInventory?: number;
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

type DummyCustomer = {
  email: string;
  firstName: string;
  lastName: string;
  acceptsMarketing: boolean;
};

type DummyOrder = {
  name: string;
  daysAgo: number;
  scenario: string;
  discountPercentage: number | null;
  refundSku: string | null;
  lineItems: DummyOrderLineItem[];
  customer: DummyCustomer;
};

type DummyFixture = {
  version: string;
  currency: "GBP";
  tags: string[];
  scenarios?: Array<{
    key: string;
    title: string;
    description: string;
  }>;
  products: DummyProduct[];
  orders: DummyOrder[];
  notes?: string[];
};

type SeededMarker = {
  seededAt: string;
  fixtureVersion: string;
  shop: string;
  productCount: number;
  orderCount: number;
  refundCount: number;
  scenarioCount?: number;
};

type FixtureProgress = {
  complete: boolean;
  productCount: number;
  productsExisting: number;
  orderCount: number;
  ordersExisting: number;
  refundCount: number;
  refundsExisting: number;
};

type DummyDataStatus = {
  seeded: boolean;
  seededAt: string | null;
  marker: SeededMarker | null;
  progress: FixtureProgress;
};

type CreatedVariant = {
  id: string;
  sku: string;
  price: string;
};

type CreatedOrder = {
  id: string;
  name: string;
  refundCount: number;
  lineItems: Array<{
    id: string;
    sku: string | null;
    quantity: number;
  }>;
};

type ShopifyCreatedOrder = Omit<CreatedOrder, "lineItems" | "refundCount"> & {
  lineItems: {
    nodes: CreatedOrder["lineItems"];
  };
  refunds?: Array<{ id: string }>;
};

type SeedDummyStoreDataResult = {
  marker: SeededMarker;
  productsCreated: number;
  variantsCreated: number;
  ordersCreated: number;
  refundsCreated: number;
  progress: FixtureProgress;
  scenariosLoaded?: number;
};

const dummyFixture = fixture as DummyFixture;
const watchdogFixture = watchdogScenarioFixture as DummyFixture;
const klaviyoWinbackFixture = klaviyoWinbackScenarioFixture as DummyFixture;

type FixtureConfig = {
  fixture: DummyFixture;
  markerNamespace: string;
  markerKey: string;
  productTag: string;
  sourceName: string;
  idempotencyPrefix: string;
};

const dummyFixtureConfig: FixtureConfig = {
  fixture: dummyFixture,
  markerNamespace: MARKER_NAMESPACE,
  markerKey: MARKER_KEY,
  productTag: DUMMY_TAG,
  sourceName: "jefe_dummy_data_loader",
  idempotencyPrefix: "jefe-dummy",
};

const watchdogFixtureConfig: FixtureConfig = {
  fixture: watchdogFixture,
  markerNamespace: WATCHDOG_MARKER_NAMESPACE,
  markerKey: WATCHDOG_MARKER_KEY,
  productTag: WATCHDOG_TAG,
  sourceName: "jefe_watchdog_scenario_loader",
  idempotencyPrefix: "jefe-watchdog-scenario",
};

const klaviyoWinbackFixtureConfig: FixtureConfig = {
  fixture: klaviyoWinbackFixture,
  markerNamespace: KLAVIYO_WINBACK_MARKER_NAMESPACE,
  markerKey: KLAVIYO_WINBACK_MARKER_KEY,
  productTag: KLAVIYO_WINBACK_TAG,
  sourceName: "jefe_klaviyo_winback_scenario_loader",
  idempotencyPrefix: "jefe-klaviyo-winback-scenario",
};

const STATUS_QUERY = `#graphql
  query JefeFixtureDataStatus($namespace: String!, $key: String!) {
    currentAppInstallation {
      id
      metafield(namespace: $namespace, key: $key) {
        value
        updatedAt
      }
    }
  }
`;

const EXISTING_FIXTURE_PRODUCTS_QUERY = `#graphql
  query JefeExistingFixtureProducts($query: String!) {
    products(first: 100, query: $query) {
      nodes {
        id
        title
        handle
        createdAt
      }
    }
  }
`;

const EXISTING_FIXTURE_ORDERS_QUERY = `#graphql
  query JefeExistingFixtureOrders($query: String!) {
    orders(first: 100, query: $query) {
      nodes {
        id
        name
        email
        customer {
          id
          email
        }
        refunds(first: 10) {
          id
        }
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
        email
        customer {
          id
          email
          firstName
          lastName
        }
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

const CUSTOMER_SET_MUTATION = `#graphql
  mutation JefeDummyCustomerSet(
    $identifier: CustomerSetIdentifiers!
    $input: CustomerSetInput!
  ) {
    customerSet(identifier: $identifier, input: $input) {
      customer {
        id
        email
        firstName
        lastName
      }
      userErrors {
        field
        message
        code
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
        refunds(first: 10) {
          id
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
  return getFixtureSummary(dummyFixture);
}

export function getWatchdogScenarioFixtureSummary() {
  return getFixtureSummary(watchdogFixture);
}

export function getKlaviyoWinbackScenarioFixtureSummary() {
  return getFixtureSummary(klaviyoWinbackFixture);
}

function getFixtureSummary(sourceFixture: DummyFixture) {
  const customerEmails = new Set(
    sourceFixture.orders.map((order) => order.customer.email),
  );

  return {
    version: sourceFixture.version,
    productCount: sourceFixture.products.length,
    variantCount: sourceFixture.products.reduce(
      (count, product) => count + product.variants.length,
      0,
    ),
    orderCount: sourceFixture.orders.length,
    customerCount: customerEmails.size,
    refundCount: sourceFixture.orders.filter((order) => order.refundSku).length,
    scenarioCount: sourceFixture.scenarios?.length ?? 0,
    scenarios:
      sourceFixture.scenarios?.map((scenario) => scenario.title) ??
      sourceFixture.products.map((product) => product.scenario),
    notes: sourceFixture.notes ?? [],
  };
}

export function getMissingDummyDataScopes(grantedScopes?: string | null) {
  return getMissingShopifyScopes(REQUIRED_DUMMY_DATA_SCOPES, grantedScopes);
}

export function getMissingWatchdogScenarioScopes(grantedScopes?: string | null) {
  return getMissingShopifyScopes(REQUIRED_DUMMY_DATA_SCOPES, grantedScopes);
}

export function getMissingKlaviyoWinbackScenarioScopes(
  grantedScopes?: string | null,
) {
  return getMissingShopifyScopes(REQUIRED_DUMMY_DATA_SCOPES, grantedScopes);
}

export async function getDummyDataStatus(
  admin: AdminGraphqlClient,
  options: { skipProgressCheck?: boolean } = {},
): Promise<DummyDataStatus> {
  return getFixtureDataStatus(admin, dummyFixtureConfig, options);
}

export async function getWatchdogScenarioStatus(
  admin: AdminGraphqlClient,
  options: { skipProgressCheck?: boolean } = {},
): Promise<DummyDataStatus> {
  return getFixtureDataStatus(admin, watchdogFixtureConfig, options);
}

export async function getKlaviyoWinbackScenarioStatus(
  admin: AdminGraphqlClient,
  options: { skipProgressCheck?: boolean } = {},
): Promise<DummyDataStatus> {
  return getFixtureDataStatus(admin, klaviyoWinbackFixtureConfig, options);
}

async function getFixtureDataStatus(
  admin: AdminGraphqlClient,
  config: FixtureConfig,
  options: { skipProgressCheck?: boolean } = {},
): Promise<DummyDataStatus> {
  const [data, progress] = await Promise.all([
    graphqlRequest<{
      currentAppInstallation: {
        id: string;
        metafield: { value: string; updatedAt: string } | null;
      };
    }>(admin, STATUS_QUERY, {
      namespace: config.markerNamespace,
      key: config.markerKey,
    }),
    options.skipProgressCheck
      ? Promise.resolve(emptyFixtureProgress(config.fixture))
      : buildFixtureProgress(admin, config),
  ]);

  const markerValue = data.currentAppInstallation.metafield?.value;

  if (!markerValue) {
    return { seeded: false, seededAt: null, marker: null, progress };
  }

  const marker = JSON.parse(markerValue) as SeededMarker;
  return {
    seeded: true,
    seededAt: marker.seededAt,
    marker,
    progress: progress.complete ? progress : markerProgress(config.fixture, marker),
  };
}

async function buildFixtureProgress(
  admin: AdminGraphqlClient,
  config: FixtureConfig,
): Promise<FixtureProgress> {
  const [productData, orderData] = await Promise.all([
    graphqlRequest<{
      products: {
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          createdAt: string;
        }>;
      };
    }>(admin, EXISTING_FIXTURE_PRODUCTS_QUERY, {
      query: `tag:${config.productTag}`,
    }),
    graphqlRequest<{
      orders: {
        nodes: Array<{
          id: string;
          name: string;
          refunds?: Array<{ id: string }>;
        }>;
      };
    }>(admin, EXISTING_FIXTURE_ORDERS_QUERY, {
      query: `tag:${config.productTag}`,
    }),
  ]);
  const expectedHandles = new Set(
    config.fixture.products.map((product) => product.handle),
  );
  const expectedOrderNames = new Set(
    config.fixture.orders.map((order) => order.name),
  );
  const expectedRefundOrderNames = new Set(
    config.fixture.orders
      .filter((order) => order.refundSku)
      .map((order) => order.name),
  );
  const productsExisting = productData.products.nodes.filter((product) =>
    expectedHandles.has(product.handle),
  ).length;
  const existingOrders = orderData.orders.nodes.filter((order) =>
    expectedOrderNames.has(order.name),
  );
  const refundsExisting = existingOrders.filter(
    (order) =>
      expectedRefundOrderNames.has(order.name) &&
      (order.refunds?.length ?? 0) > 0,
  ).length;

  return {
    productCount: config.fixture.products.length,
    productsExisting,
    orderCount: config.fixture.orders.length,
    ordersExisting: existingOrders.length,
    refundCount: expectedRefundOrderNames.size,
    refundsExisting,
    complete:
      productsExisting >= config.fixture.products.length &&
      existingOrders.length >= config.fixture.orders.length &&
      refundsExisting >= expectedRefundOrderNames.size,
  };
}

function emptyFixtureProgress(sourceFixture: DummyFixture): FixtureProgress {
  const refundCount = sourceFixture.orders.filter((order) => order.refundSku).length;

  return {
    complete: false,
    productCount: sourceFixture.products.length,
    productsExisting: 0,
    orderCount: sourceFixture.orders.length,
    ordersExisting: 0,
    refundCount,
    refundsExisting: 0,
  };
}

function markerProgress(
  sourceFixture: DummyFixture,
  marker: SeededMarker,
): FixtureProgress {
  const refundCount = sourceFixture.orders.filter((order) => order.refundSku).length;

  return {
    complete: true,
    productCount: sourceFixture.products.length,
    productsExisting: marker.productCount,
    orderCount: sourceFixture.orders.length,
    ordersExisting: marker.orderCount,
    refundCount,
    refundsExisting: marker.refundCount,
  };
}

export async function seedDummyStoreData(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<SeedDummyStoreDataResult> {
  return seedStoreFixtureData(admin, shop, dummyFixtureConfig);
}

export async function seedWatchdogScenarios(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<SeedDummyStoreDataResult> {
  return seedStoreFixtureData(admin, shop, watchdogFixtureConfig);
}

export async function seedKlaviyoWinbackScenarios(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<SeedDummyStoreDataResult> {
  return seedStoreFixtureData(admin, shop, klaviyoWinbackFixtureConfig);
}

async function seedStoreFixtureData(
  admin: AdminGraphqlClient,
  shop: string,
  config: FixtureConfig,
): Promise<SeedDummyStoreDataResult> {
  const existingStatus = await getFixtureDataStatus(admin, config);

  if (existingStatus.seeded) {
    throw new Error("This dev fixture has already been loaded for this store.");
  }

  await assertOrderObjectAccess(admin);

  if (existingStatus.progress.complete) {
    const marker = buildSeededMarker(config, shop, existingStatus.progress);
    await setSeededMarker(admin, marker, config);

    return {
      marker,
      productsCreated: existingStatus.progress.productsExisting,
      variantsCreated: config.fixture.products.reduce(
        (count, product) => count + product.variants.length,
        0,
      ),
      ordersCreated: existingStatus.progress.ordersExisting,
      refundsCreated: existingStatus.progress.refundsExisting,
      progress: existingStatus.progress,
      scenariosLoaded: config.fixture.scenarios?.length,
    };
  }

  const locationId = await getPrimaryLocationId(admin);
  const variantsBySku = new Map<string, CreatedVariant>();

  for (const product of config.fixture.products) {
    const createdVariants = await retryShopifyFixtureStep(
      () =>
        upsertProduct(
          admin,
          product,
          locationId,
          config,
          "initial",
        ),
      product.title,
    );

    for (const variant of createdVariants) {
      variantsBySku.set(variant.sku, variant);
    }
  }

  const createdOrders: CreatedOrder[] = [];

  for (const order of config.fixture.orders) {
    createdOrders.push(
      await retryShopifyFixtureStep(
        () => createOrder(admin, order, variantsBySku, config),
        order.name,
      ),
    );
  }

  let refundCount = 0;

  for (const order of config.fixture.orders) {
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

    if (createdOrder.refundCount > 0) {
      refundCount += 1;
      continue;
    }

    await createRefund(
      admin,
      createdOrder.id,
      lineItem.id,
      buildIdempotencyKey(config, "refund", order.name, order.refundSku),
    );
    refundCount += 1;
  }

  for (const product of config.fixture.products) {
    if (product.finalStatus || product.finalInventory !== undefined) {
      await retryShopifyFixtureStep(
        () => upsertProduct(admin, product, locationId, config, "final"),
        `${product.title} final state`,
      );
    }
  }

  const finalProgress = await buildFixtureProgress(admin, config);
  const marker = buildSeededMarker(config, shop, finalProgress);

  if (finalProgress.complete) {
    await setSeededMarker(admin, marker, config);
  }

  return {
    marker,
    productsCreated: finalProgress.productsExisting,
    variantsCreated: variantsBySku.size,
    ordersCreated: finalProgress.ordersExisting,
    refundsCreated: Math.max(refundCount, finalProgress.refundsExisting),
    progress: finalProgress,
    scenariosLoaded: config.fixture.scenarios?.length,
  };
}

function buildSeededMarker(
  config: FixtureConfig,
  shop: string,
  progress: FixtureProgress,
): SeededMarker {
  return {
    seededAt: new Date().toISOString(),
    fixtureVersion: config.fixture.version,
    shop,
    productCount: progress.productsExisting,
    orderCount: progress.ordersExisting,
    refundCount: progress.refundsExisting,
    scenarioCount: config.fixture.scenarios?.length,
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
  config: FixtureConfig,
  phase: "initial" | "final",
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
    productSet: buildProductSetInput(product, locationId, config, phase),
  });

  assertNoUserErrors(data.productSet.userErrors, product.title);

  const createdProduct = data.productSet.product;

  if (!createdProduct) {
    throw new Error(`Shopify did not return product ${product.title}.`);
  }

  return createdProduct.variants.nodes;
}

function buildProductSetInput(
  product: DummyProduct,
  locationId: string,
  config: FixtureConfig,
  phase: "initial" | "final",
) {
  const productStatus =
    phase === "final" ? product.finalStatus ?? product.status : product.status;

  return {
    title: product.title,
    handle: product.handle,
    status: productStatus,
    vendor: product.vendor,
    productType: product.productType,
    tags: [...config.fixture.tags, product.scenario],
    descriptionHtml: `<p>Jefe dev fixture for ${product.scenario}.</p>`,
    metafields: [
      {
        namespace: "jefe_dummy",
        key: "fixture_version",
        type: "single_line_text_field",
        value: config.fixture.version,
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
          quantity:
            phase === "final" && product.finalInventory !== undefined
              ? product.finalInventory
              : variant.inventory,
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
  config: FixtureConfig,
): Promise<CreatedOrder> {
  const existingOrder = await findExistingOrder(admin, order.name);

  if (existingOrder) {
    return existingOrder;
  }

  const customer = await upsertFixtureCustomer(admin, order.customer);
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
          currencyCode: config.fixture.currency,
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
      email: order.customer.email,
      buyerAcceptsMarketing: order.customer.acceptsMarketing,
      customer: {
        toAssociate: {
          id: customer.id,
        },
      },
      currency: config.fixture.currency,
      financialStatus: "PAID",
      processedAt: processedAt.toISOString(),
      sourceIdentifier: `${config.idempotencyPrefix}-${config.fixture.version}-${order.name}`,
      sourceName: config.sourceName,
      tags: [config.productTag, order.scenario],
      test: true,
      note: `Jefe dev fixture order for ${order.scenario}.`,
      customAttributes: [
        { key: "jefe_fixture_version", value: config.fixture.version },
        { key: "jefe_scenario", value: order.scenario },
        { key: "jefe_customer_email", value: order.customer.email },
        { key: "jefe_customer_first_name", value: order.customer.firstName },
        { key: "jefe_customer_last_name", value: order.customer.lastName },
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
    refundCount: data.orderCreate.order.refunds?.length ?? 0,
    lineItems: data.orderCreate.order.lineItems.nodes,
  };
}

async function upsertFixtureCustomer(
  admin: AdminGraphqlClient,
  customer: DummyCustomer,
): Promise<{ id: string; email: string }> {
  const data = await graphqlRequest<{
    customerSet: {
      customer: {
        id: string;
        email: string;
        firstName?: string | null;
        lastName?: string | null;
      } | null;
      userErrors: UserError[];
    };
  }>(admin, CUSTOMER_SET_MUTATION, {
    identifier: { email: customer.email },
    input: {
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      note: "Jefe dev fixture customer for winback testing.",
      tags: ["jefe-fixture-customer"],
    },
  });

  assertNoUserErrors(data.customerSet.userErrors, customer.email);

  if (!data.customerSet.customer) {
    throw new Error(`Shopify did not return customer ${customer.email}.`);
  }

  return {
    id: data.customerSet.customer.id,
    email: data.customerSet.customer.email,
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

  const order = data.orders.nodes.find(
    (candidate) => candidate.name === orderName,
  );

  if (!order) {
    return null;
  }

  return {
    id: order.id,
    name: order.name,
    refundCount: order.refunds?.length ?? 0,
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
          note: "Jefe dev refund fixture.",
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

      if (isRetryableShopifyError(message) && hasRetryRemaining) {
        continue;
      }

      throw error;
    }
  }
}

function buildIdempotencyKey(config: FixtureConfig, ...parts: string[]) {
  return [config.idempotencyPrefix, config.fixture.version, ...parts]
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 255);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setSeededMarker(
  admin: AdminGraphqlClient,
  marker: SeededMarker,
  config: FixtureConfig,
) {
  const statusData = await graphqlRequest<{
    currentAppInstallation: { id: string };
  }>(admin, STATUS_QUERY, {
    namespace: config.markerNamespace,
    key: config.markerKey,
  });

  const appInstallationId = statusData.currentAppInstallation.id;

  const data = await graphqlRequest<{
    metafieldsSet: {
      userErrors: UserError[];
    };
  }>(admin, SET_MARKER_MUTATION, {
    metafields: [
      {
        ownerId: appInstallationId,
        namespace: config.markerNamespace,
        key: config.markerKey,
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
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= SHOPIFY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await admin.graphql(
        query,
        variables ? { variables } : {},
      );
      const payload = await readGraphqlPayload<TData>(response);
      const errorMessage = payload.errors
        ?.map((error) => error.message)
        .join("; ");

      if (!response.ok || errorMessage) {
        const message =
          errorMessage || `Shopify GraphQL returned HTTP ${response.status}.`;
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));

        if (shouldRetryShopifyAttempt(message, response.status, attempt)) {
          await sleep(retryAfterMs ?? SHOPIFY_RETRY_DELAYS_MS[attempt]);
          continue;
        }

        throw new Error(message);
      }

      if (!payload.data) {
        throw new Error("Shopify returned an empty GraphQL response.");
      }

      return payload.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (shouldRetryShopifyAttempt(lastError.message, undefined, attempt)) {
        await sleep(SHOPIFY_RETRY_DELAYS_MS[attempt]);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Shopify GraphQL retries exhausted.");
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

async function retryShopifyFixtureStep<TData>(
  operation: () => Promise<TData>,
  label: string,
): Promise<TData> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= SHOPIFY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (shouldRetryShopifyAttempt(lastError.message, undefined, attempt)) {
        await sleep(SHOPIFY_RETRY_DELAYS_MS[attempt]);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(`${label}: Shopify retries exhausted.`);
}

async function readGraphqlPayload<TData>(response: Response): Promise<{
  data?: TData;
  errors?: Array<{ message: string }>;
}> {
  const body = await response.text();

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as {
      data?: TData;
      errors?: Array<{ message: string }>;
    };
  } catch (error) {
    if (response.ok) {
      throw new Error("Shopify returned invalid GraphQL JSON.");
    }

    return {
      errors: [
        {
          message: `Shopify GraphQL returned HTTP ${response.status}.`,
        },
      ],
    };
  }
}

function shouldRetryShopifyAttempt(
  message: string,
  status: number | undefined,
  attempt: number,
) {
  return (
    attempt < SHOPIFY_RETRY_DELAYS_MS.length &&
    (isRetryableShopifyStatus(status) || isRetryableShopifyError(message))
  );
}

function isRetryableShopifyStatus(status: number | undefined) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableShopifyError(message: string) {
  return /too many attempts|try again later|throttled|rate limit|temporarily unavailable|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(
    message,
  );
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(value);

  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}
