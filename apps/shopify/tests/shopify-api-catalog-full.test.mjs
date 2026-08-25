import assert from "node:assert/strict";
import test from "node:test";

import { loadShopifyApiCatalog, validateShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";
import { retrieveShopifyApiOperations } from "../app/lib/shopify/api/retrieval.server.js";
import {
  classifyShopifyOperationDomain,
  isKnownShopifyDomain,
  SHOPIFY_DOMAINS,
} from "../app/lib/shopify/api/domain-taxonomy.server.js";
import { classifyShopifyOperationSafety, INTERACTION } from "../app/lib/shopify/api/mutation-safety.server.js";
import { executeShopifyOperation, SHOPIFY_GATEWAY_STATUS } from "../app/lib/shopify/api/gateway.server.js";
import { recordExplicitHighRiskConfirmation } from "../app/lib/shopify/api/explicit-confirmation.server.js";
import { createHash } from "node:crypto";

// Guards the exact regression the previous investigation found: a seeded 16-operation catalog
// standing in for Shopify's real ~810-operation Admin API surface, and 58% of real operations
// collapsing into an undifferentiated "general" domain.

test("the live catalog reflects the real Shopify schema scale, not a hand-seeded stub", () => {
  const catalog = loadShopifyApiCatalog();
  assert.ok(catalog.operations.length > 500, `expected several hundred real operations, got ${catalog.operations.length}`);
  assert.equal(catalog.generatedFrom.kind, "admin_graphql_introspection");
  const queries = catalog.operations.filter((op) => op.operationKind === "QUERY").length;
  const mutations = catalog.operations.filter((op) => op.operationKind === "MUTATION").length;
  assert.ok(queries > 100, `expected 100+ queries, got ${queries}`);
  assert.ok(mutations > 300, `expected 300+ mutations, got ${mutations}`);
});

test("every operation resolves to a known taxonomy domain, and the long tail is a small honest residual", () => {
  const catalog = loadShopifyApiCatalog();
  const byDomain = new Map();
  for (const op of catalog.operations) {
    assert.ok(isKnownShopifyDomain(op.domain), `${op.operation} resolved to unknown domain ${op.domain}`);
    byDomain.set(op.domain, (byDomain.get(op.domain) ?? 0) + 1);
  }
  const otherUnknown = byDomain.get("other_unknown") ?? 0;
  assert.ok(
    otherUnknown / catalog.operations.length < 0.1,
    `other_unknown should be a small residual, was ${otherUnknown}/${catalog.operations.length}`,
  );
  // At least the domains this catalog is explicitly meant to make discoverable are represented.
  for (const domain of [
    "customers",
    "fulfillment",
    "discounts_promotions",
    "markets_international",
    "returns",
    "draft_orders",
    "order_edits",
    "subscriptions",
  ]) {
    assert.ok(byDomain.get(domain) > 0, `expected at least one operation in domain ${domain}`);
  }
});

test("retrieval surfaces the right domain's operations for customer, fulfillment, markets, and discount questions", () => {
  const customer = retrieveShopifyApiOperations("update a customer's marketing consent", { domains: ["customers"], limit: 5 });
  assert.ok(customer.some((row) => row.operation === "customerEmailMarketingConsentUpdate" || row.operation === "customerUpdate"));

  const fulfillment = retrieveShopifyApiOperations("hold a fulfillment order", { domains: ["fulfillment"], limit: 5 });
  assert.ok(fulfillment.some((row) => row.operation.toLowerCase().includes("fulfillmentorder")));

  const markets = retrieveShopifyApiOperations("configure a new international market", {
    domains: ["markets_international"],
    limit: 5,
  });
  assert.ok(markets.some((row) => row.operation.startsWith("market")));

  const discounts = retrieveShopifyApiOperations("create an automatic discount", {
    domains: ["discounts_promotions"],
    limit: 5,
  });
  assert.ok(discounts.some((row) => row.operation.toLowerCase().includes("discount")));
});

// Task §26's "future-proofing test", and per that task's own framing, "perhaps the most
// important test in this entire task": a Shopify API version bump can add operations Jefe has
// never seen, with zero engineering triage, and the generic runtime must still handle them
// end-to-end — discover, validate inputs, classify risk conservatively, produce a preview-worthy
// shape, require appropriate confirmation, execute against a fake Shopify client, ledger it
// idempotently, and be verifiable. If any of that needed a mutation-specific rule added to
// mutation-safety.server.js or gateway.server.js first, the architecture would not be finished —
// this test adds ONLY a catalog entry (what a real schema regeneration would produce) and zero
// executor code.
test("an entirely unseen, synthetic Shopify mutation is discoverable, conservatively classified, and genuinely executable without any new executor code", async () => {
  const catalog = loadShopifyApiCatalog();
  const before = catalog.operations.length;
  const domain = classifyShopifyOperationDomain("widgetFrobnicate");
  assert.equal(domain, "other_unknown", "a genuinely novel operation name should fall to the honest unknown bucket");

  // Step 3: classify risk conservatively — computed by the real classifier, not hand-picked.
  const { safety, execution } = classifyShopifyOperationSafety({
    operation: "widgetFrobnicate",
    operationKind: "MUTATION",
    domain: "other_unknown",
    scopeConfidence: "unknown",
  });
  assert.equal(execution.status, "EXECUTABLE_WITH_CONFIRMATION", "an unseen mutation must never be a dead end");
  assert.equal(safety.interaction, INTERACTION.systemCriticalConfirmation, "an unknown operation defaults to the strongest confirmation tier");
  assert.equal(safety.riskTier, "PLATFORM_CRITICAL");

  // Step 1: discoverable — simulates exactly what a real schema regeneration adds: a stub built
  // purely from generic introspection metadata, with the classifier's own real output.
  const syntheticStub = {
    id: "test.fixture.mutation.widgetFrobnicate",
    operation: "widgetFrobnicate",
    operationKind: "MUTATION",
    domain: "other_unknown",
    description: "A fixture operation that does not exist in the real schema — simulates a future Shopify API release.",
    requiredScopes: [],
    scopeConfidence: "unknown",
    safety,
    execution,
    arguments: [{ name: "input", type: "WidgetFrobnicateInput!", required: true }],
    inputObjects: {
      WidgetFrobnicateInput: { fields: [{ name: "widgetId", type: "ID!", required: true }] },
    },
    enumTypes: {},
    returnType: "WidgetFrobnicatePayload",
    deprecation: { deprecated: false, reason: null },
    document: "mutation TestWidgetFrobnicate($input: WidgetFrobnicateInput!) { widgetFrobnicate(input: $input) { widget { id } userErrors { field message } } }",
    tags: ["widget", "frobnicate"],
  };
  const augmented = { ...catalog, operations: [...catalog.operations, syntheticStub] };
  assert.equal(validateShopifyApiCatalog(augmented).ok, true);
  assert.equal(augmented.operations.length, before + 1);
  const found = retrieveShopifyApiOperations("widget frobnicate", { catalog: augmented, limit: 5 });
  assert.ok(found.some((row) => row.operation === "widgetFrobnicate"), "schema upgrade should expand discovery");

  // Step 2: input validation from generic schema metadata — no widget-specific code exists
  // anywhere in the repo, yet a missing required field is still caught.
  const { validateShopifyOperationVariables, getShopifyApiOperationStub } = await import("../app/lib/shopify/api/catalog.server.js");
  const missingInput = validateShopifyOperationVariables(syntheticStub, {});
  assert.equal(missingInput.ok, false);
  assert.ok(missingInput.errors.some((error) => error.includes("input is required")));
  const validVariables = { input: { widgetId: "gid://shopify/Widget/1" } };
  assert.equal(validateShopifyOperationVariables(syntheticStub, validVariables).ok, true);
  const stubFromAugmentedCatalog = getShopifyApiOperationStub("widgetFrobnicate", { catalog: augmented });
  assert.ok(stubFromAugmentedCatalog, "the operation must be resolvable through the normal catalog lookup path");

  // Steps 4-6: preview-worthy shape, appropriate confirmation, and real execution through the
  // generic gateway — the exact same executeShopifyOperation() every real mutation goes through,
  // fed a fake Shopify client. Confirmation is required and denied first, then granted and the
  // call actually executes and ledgers.
  const merchantId = "00000000-0000-0000-0000-00000000f001";
  const shopId = "00000000-0000-0000-0000-00000000f002";
  const actionId = "00000000-0000-0000-0000-00000000f003";
  const prisma = fixturePrisma({
    action: {
      id: actionId,
      merchantId,
      shopId,
      status: "accepted",
      plan: {},
      progress: {
        agentic: {
          currentActionRevision: "rev-1",
          acceptedActionRevision: "rev-1",
          outcome: "Frobnicate a widget as part of an accepted Action.",
          materialExpectedEffects: ["Frobnicate a widget"],
          constraints: [],
        },
      },
    },
  });
  const client = fixtureClient({ widgetFrobnicate: { widget: { id: "gid://shopify/Widget/1" }, userErrors: [] } });
  const baseCall = {
    prisma,
    client,
    merchantId,
    shopId,
    shopDomain: "jefe-local-store.myshopify.com",
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "widgetFrobnicate",
    variables: validVariables,
    grantedScopes: [],
    catalog: augmented,
    logger: { info() {}, warn() {}, error() {} },
  };

  const denied = await executeShopifyOperation(baseCall);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, SHOPIFY_GATEWAY_STATUS.needsExplicitConfirmation, "step 5: appropriate confirmation is required before execution");

  await recordExplicitHighRiskConfirmation({
    prisma,
    merchantId,
    shopId,
    actionId,
    acceptedActionRevision: "rev-1",
    operation: "widgetFrobnicate",
    variablesHash: hashForFixture(validVariables),
    interactionTier: INTERACTION.systemCriticalConfirmation,
    riskTier: safety.riskTier,
    confirmedBy: "merchant:test",
    confirmationText: "Yes, frobnicate this widget.",
  });

  const executed = await executeShopifyOperation(baseCall);
  assert.equal(executed.status, SHOPIFY_GATEWAY_STATUS.ok, "step 6: the generic executor invokes the unseen operation with zero new executor code");
  assert.deepEqual(executed.resourceIds, ["gid://shopify/Widget/1"]);

  // Step 7: recorded/idempotent — a durable receipt exists via the same ledger every operation uses.
  assert.ok(prisma.shopifyOperationCall.rows.some((row) => row.operationName === "widgetFrobnicate" && row.status === "OK"));

  // Step 8: generically verifiable — the receipt carries exactly what verification-agent.server.js
  // needs (resourceIds + operation + variables), the same shape any real mutation's receipt has.
  const receipt = prisma.shopifyOperationCall.rows.find((row) => row.operationName === "widgetFrobnicate" && row.status === "OK");
  assert.ok(Array.isArray(receipt.resourceIds) && receipt.resourceIds.length > 0);
});

