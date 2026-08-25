import assert from "node:assert/strict";
import test from "node:test";

import { getShopifyApiOperationStub } from "../app/lib/shopify/api/catalog.server.js";
import { computeShopifyBlastRadius, evaluateBlastRadiusCap } from "../app/lib/shopify/api/blast-radius.server.js";
import { buildGenericShopifyOperationPreview } from "../app/lib/shopify/api/preview.server.js";

// Task §11: generic, dimensional blast-radius calculation from schema + variables, no
// per-operation code — built and tested against real catalog operations, not fixtures.

test("computeShopifyBlastRadius measures a money-typed nested field on refundCreate", () => {
  const stub = getShopifyApiOperationStub("refundCreate");
  const dims = computeShopifyBlastRadius({
    stub,
    variables: {
      input: {
        orderId: "gid://shopify/Order/1",
        transactions: [
          { orderId: "gid://shopify/Order/1", amount: "42.50", kind: "REFUND", gateway: "manual" },
        ],
      },
    },
  });
  assert.ok(dims.moneyAffected >= 42.5, `expected moneyAffected to include the transaction amount, got ${dims.moneyAffected}`);
  assert.ok(dims.orderCount >= 1);
  assert.equal(dims.destructiveCount, 0); // refundCreate is not delete/erase/revoke-shaped
});

test("computeShopifyBlastRadius counts resources and quantity deltas on productVariantsBulkUpdate", () => {
  const stub = getShopifyApiOperationStub("productVariantsBulkUpdate");
  const dims = computeShopifyBlastRadius({
    stub,
    variables: {
      productId: "gid://shopify/Product/1",
      variants: [
        { id: "gid://shopify/ProductVariant/1", price: "19.99" },
        { id: "gid://shopify/ProductVariant/2", price: "24.99" },
      ],
    },
  });
  assert.equal(dims.resourcesAffected, 3); // product + 2 variants
  assert.ok(dims.moneyAffected > 40); // 19.99 + 24.99
});

test("computeShopifyBlastRadius flags destructiveCount for a delete-shaped operation and counts the customer", () => {
  const stub = getShopifyApiOperationStub("customerDelete");
  const dims = computeShopifyBlastRadius({
    stub,
    variables: { input: { id: "gid://shopify/Customer/9001" } },
  });
  assert.equal(dims.destructiveCount, 1);
  assert.equal(dims.customerCount, 1);
  assert.equal(dims.resourcesAffected, 1);
});

test("evaluateBlastRadiusCap denies when a dimension exceeds the risk tier's cap, and reports which one", () => {
  const dims = { resourcesAffected: 3, moneyAffected: 999999, quantityDelta: 0, percentageChange: 0, customerCount: 0, orderCount: 0, publicSurfaceImpact: false, destructiveCount: 0 };
  const result = evaluateBlastRadiusCap(dims, "SENSITIVE");
  assert.equal(result.ok, false);
  assert.ok(result.exceeded.some((e) => e.dimension === "moneyAffected"));
});

test("evaluateBlastRadiusCap allows a small, bounded operation through", () => {
  const dims = { resourcesAffected: 1, moneyAffected: 20, quantityDelta: 5, percentageChange: 0, customerCount: 0, orderCount: 0, publicSurfaceImpact: false, destructiveCount: 0 };
  const result = evaluateBlastRadiusCap(dims, "NORMAL");
  assert.equal(result.ok, true);
});

test("evaluateBlastRadiusCap is stricter for PLATFORM_CRITICAL than NORMAL, for the same blast radius", () => {
  const dims = { resourcesAffected: 50, moneyAffected: 1000, quantityDelta: 0, percentageChange: 0, customerCount: 0, orderCount: 0, publicSurfaceImpact: false, destructiveCount: 0 };
  assert.equal(evaluateBlastRadiusCap(dims, "NORMAL").ok, true);
  assert.equal(evaluateBlastRadiusCap(dims, "PLATFORM_CRITICAL").ok, false);
});

// Task §7: generic, deterministic preview generation from operation + variables (+ optional
// current state) — never depends on an LLM paraphrasing its own write.

test("buildGenericShopifyOperationPreview describes a create with its input fields, not just an opaque call", () => {
  const stub = getShopifyApiOperationStub("collectionCreate");
  const preview = buildGenericShopifyOperationPreview({
    stub,
    variables: { input: { title: "Summer Sale", descriptionHtml: "<p>Hot deals</p>" } },
  });
  assert.equal(preview.kind, "create");
  assert.ok(preview.fields.some((f) => f.field.endsWith("title") && f.newValue === "Summer Sale"));
});

test("buildGenericShopifyOperationPreview marks a delete-shaped operation with a consequence and recoverability", () => {
  const stub = getShopifyApiOperationStub("customerDelete");
  const preview = buildGenericShopifyOperationPreview({
    stub,
    variables: { input: { id: "gid://shopify/Customer/9001" } },
  });
  assert.equal(preview.kind, "delete");
  assert.equal(preview.resource, "gid://shopify/Customer/9001");
  assert.match(preview.consequence, /removed/);
  assert.match(preview.recoverability, /Irreversible/);
});

test("buildGenericShopifyOperationPreview surfaces current → new when currentState is supplied, and 'unknown — not read' when it isn't", () => {
  const stub = getShopifyApiOperationStub("productUpdate");
  const variables = { product: { id: "gid://shopify/Product/1", title: "New Title" } };
  const withoutState = buildGenericShopifyOperationPreview({ stub, variables });
  const titleFieldNoState = withoutState.fields.find((f) => f.field.endsWith("title"));
  assert.equal(titleFieldNoState.currentValue, "unknown — not read");

  const withState = buildGenericShopifyOperationPreview({ stub, variables, currentState: { title: "Old Title" } });
  const titleFieldWithState = withState.fields.find((f) => f.field.endsWith("title"));
  assert.equal(titleFieldWithState.currentValue, "Old Title");
  assert.equal(titleFieldWithState.newValue, "New Title");
});

test("buildGenericShopifyOperationPreview extracts money fields for a money-moving operation", () => {
  const stub = getShopifyApiOperationStub("refundCreate");
  const preview = buildGenericShopifyOperationPreview({
    stub,
    variables: {
      input: {
        orderId: "gid://shopify/Order/1",
        transactions: [{ orderId: "gid://shopify/Order/1", amount: "42.50", kind: "REFUND", gateway: "manual" }],
      },
    },
  });
  assert.ok(preview.money.some((m) => m.amount === "42.50"), `expected a money entry, got ${JSON.stringify(preview.money)}`);
});

test("buildGenericShopifyOperationPreview is deterministic — same input, same output, no randomness or timestamps", () => {
  const stub = getShopifyApiOperationStub("collectionCreate");
  const variables = { input: { title: "Summer Sale" } };
  const a = buildGenericShopifyOperationPreview({ stub, variables });
  const b = buildGenericShopifyOperationPreview({ stub, variables });
  assert.deepEqual(a, b);
});
