import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  executeShopifyOperation,
  SHOPIFY_GATEWAY_STATUS,
} from "../app/lib/shopify/api/gateway.server.js";
import { recordExplicitHighRiskConfirmation } from "../app/lib/shopify/api/explicit-confirmation.server.js";
import { getConfiguredShopifyApiVersion } from "../app/lib/shopify/api-version.server.js";
import { loadGatewaySchemaIndex } from "../app/lib/shopify/gateway/schema-index.server.js";
import { analyzeGatewayDocument, GATEWAY_MODE } from "../app/lib/shopify/gateway/document.server.js";
import { buildSyntheticGatewayStub } from "../app/lib/shopify/gateway/synthetic-stub.server.js";

// docs/ops/agentic-shopify-gateway-full/: executeShopifyOperation (this file's real subject) no
// longer resolves a stub from a catalog operation name — stubOverride, built from a real, agent-
// composed GraphQL document via the same seam gateway/tools.server.js uses in production, is now
// the only way to reach it. These tests exercise the shared safety/idempotency/ledger pipeline
// itself (accepted-Action-revision authorization, live-scope checks, blast-radius/pricing-intent
// guard, explicit high-risk confirmation, idempotent replay) through that entry point, using real
// documents against the real Shopify Admin schema index rather than fixture catalog stubs.

const merchantId = "00000000-0000-0000-0000-000000000001";
const shopId = "00000000-0000-0000-0000-000000000002";
const actionId = "00000000-0000-0000-0000-000000000003";
const apiVersion = getConfiguredShopifyApiVersion();
const schemaIndex = loadGatewaySchemaIndex();

/** @param {string} document @param {Record<string, any>} [variables] @param {"QUERY_ONLY"|"MUTATION_ONLY"} [mode] */
function stubFor(document, variables = {}, mode = GATEWAY_MODE.mutationOnly) {
  const analysis = analyzeGatewayDocument({ documentText: document, mode, variables, schemaIndex });
  assert.equal(analysis.ok, true, `test fixture document failed to analyze: ${JSON.stringify(analysis)}`);
  return buildSyntheticGatewayStub({ analysis, apiVersion });
}

const PRODUCTS_QUERY = "query($first: Int!) { products(first: $first) { edges { node { id } } pageInfo { hasNextPage } } }";
const COLLECTION_CREATE_MUTATION =
  "mutation($collection: CollectionCreateInput!) { collectionCreate(collection: $collection) { collection { id title } userErrors { field message } } }";
const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION =
  "mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { field message } } }";
const APP_REVOKE_ACCESS_SCOPES_MUTATION =
  "mutation($scopes: [String!]!) { appRevokeAccessScopes(scopes: $scopes) { revoked { handle } userErrors { field message } } }";
const CUSTOMER_DELETE_MUTATION =
  "mutation($input: CustomerDeleteInput!) { customerDelete(input: $input) { deletedCustomerId userErrors { field message } } }";
const TAGS_ADD_MUTATION = "mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }";

test("gateway permits reads without accepted Action authorization and ledgers the provider result", async () => {
  const prisma = fakePrisma();
  const client = fakeClient({ products: { edges: [], pageInfo: { hasNextPage: false } } });
  const variables = { first: 10 };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    operation: "products",
    variables,
    stubOverride: stubFor(PRODUCTS_QUERY, variables, GATEWAY_MODE.queryOnly),
    grantedScopes: ["read_products"],
    purpose: "Investigate catalogue structure before recommending an Action",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.ok);
  assert.equal(prisma.calls.at(-1).data.operationName, "products");
  assert.equal(prisma.calls.at(-1).data.gatewayDecision, "provider_result");
});

test("gateway authorizes products read from live Shopify scopes when local scope snapshot is stale", async () => {
  const prisma = fakePrisma();
  const client = fakeClient(
    { products: { edges: [], pageInfo: { hasNextPage: false } } },
    { grantedScopes: ["read_products", "write_products"] },
  );
  const variables = { first: 10 };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    operation: "products",
    variables,
    stubOverride: stubFor(PRODUCTS_QUERY, variables, GATEWAY_MODE.queryOnly),
    grantedScopes: ["write_products"],
    purpose: "Investigate current products from Shopify despite stale local scope metadata.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.ok);
  assert.equal(
    client.requests.filter((request) => request.document.includes("currentAppInstallation")).length,
    1,
  );
  assert.equal(prisma.calls.at(-1).data.gatewayDecision, "provider_result");
});

