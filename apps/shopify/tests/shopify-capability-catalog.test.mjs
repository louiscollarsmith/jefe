import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  diffShopifyCapabilityCatalogs,
  getShopifyCapabilityManifest,
  loadShopifyCapabilityCatalog,
  parseScopeList,
  resolveShopifyCapabilityAvailability,
  SHOPIFY_CAPABILITY_AVAILABILITY,
  validateShopifyCapabilityCatalog,
} from "../app/lib/shopify/capabilities/catalog.server.js";
import {
  buildShopifyCapabilityQualificationPlan,
  evaluateShopifyCapabilityQualification,
} from "../app/lib/shopify/capabilities/qualification.server.js";
import { searchShopifyCapabilities } from "../app/lib/shopify/capabilities/search.server.js";
import {
  extractOperationsFromIntrospectionJson,
  FINAL_SHOPIFY_CAPABILITY_SEMANTIC_PROMPT,
  renderGraphqlType,
  renderShopifyCapabilityReport,
} from "../app/lib/shopify/capabilities/discovery.server.js";
import {
  getShopifyActionCapability,
  listShopifyActionCapabilities,
} from "../app/lib/actions/shopify-action-capabilities.server.js";

test("versioned Shopify capability catalog validates and spans required domains", () => {
  const catalog = loadShopifyCapabilityCatalog();
  assert.equal(catalog.catalogId, "shopify-capabilities:2026-07");
  assert.equal(validateShopifyCapabilityCatalog(catalog).ok, true);
  assert.ok(catalog.operations.length >= 12);
  for (const domain of [
    "products",
    "inventory",
    "locations",
    "discounts",
    "collections",
    "orders",
    "fulfillment",
    "customers",
    "metafields",
  ]) {
    assert.ok(
      catalog.operations.some((operation) => operation.domain === domain),
      `expected ${domain} capability`,
    );
  }
});

test("technical facts and semantic interpretation stay separate", () => {
  const transfer = getShopifyCapabilityManifest("inventoryTransferCreate");
  assert.equal(transfer.technical.inputType, "InventoryTransferCreateInput");
  assert.equal(transfer.technical.returnsUserErrors, true);
  assert.equal(transfer.semantic.provenance.kind, "seeded_semantic_interpretation");
  assert.ok(transfer.semantic.semanticEffects[0].includes("moving existing inventory"));
  assert.ok(
    transfer.semantic.qualificationRequirements.some(
      (requirement) => requirement.evidenceKey === "inventory.source.available_quantity",
    ),
  );
});

test("authorization resolution separates declared scopes, merchant scopes, executor and risk", () => {
  const discount = getShopifyCapabilityManifest("discountCodeBasicCreate");
  const discountAvailability = resolveShopifyCapabilityAvailability(discount, {
    apiVersion: "2026-07",
    declaredScopes: parseScopeList("read_products,write_products"),
    grantedScopes: parseScopeList("read_products,write_products"),
    executorRefs: [],
  });
  assert.equal(discountAvailability.executionStatus, SHOPIFY_CAPABILITY_AVAILABILITY.highRiskBlocked);

  const transfer = getShopifyCapabilityManifest("inventoryTransferCreate");
  const needsGrant = resolveShopifyCapabilityAvailability(transfer, {
    apiVersion: "2026-07",
    declaredScopes: ["write_inventory_transfers"],
    grantedScopes: [],
    executorRefs: ["inventory-transfer-adapter"],
  });
  assert.equal(needsGrant.executionStatus, SHOPIFY_CAPABILITY_AVAILABILITY.needsAuthorization);
  assert.deepEqual(needsGrant.missingGrantedScopes, ["write_inventory_transfers"]);

  const noExecutor = resolveShopifyCapabilityAvailability(transfer, {
    apiVersion: "2026-07",
    declaredScopes: ["write_inventory_transfers"],
    grantedScopes: ["write_inventory_transfers"],
    executorRefs: [],
  });
  assert.equal(noExecutor.executionStatus, SHOPIFY_CAPABILITY_AVAILABILITY.needsExecutor);
});

test("semantic search retrieves relevant writes without exposing the full schema", () => {
  const shortage = searchShopifyCapabilities("stock shortage at one location but stock elsewhere", {
    writeOnly: true,
    limit: 3,
  });
  assert.equal(shortage[0].operation, "inventoryTransferCreate");
  assert.ok(shortage[0].qualificationRequirements.some((requirement) => requirement.id === "source_inventory_exists"));

  const presentation = searchShopifyCapabilities("poor product presentation and messy navigation", {
    writeOnly: true,
    limit: 5,
  }).map((row) => row.operation);
  assert.ok(presentation.includes("productUpdate"));
  assert.ok(presentation.includes("collectionCreate"));
});

