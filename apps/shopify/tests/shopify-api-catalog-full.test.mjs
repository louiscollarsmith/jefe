import assert from "node:assert/strict";
import test from "node:test";

import { loadShopifyApiCatalog, validateShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";
import { retrieveShopifyApiOperations } from "../app/lib/shopify/api/retrieval.server.js";
import {
  classifyShopifyOperationDomain,
  isKnownShopifyDomain,
  SHOPIFY_DOMAINS,
} from "../app/lib/shopify/api/domain-taxonomy.server.js";
import { classifyShopifyOperationSafety } from "../app/lib/shopify/api/mutation-safety.server.js";

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

test("an operation absent from the catalog is not silently discoverable, and adding one expands discovery without granting execution", () => {
  const catalog = loadShopifyApiCatalog();
  const before = catalog.operations.length;
  const domain = classifyShopifyOperationDomain("widgetFrobnicate");
  assert.equal(domain, "other_unknown", "a genuinely novel operation name should fall to the honest unknown bucket");

  const { safety, execution } = classifyShopifyOperationSafety({
    operation: "widgetFrobnicateBulkDelete",
    operationKind: "MUTATION",
    domain: "other_unknown",
    scopeConfidence: "unknown",
  });
  assert.notEqual(execution.status, "EXECUTABLE");
  assert.notEqual(execution.status, "EXECUTABLE_WITH_CONFIRMATION");
  assert.equal(execution.status, "UNSUPPORTED_SEMANTICS");
  assert.ok(safety.riskTier);

  const augmented = {
    ...catalog,
    operations: [
      ...catalog.operations,
      {
        id: "test.fixture.mutation.widgetFrobnicate",
        operation: "widgetFrobnicate",
        operationKind: "MUTATION",
        domain: "other_unknown",
        description: "A fixture operation that does not exist in the real schema.",
        requiredScopes: [],
        scopeConfidence: "unknown",
        safety: { riskTier: "SENSITIVE", reversibility: "UNKNOWN", interaction: "APPROVAL_REQUIRED" },
        execution: { status: "UNSUPPORTED_SEMANTICS", reason: "fixture" },
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "Boolean",
        deprecation: { deprecated: false, reason: null },
        document: "mutation TestWidgetFrobnicate { widgetFrobnicate { __typename } }",
        tags: ["widget", "frobnicate"],
      },
    ],
  };
  assert.equal(validateShopifyApiCatalog(augmented).ok, true);
  assert.equal(augmented.operations.length, before + 1);
  const found = retrieveShopifyApiOperations("widget frobnicate", { catalog: augmented, limit: 5 });
  assert.ok(found.some((row) => row.operation === "widgetFrobnicate"), "schema upgrade should expand discovery");
  assert.equal(
    augmented.operations.find((op) => op.operation === "widgetFrobnicate").execution.status,
    "UNSUPPORTED_SEMANTICS",
    "a newly discovered operation must not automatically become executable",
  );
});

test("named permanent prohibitions resolve to PROHIBITED and remain discoverable", () => {
  const catalog = loadShopifyApiCatalog();
  const appUninstall = catalog.operations.find((op) => op.operation === "appUninstall");
  assert.ok(appUninstall, "appUninstall should still be present in the catalog — visible, not hidden");
  assert.equal(appUninstall.execution.status, "PROHIBITED");
  const retrieved = retrieveShopifyApiOperations("uninstall the app", { limit: 5 });
  assert.ok(retrieved.some((row) => row.operation === "appUninstall"), "a prohibited operation must still be discoverable");
});

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