test("gateway denies required scope when live Shopify installation does not grant it", async () => {
  const prisma = fakePrisma();
  const client = fakeClient(
    { products: { edges: [], pageInfo: { hasNextPage: false } } },
    { grantedScopes: ["write_products"] },
  );
  const variables = { first: 10 };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    operation: "products",
    variables,
    stubOverride: stubFor(PRODUCTS_QUERY, variables, GATEWAY_MODE.queryOnly),
    grantedScopes: ["read_products", "write_products"],
    purpose: "This must use Shopify's actual installed authorization, not local metadata.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsAuthorization);
  assert.deepEqual(result.responseSummary.missingScopes, ["read_products"]);
  assert.equal(
    client.requests.filter((request) => !request.document.includes("currentAppInstallation")).length,
    0,
  );
});

test("gateway denies mutations before Action revision acceptance", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const variables = { collection: { title: "London delivery" } };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    operation: "collectionCreate",
    variables,
    stubOverride: stubFor(COLLECTION_CREATE_MUTATION, variables),
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
  const variables = { collection: { title: "London delivery" } };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables,
    stubOverride: stubFor(COLLECTION_CREATE_MUTATION, variables),
    grantedScopes: ["write_products"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.deniedAcceptedRevisionStale);
  assert.equal(result.gatewayDecision, "accepted_revision_not_current");
});

test("gateway checks actual granted Shopify scopes", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const variables = { collection: { title: "London delivery" } };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({}, { grantedScopes: ["read_products"] })),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables,
    stubOverride: stubFor(COLLECTION_CREATE_MUTATION, variables),
    grantedScopes: ["read_products"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsAuthorization);
  assert.deepEqual(result.responseSummary.missingScopes, ["write_products"]);
});

test("accepted-intent guard blocks pricing drift during collection execution", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const variables = {
    productId: "gid://shopify/Product/1",
    variants: [{ id: "gid://shopify/ProductVariant/1", price: "12.00" }],
  };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "productVariantsBulkUpdate",
    variables,
    stubOverride: stubFor(PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, variables),
    grantedScopes: ["write_products"],
    purpose: "Lower the price while creating the collection",
    expectedEffect: "Change product pricing",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.deniedIntent);
  assert.equal(result.gatewayDecision, "pricing_effect_outside_accepted_intent");
});

test("a formerly-prohibited operation is executable but needs a durable explicit confirmation, even with an accepted Action", async () => {
  const prisma = fakePrisma({
    action: acceptedCollectionAction({
      progress: {
        agentic: {
          currentActionRevision: "rev-1",
          acceptedActionRevision: "rev-1",
          outcome: "Reduce Jefe's own granted Shopify scopes.",
          materialExpectedEffects: ["Revoke previously granted access scopes"],
          constraints: [],
        },
      },
    }),
  });
  const variables = { scopes: ["write_products"] };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "appRevokeAccessScopes",
    variables,
    stubOverride: stubFor(APP_REVOKE_ACCESS_SCOPES_MUTATION, variables),
    grantedScopes: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsExplicitConfirmation);
  assert.equal(result.gatewayDecision, "explicit_high_risk_confirmation_missing");
});

test("gateway requires explicit destructive confirmation for an unreviewed delete-shaped mutation, even with the right scope and an accepted Action", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction({ progress: { agentic: { currentActionRevision: "rev-1", acceptedActionRevision: "rev-1", outcome: "Delete a customer record.", materialExpectedEffects: ["Delete a customer"], constraints: [] } } }) });
  const variables = { input: { id: "gid://shopify/Customer/1" } };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({}, { grantedScopes: ["write_customers"] })),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "customerDelete",
    variables,
    stubOverride: stubFor(CUSTOMER_DELETE_MUTATION, variables),
    grantedScopes: ["write_customers"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsExplicitConfirmation);
  assert.equal(result.gatewayDecision, "explicit_high_risk_confirmation_missing");
});

test("a mutation whose required scope is not confidently known is still executable, but only at the explicit confirmation tier — unknown never means frictionless", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction({ progress: { agentic: { currentActionRevision: "rev-1", acceptedActionRevision: "rev-1", outcome: "Tag a product.", materialExpectedEffects: ["Add tags to a product"], constraints: [] } } }) });
  const variables = { id: "gid://shopify/Product/1", tags: ["evergreen"] };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, fakeClient({})),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "tagsAdd",
    variables,
    stubOverride: stubFor(TAGS_ADD_MUTATION, variables),
    grantedScopes: ["write_products"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsExplicitConfirmation);
  assert.equal(result.gatewayDecision, "explicit_high_risk_confirmation_missing");
  assert.match(result.error, /explicit high-risk confirmation/);
});