test("inventory-transfer applicability follows manifest requirements, not a restock if statement", () => {
  const transfer = getShopifyCapabilityManifest("shopify.inventory_transfer.create");
  const plan = buildShopifyCapabilityQualificationPlan(transfer);
  assert.equal(plan.source, "semantic_manifest");
  assert.ok(plan.evidenceRequirements.some((requirement) => requirement.evidenceKey === "inventory.source.available_quantity"));

  const noStockAnywhere = evaluateShopifyCapabilityQualification(plan, {
    "inventory.item.tracked": true,
    "inventory.destination.need_quantity": 12,
    "inventory.source.available_quantity": 0,
    "inventory.locations.different": true,
    "inventory.transfer.identities": {
      sourceLocationId: "gid://shopify/Location/1",
      destinationLocationId: "gid://shopify/Location/2",
      inventoryItemId: "gid://shopify/InventoryItem/3",
      quantity: 12,
    },
  });
  assert.equal(noStockAnywhere.status, "rejected");
  assert.equal(
    noStockAnywhere.checks.find((check) => check.id === "source_inventory_exists").status,
    "failed",
  );

  const stockElsewhere = evaluateShopifyCapabilityQualification(plan, {
    "inventory.item.tracked": true,
    "inventory.destination.need_quantity": 12,
    "inventory.source.available_quantity": 20,
    "inventory.locations.different": true,
    "inventory.transfer.identities": {
      sourceLocationId: "gid://shopify/Location/1",
      destinationLocationId: "gid://shopify/Location/2",
      inventoryItemId: "gid://shopify/InventoryItem/3",
      quantity: 12,
    },
  });
  assert.equal(stockElsewhere.status, "qualified");
});

test("three previously unmodelled operations produce generic qualification plans", () => {
  for (const operation of ["discountCodeBasicCreate", "collectionCreate", "metafieldsSet"]) {
    const manifest = getShopifyCapabilityManifest(operation);
    assert.equal(manifest.admission.jefeExecutor, null);
    const plan = buildShopifyCapabilityQualificationPlan(manifest);
    assert.ok(plan.evidenceRequirements.length >= 3, `${operation} needs generic evidence`);
    assert.equal(plan.providerRef, manifest.providerRef);
  }
});

test("catalog diff detects added, removed and changed operation contracts", () => {
  const catalog = loadShopifyCapabilityCatalog();
  const next = structuredClone(catalog);
  next.operations = next.operations.slice(1);
  next.operations.push({
    ...structuredClone(catalog.operations[0]),
    id: "shopify.admin_graphql.2026-07.mutation.exampleAdded",
    operation: "exampleAdded",
  });
  next.operations[0].requiredScopes = ["write_products", "write_inventory"];

  const diff = diffShopifyCapabilityCatalogs(catalog, next);
  assert.ok(diff.added.includes("shopify.admin_graphql.2026-07.mutation.exampleAdded"));
  assert.ok(diff.removed.includes(catalog.operations[0].id));
  assert.ok(diff.changed.some((change) => change.changes.includes("requiredScopes")));
});

test("introspection parser extracts operation names, deprecation and required inputs", () => {
  const nonNullString = { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } };
  assert.equal(renderGraphqlType(nonNullString), "String!");
  const rows = extractOperationsFromIntrospectionJson({
    __schema: {
      queryType: { name: "QueryRoot" },
      mutationType: { name: "Mutation" },
      types: [
        {
          name: "Mutation",
          fields: [
            {
              name: "productUpdate",
              description: "Updates a product.",
              isDeprecated: false,
              args: [{ name: "product", type: { kind: "NON_NULL", ofType: { kind: "INPUT_OBJECT", name: "ProductUpdateInput" } } }],
              type: { kind: "OBJECT", name: "ProductUpdatePayload" },
            },
          ],
        },
        { name: "QueryRoot", fields: [] },
      ],
    },
  });
  assert.deepEqual(rows[0], {
    operation: "productUpdate",
    operationKind: "MUTATION",
    description: "Updates a product.",
    deprecated: false,
    deprecationReason: null,
    arguments: [{ name: "product", type: "ProductUpdateInput!", required: true }],
    outputType: "ProductUpdatePayload",
  });
});

test("legacy Shopify action truth links to discovered manifests", () => {
  const transfer = getShopifyActionCapability("shopify.inventory_transfer.create");
  assert.equal(transfer.discoveredCapability.operation, "inventoryTransferCreate");
  assert.ok(
    transfer.discoveredCapability.qualificationRequirements.some(
      (requirement) => requirement.evidenceKey === "inventory.source.available_quantity",
    ),
  );
  assert.ok(listShopifyActionCapabilities().some((row) => row.discoveredCapability?.operation === "inventoryTransferCreate"));
});

test("new recommendation discovery does not branch on legacy business refs", () => {
  const source = readFileSync(
    new URL("../app/lib/merchant-plan/candidates.server.js", import.meta.url),
    "utf8",
  );
  for (const oldRef of [
    'if (ref === "execute:listing_copy:missing_product_type")',
    'if (ref === "execute:price_markdown:dead_stock")',
    'if (ref === "execute:tidy_up:stale_listing")',
    'if (ref === "execute:shopify_inventory_transfer:restock")',
    "opportunity_listing_copy_missing_product_type",
    "opportunity_price_markdown_dead_stock",
    "opportunity_tidy_up_stale_listing",
    "opportunity_inventory_transfer_low_cover_restock",
  ]) {
    assert.equal(source.includes(oldRef), false, `${oldRef} must stay out of candidate discovery`);
  }
});

test("human report includes final semantic prompt and capability table", () => {
  const report = renderShopifyCapabilityReport(loadShopifyCapabilityCatalog());
  assert.ok(report.includes("| `inventoryTransferCreate` |"));
  assert.ok(report.includes("Machine-readable source"));
  assert.ok(FINAL_SHOPIFY_CAPABILITY_SEMANTIC_PROMPT.includes("Do not map this operation to one hardcoded Jefe feature"));
});