function fixturePrisma({ action }) {
  const rows = [];
  const events = [];
  const prisma = {
    merchantAction: { findFirst: async () => action },
    merchantActionEvent: {
      create: async ({ data }) => {
        const row = { createdAt: new Date(), ...data };
        events.push(row);
        return row;
      },
      findFirst: async ({ where }) => {
        const matches = events.filter(
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
      rows,
      findFirst: async () => null,
      create: async ({ data }) => {
        rows.push(data);
        return data;
      },
    },
  };
  return prisma;
}

function fixtureClient(response) {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [] } };
      }
      return response;
    },
  };
}

function hashForFixture(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

test("retrieval covers the full range of merchant-intent queries across all required domains", () => {
  // Task "Finish & Harden..." Part 6 — one query per required domain, phrased the way a
  // merchant-intent diagnosis would naturally read, not tuned to match operation names.
  const cases = [
    ["high-value customers going quiet", "customers"],
    ["repeat purchase falling", "customer_segments"],
    ["customer segmentation", "customer_segments"],
    ["promotion not working", "discounts_promotions"],
    ["discount loyal customers", "discounts_promotions"],
    ["increase repeat purchase with an offer", "discounts_promotions"],
    ["orders waiting too long to fulfil", "fulfillment"],
    ["stuck fulfillment", "fulfillment"],
    ["returns increasing", "returns"],
    ["return workflow", "returns"],
    ["international sales", "markets_international"],
    ["country-specific performance", "markets_international"],
    ["navigation problem", "navigation"],
    ["product discovery", "collections"],
    ["content", "content"],
    ["capture product costs", "inventory"],
    ["stock movement", "inventory_transfers"],
    ["product unavailable on a sales channel", "publishing_channels"],
  ];
  for (const [query, expectedDomain] of cases) {
    const results = retrieveShopifyApiOperations(query, { limit: 8 });
    assert.ok(
      results.some((row) => row.domain === expectedDomain),
      `"${query}" should retrieve at least one ${expectedDomain} operation, got: ${results.map((r) => `${r.operation}(${r.domain})`).join(", ")}`,
    );
  }
});

test("SHOPIFY_DOMAINS is exhaustive over what the classifier can return", () => {
  const catalog = loadShopifyApiCatalog();
  const known = new Set(SHOPIFY_DOMAINS);
  for (const op of catalog.operations) {
    assert.ok(known.has(op.domain), `${op.operation} domain ${op.domain} missing from SHOPIFY_DOMAINS`);
  }
});