test("recording an explicit high-risk confirmation lets a destructive mutation proceed to the intent/idempotency gates", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction({ progress: { agentic: { currentActionRevision: "rev-1", acceptedActionRevision: "rev-1", outcome: "Delete a customer record.", materialExpectedEffects: ["Delete a customer"], constraints: [] } } }) });
  const variables = { input: { id: "gid://shopify/Customer/1" } };
  await recordExplicitHighRiskConfirmation({
    prisma,
    merchantId,
    shopId,
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "customerDelete",
    variablesHash: hashForTest(variables),
    interactionTier: "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED",
    riskTier: "DESTRUCTIVE",
    confirmedBy: "merchant:test",
    confirmationText: "Yes, delete this customer.",
  });
  const client = fakeClient(
    { customerDelete: { deletedCustomerId: "gid://shopify/Customer/1", userErrors: [] } },
    { grantedScopes: ["write_customers"] },
  );
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "customerDelete",
    variables,
    stubOverride: stubFor(CUSTOMER_DELETE_MUTATION, variables),
    grantedScopes: ["write_customers"],
  });
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.ok);
  assert.equal(result.ok, true);
});

test("gateway returns Shopify userErrors as structured tool results", async () => {
  const prisma = fakePrisma({ action: acceptedCollectionAction() });
  const client = fakeClient({
    collectionCreate: {
      collection: null,
      userErrors: [{ field: ["collection", "title"], message: "Title has already been taken" }],
    },
  });
  const variables = { collection: { title: "London delivery" } };
  const result = await executeShopifyOperation({
    ...baseInput(prisma, client),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables,
    stubOverride: stubFor(COLLECTION_CREATE_MUTATION, variables),
    grantedScopes: ["write_products"],
    purpose: "Create the accepted merchandising collection",
    expectedEffect: "Create a Shopify collection",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.userErrors);
  assert.deepEqual(result.userErrors, [
    { field: "collection.title", message: "Title has already been taken", code: null },
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
  const variables = { collection: { title: "London delivery" } };
  const input = {
    ...baseInput(prisma, client),
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "collectionCreate",
    variables,
    stubOverride: stubFor(COLLECTION_CREATE_MUTATION, variables),
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
  assert.equal(operationRequests(client).length, 1);
  assert.equal(prisma.calls.at(-1).data.gatewayDecision, "idempotent_replay");
});

test("gateway blocks idempotent retries when the previous write result is unknown", async () => {
  const variables = { collection: { title: "London delivery" } };
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
    stubOverride: stubFor(COLLECTION_CREATE_MUTATION, variables),
    grantedScopes: ["write_products"],
    purpose: "Create the accepted merchandising collection",
    expectedEffect: "Create a Shopify collection",
    idempotencyKey: "create-london-delivery-collection",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, SHOPIFY_GATEWAY_STATUS.needsReconciliation);
  assert.equal(operationRequests(client).length, 0);
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
    merchantActionEvent: {
      events: [],
      create: async ({ data }) => {
        const row = { id: `event-${prisma.merchantActionEvent.events.length + 1}`, createdAt: new Date(), ...data };
        prisma.merchantActionEvent.events.push(row);
        return row;
      },
      findFirst: async ({ where }) => {
        const matches = prisma.merchantActionEvent.events.filter(
          (row) =>
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId &&
            row.merchantActionId === where.merchantActionId &&
            row.eventType === where.eventType &&
            row.createdAt >= where.createdAt.gte,
        );
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches[0] ?? null;
      },
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

function fakeClient(response, options = {}) {
  const grantedScopes = options.grantedScopes ?? ["read_products", "write_products"];
  return {
    requests: [],
    async request(document, variables) {
      this.requests.push({ document, variables });
      if (document.includes("currentAppInstallation")) {
        return {
          currentAppInstallation: {
            accessScopes: grantedScopes.map((handle) => ({ handle })),
          },
        };
      }
      return response;
    },
  };
}

function operationRequests(client) {
  return client.requests.filter((request) => !request.document.includes("currentAppInstallation"));
}
