import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  getShopifyApiOperationStub,
  loadShopifyApiCatalog,
  validateShopifyApiCatalog,
  validateShopifyOperationVariables,
} from "../app/lib/shopify/api/catalog.server.js";
import { retrieveShopifyApiOperations } from "../app/lib/shopify/api/retrieval.server.js";
import {
  executeShopifyOperation,
  SHOPIFY_GATEWAY_STATUS,
} from "../app/lib/shopify/api/gateway.server.js";

const merchantId = "00000000-0000-0000-0000-000000000001";
const shopId = "00000000-0000-0000-0000-000000000002";
const actionId = "00000000-0000-0000-0000-000000000003";

test("generated Shopify API catalog validates and separates reads from writes", () => {
  const catalog = loadShopifyApiCatalog();
  assert.equal(catalog.catalogId, "shopify-admin-api:2026-07");
  assert.equal(validateShopifyApiCatalog(catalog).ok, true);
  assert.ok(catalog.operations.some((operation) => operation.operation === "products" && operation.operationKind === "QUERY"));
  assert.ok(catalog.operations.some((operation) => operation.operation === "collectionCreate" && operation.operationKind === "MUTATION"));
  assert.ok(catalog.operations.every((operation) => !Object.hasOwn(operation, "executorRef")));
});

test("retrieval returns a small relevant Shopify API subset", () => {
  const results = retrieveShopifyApiOperations("create a merchandising collection and populate it with products", {
    operationKind: "MUTATION",
    limit: 4,
  });
  assert.ok(results.length <= 4);
  assert.ok(results.some((row) => row.operation === "collectionCreate"));
  assert.ok(results.some((row) => row.operation === "collectionAddProducts"));
  assert.equal(results.some((row) => row.operation === "refundCreate"), false);
});

test("operation variable validation rejects missing nested required fields", () => {
  const create = getShopifyApiOperationStub("collectionCreate");
  assert.equal(validateShopifyOperationVariables(create, { input: { title: "London delivery" } }).ok, true);
  const invalid = validateShopifyOperationVariables(create, { input: { handle: "london-delivery" } });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("input.title is required"));

  const update = getShopifyApiOperationStub("productUpdate");
  const enumError = validateShopifyOperationVariables(update, {
    product: { id: "gid://shopify/Product/1", status: "REMOVED" },
  });
  assert.equal(enumError.ok, false);
  assert.ok(enumError.errors.some((error) => error.includes("ACTIVE, ARCHIVED, DRAFT")));
});

test("gateway permits reads without accepted Action authorization and ledgers the provider result", async () => {
  const prisma = fakePrisma();
  const client = fakeClient({ products: { edges: [], pageInfo: { hasNextPage: false } } });
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    operation: "products",
    variables: { first: 10 },
    grantedScopes: ["read_products"],
    purpose: "Investigate catalogue structure before recommending an Action",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.ok);
  assert.equal(prisma.calls.at(-1).data.operationName, "products");
  assert.equal(prisma.calls.at(-1).data.gatewayDecision, "provider_result");
});

test("gateway denies mutations before Action revision acceptance", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    operation: "collectionCreate",
    variables: { input: { title: "London delivery" } },
    grantedScopes: ["write_products"],
    purpose: "Create the accepted merchandising collection",
    expectedEffect: "Create a Shopify collection",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.deniedActionNotAccepted);
  assert.equal(result.gatewayDecision, "mutation_without_accepted_action_revision");
});

test("gateway denies stale accepted Action revisions", async () => {
  const prisma = fakePrisma({
    action: acceptedCollectionAction({
      progress: {
        agentic: {
          currentActionRevision: "rev-2",
          acceptedActionRevision: "rev-1",
          outcome: "Create a London delivery collection",
        },
      },
    }),
  });
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables: { input: { title: "London delivery" } },
    grantedScopes: ["write_products"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.deniedAcceptedRevisionStale);
  assert.equal(result.gatewayDecision, "accepted_revision_not_current");
});

test("gateway checks actual granted Shopify scopes", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables: { input: { title: "London delivery" } },
    grantedScopes: ["read_products"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsAuthorization);
  assert.deepEqual(result.responseSummary.missingScopes, ["write_products"]);
});

test("accepted-intent guard blocks pricing drift during collection execution", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "productVariantsBulkUpdate",
    variables: {
      productId: "gid://shopify/Product/1",
      variants: [{ id: "gid://shopify/ProductVariant/1", price: "12.00" }],
    },
    grantedScopes: ["write_products"],
    purpose: "Lower the price while creating the collection",
    expectedEffect: "Change product pricing",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.deniedIntent);
  assert.equal(result.gatewayDecision, "pricing_effect_outside_accepted_intent");
});

