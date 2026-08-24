import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyShopifyOperationSafety,
  CLASSIFICATION_SOURCE,
  EXECUTION_STATUS,
  REVIEWED_FAMILY_POLICIES,
  PROHIBITED_OPERATIONS,
} from "../app/lib/shopify/api/mutation-safety.server.js";
import { loadShopifyApiCatalog, validateShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";

// Guards the exact regression this audit found and fixed: an earlier classifier promoted any
// mutation matching /update|create$|add|set|activate$/i to EXECUTABLE_WITH_CONFIRMATION purely
// from its name, with no human review — 47 of 56 attemptable mutations (84%) reached that
// status this way, including giftCardCreate and marketCreate. Task Part 1.3's invariant:
// "operation-name similarity alone must not give an unknown Shopify mutation production write
// authority."

test("a synthetic, previously-unseen mutation cannot become executable through naming alone", () => {
  const benignLookingNames = [
    "widgetCreate", "widgetUpdate", "widgetSet", "widgetActivate", "widgetAdd",
    "giftCardCreate", "marketCreate", "locationDeactivate", "backupRegionUpdate",
  ];
  for (const operation of benignLookingNames) {
    const { execution } = classifyShopifyOperationSafety({
      operation,
      operationKind: "MUTATION",
      domain: "other_unknown",
      scopeConfidence: "high", // even with a confident scope, name alone must not be enough
    });
    assert.equal(
      execution.status,
      EXECUTION_STATUS.unsupportedSemantics,
      `${operation} must not be executable from name pattern alone (got ${execution.status})`,
    );
  }
});

test("STRUCTURAL_NAME_INFERENCE can never appear as the classificationSource of an executable result", () => {
  const catalog = loadShopifyApiCatalog();
  for (const op of catalog.operations) {
    if (op.execution.status === "EXECUTABLE" || op.execution.status === "EXECUTABLE_WITH_CONFIRMATION") {
      assert.notEqual(
        op.execution.classificationSource,
        CLASSIFICATION_SOURCE.structuralNameInference,
        `${op.operation} is ${op.execution.status} but sourced from name inference alone`,
      );
      assert.ok(
        [
          CLASSIFICATION_SOURCE.explicitKnownGood,
          CLASSIFICATION_SOURCE.explicitOperationOverride,
          CLASSIFICATION_SOURCE.reviewedFamilyPolicy,
        ].includes(op.execution.classificationSource),
        `${op.operation}'s classificationSource must be one of the three human-reviewed sources`,
      );
    }
  }
});

test("the catalog validator itself rejects a STRUCTURAL_NAME_INFERENCE-sourced executable operation", () => {
  const catalog = loadShopifyApiCatalog();
  const tampered = {
    ...catalog,
    operations: catalog.operations.map((op, index) =>
      index === 0
        ? {
            ...op,
            execution: { status: "EXECUTABLE_WITH_CONFIRMATION", classificationSource: "STRUCTURAL_NAME_INFERENCE", reason: "tampered" },
          }
        : op,
    ),
  };
  const validation = validateShopifyApiCatalog(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("STRUCTURAL_NAME_INFERENCE")));
});

test("a reviewed family policy can make multiple operations executable without a bespoke adapter per operation", () => {
  assert.ok(REVIEWED_FAMILY_POLICIES.length >= 1, "at least one reviewed family policy should exist");
  for (const policy of REVIEWED_FAMILY_POLICIES) {
    assert.ok(policy.justification && policy.justification.length > 20, `${policy.id} must carry a written justification`);
  }
  // collections-metadata-v1 covers three real operations from one reviewed decision.
  const { execution: update } = classifyShopifyOperationSafety({
    operation: "collectionUpdate",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "high",
  });
  const { execution: reorder } = classifyShopifyOperationSafety({
    operation: "collectionReorderProducts",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "high",
  });
  assert.equal(update.status, EXECUTION_STATUS.executableWithConfirmation);
  assert.equal(update.classificationSource, CLASSIFICATION_SOURCE.reviewedFamilyPolicy);
  assert.equal(reorder.status, EXECUTION_STATUS.executableWithConfirmation);
  // The same family's delete-shaped sibling is deliberately excluded by the match pattern.
  const { execution: del } = classifyShopifyOperationSafety({
    operation: "collectionDelete",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "high",
  });
  assert.equal(del.status, EXECUTION_STATUS.unsupportedSemantics);
});

test("scopeConfidence other than \"high\" can never grant EXECUTABLE or EXECUTABLE_WITH_CONFIRMATION, even for an otherwise-trusted operation", () => {
  for (const confidence of ["inferred", "unknown"]) {
    const { execution } = classifyShopifyOperationSafety({
      operation: "collectionUpdate",
      operationKind: "MUTATION",
      domain: "collections",
      scopeConfidence: confidence,
    });
    assert.equal(
      execution.status,
      EXECUTION_STATUS.unsupportedSemantics,
      `collectionUpdate with scopeConfidence=${confidence} must not be executable (task Part 2.3)`,
    );
    assert.match(execution.reason, /never let unknown mean safe/i);
  }
});

test("reads are broadly available by a reviewed policy, not name inference, and sensitive reads are carved out", () => {
  const { execution: normalRead } = classifyShopifyOperationSafety({
    operation: "products",
    operationKind: "QUERY",
    domain: "products",
    scopeConfidence: "high",
  });
  assert.equal(normalRead.status, EXECUTION_STATUS.executable);
  assert.equal(normalRead.classificationSource, CLASSIFICATION_SOURCE.reviewedFamilyPolicy);

  const { execution: sensitiveRead } = classifyShopifyOperationSafety({
    operation: "shopifyPaymentsDisputeEvidences",
    operationKind: "QUERY",
    domain: "financial_payment",
    scopeConfidence: "high",
  });
  assert.equal(sensitiveRead.status, EXECUTION_STATUS.executableWithConfirmation);
});

test("PROHIBITED_OPERATIONS is a fixed, small, named list — not a pattern", () => {
  assert.ok(PROHIBITED_OPERATIONS.size >= 1 && PROHIBITED_OPERATIONS.size < 30, "the prohibited list should stay small and auditable");
  for (const [name, reason] of PROHIBITED_OPERATIONS) {
    assert.equal(typeof name, "string");
    assert.ok(reason.length > 10, `${name} must carry a written reason`);
  }
});