test("gateway returns Shopify userErrors as structured tool results", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const client = fakeClient({
    collectionCreate: {
      collection: null,
      userErrors: [{ field: ["input", "title"], message: "Title has already been taken" }],
    },
  });
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables: { input: { title: "London delivery" } },
    grantedScopes: ["write_products"],
    purpose: "Create the accepted merchandising collection",
    expectedEffect: "Create a Shopify collection",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.userErrors);
  assert.deepEqual(result.userErrors, [
    { field: "input.title", message: "Title has already been taken", code: null },
  ]);
  assert.equal(prisma.calls.at(-1).data.status, SHOPIFY_GATEWAY_STATUS.userErrors);
});

test("gateway replays duplicate idempotent writes without a second provider call", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const client = fakeClient({
    collectionCreate: {
      collection: { id: "gid://shopify/Collection/99", title: "London delivery" },
      userErrors: [],
    },
  });
  const input = {
    ...baseInput(prisma, client),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables: { input: { title: "London delivery" } },
    grantedScopes: ["write_products"],
    purpose: "Create the accepted merchandising collection",
    expectedEffect: "Create a Shopify collection",
    idempotencyKey: "create-london-delivery-collection",
  };

  const first = await executeShopifyOperation(input);
  const second = await executeShopifyOperation(input);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.status, SHOPIFY_GATEWAY_STATUS.idempotentReplay);
  assert.equal(client.requests.length, 1);
  assert.equal(prisma.calls.at(-1).data.gatewayDecision, "idempotent_replay");
});

test("gateway blocks idempotent retries when the previous write result is unknown", async () => {
  const variables = { input: { title: "London delivery" } };
  const prisma = fakePrisma({
    action: acceptedCollectionAction(),
    calls: [
      {
        data: {
          merchantId,
          shopId,
          merchantActionId: actionId,
          acceptedActionRevision: "rev-1",
          operationName: "collectionCreate",
          idempotencyKey: "create-london-delivery-collection",
          variablesHash: hashForTest(variables),
          status: "CALLING_PROVIDER",
          resourceIds: [],
          responseSummary: {},
        },
      },
    ],
  });
  const client = fakeClient({});

  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables,
    grantedScopes: ["write_products"],
    purpose: "Create the accepted merchandising collection",
    expectedEffect: "Create a Shopify collection",
    idempotencyKey: "create-london-delivery-collection",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsReconciliation);
  assert.equal(client.requests.length, 0);
  assert.equal(prisma.calls.at(-1).data.gatewayDecision, "idempotent_write_result_unknown");
});

function baseInput(prisma, client) {
  return {
    prisma,
    client,
    merchantId,
    shopId,
    shopDomain: "jefe-local-store.myshopify.com",
    logger: { info() {}, warn() {}, error() {} },
  };
}

function acceptedCollectionAction(overrides = {}) {
  return {
    id: actionId,
    merchantId,
    shopId,
    title: "Create a London fast-delivery collection",
    summary: "Make qualifying products easier for London customers to discover.",
    status: "accepted",
    plan: {},
    progress: {
      agentic: {
        currentActionRevision: "rev-1",
        acceptedActionRevision: "rev-1",
        outcome: "Create a London fast-delivery collection containing qualifying products.",
        materialExpectedEffects: [
          "Create or update Shopify merchandising resources",
          "Associate qualifying products with the collection",
        ],
        constraints: ["Do not change prices."],
      },
    },
    ...overrides,
  };
}

function fakePrisma({ action = null, calls = [] } = {}) {
  const prisma = {
    calls: [...calls],
    merchantAction: {
      findFirst: async ({ where }) =>
        action &&
        action.id === where.id &&
        action.merchantId === where.merchantId &&
        action.shopId === where.shopId
          ? action
          : null,
    },
    shopifyOperationCall: {
      findFirst: async ({ where }) => {
        const rows = prisma.calls.map((row, index) => ({ id: `call-${index + 1}`, ...row.data }));
        return (
          rows
            .reverse()
            .find(
              (row) =>
                row.merchantId === where.merchantId &&
                row.shopId === where.shopId &&
                row.merchantActionId === where.merchantActionId &&
                row.acceptedActionRevision === where.acceptedActionRevision &&
                row.operationName === where.operationName &&
                row.idempotencyKey === where.idempotencyKey &&
                row.variablesHash === where.variablesHash,
            ) ?? null
        );
      },
      create: async ({ data }) => {
        const row = { data };
        prisma.calls.push(row);
        return row;
      },
    },
  };
  return prisma;
}

function hashForTest(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

function fakeClient(response) {
  return {
    requests: [],
    async request(document, variables) {
      this.requests.push({ document, variables });
      return response;
    },
  };
}
