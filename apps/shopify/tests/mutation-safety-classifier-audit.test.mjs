import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyShopifyOperationSafety,
  CLASSIFICATION_SOURCE,
  EXECUTION_STATUS,
  INTERACTION,
  REVIEWED_FAMILY_POLICIES,
} from "../app/lib/shopify/api/mutation-safety.server.js";
import { loadShopifyApiCatalog, validateShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";

// Guards the exact regression the 2026-08-24 audit found and fixed: an earlier classifier
// promoted any mutation matching /update|create$|add|set|activate$/i to EXECUTABLE_WITH_
// CONFIRMATION purely from its name, with no human review and no extra confirmation — 47 of 56
// attemptable mutations (84%) reached that status this way, including giftCardCreate and
// marketCreate, all at ordinary Action-approval friction. The 2026-08-25 execution-safety
// architecture change (see CLAUDE.md) removed "UNSUPPORTED_SEMANTICS forever" as the fallback for
// an unreviewed mutation, but it did NOT bring back that anti-pattern: name pattern alone must
// still never grant *frictionless* production write authority. What changed is where the
// invariant is enforced — not "can this operation execute at all" but "can it execute without
// extra confirmation."

const FRICTIONLESS_INTERACTIONS = new Set([INTERACTION.autonomousEligible, INTERACTION.approvalRequired]);

test("a synthetic, previously-unseen mutation cannot become frictionless through naming alone, but does get a real execution path", () => {
  const benignLookingNames = [
    "widgetCreate", "widgetUpdate", "widgetSet", "widgetActivate", "widgetAdd",
    "giftCardCreate", "marketCreate", "locationDeactivate", "backupRegionUpdate",
  ];
  for (const operation of benignLookingNames) {
    const { execution, safety } = classifyShopifyOperationSafety({
      operation,
      operationKind: "MUTATION",
      domain: "other_unknown",
      scopeConfidence: "high", // even with a confident scope, name alone must not be enough
    });
    // Never a dead end (task invariant): a schema-valid mutation always gets an execution path.
    assert.equal(
      execution.status,
      EXECUTION_STATUS.executableWithConfirmation,
      `${operation} must have a generic execution path (got ${execution.status})`,
    );
    // But never frictionless from name alone.
    assert.ok(
      !FRICTIONLESS_INTERACTIONS.has(safety.interaction),
      `${operation} must not be frictionless from name pattern alone (got ${safety.interaction})`,
    );
  }
});

test("STRUCTURAL_NAME_INFERENCE can be executable, but only ever at the explicit confirmation tier — never frictionless", () => {
  const catalog = loadShopifyApiCatalog();
  let sawStructuralExecutable = false;
  for (const op of catalog.operations) {
    if (op.execution.classificationSource !== CLASSIFICATION_SOURCE.structuralNameInference) continue;
    if (op.execution.status !== "EXECUTABLE" && op.execution.status !== "EXECUTABLE_WITH_CONFIRMATION") continue;
    sawStructuralExecutable = true;
    assert.ok(
      !FRICTIONLESS_INTERACTIONS.has(op.safety.interaction),
      `${op.operation} is executable via STRUCTURAL_NAME_INFERENCE but has frictionless interaction ${op.safety.interaction}`,
    );
  }
  assert.ok(sawStructuralExecutable, "expected at least one structurally-classified executable mutation in the real catalog");
});

test("the catalog validator rejects a STRUCTURAL_NAME_INFERENCE-sourced operation given a frictionless interaction", () => {
  const catalog = loadShopifyApiCatalog();
  const tampered = {
    ...catalog,
    operations: catalog.operations.map((op, index) =>
      index === 0
        ? {
            ...op,
            safety: { riskTier: "NORMAL", reversibility: "REVERSIBLE", interaction: "APPROVAL_REQUIRED" },
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
  // The same family's delete-shaped sibling is deliberately excluded by the match pattern and
  // falls through to the structural destructive-name path — still executable, just at a
  // stronger, explicit confirmation tier instead of ordinary Action approval.
  const { execution: del, safety: delSafety } = classifyShopifyOperationSafety({
    operation: "collectionDelete",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "high",
  });
  assert.equal(del.status, EXECUTION_STATUS.executableWithConfirmation);
  assert.equal(del.classificationSource, CLASSIFICATION_SOURCE.structuralNameInference);
  assert.equal(delSafety.interaction, INTERACTION.explicitHighRiskConfirmation);
});

test("scopeConfidence below \"high\" can never grant a frictionless interaction, even for an otherwise-trusted operation", () => {
  const highConfidence = classifyShopifyOperationSafety({
    operation: "collectionUpdate",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "high",
  });
  assert.equal(highConfidence.safety.interaction, INTERACTION.approvalRequired);

  const inferred = classifyShopifyOperationSafety({
    operation: "collectionUpdate",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "inferred",
  });
  assert.equal(inferred.execution.status, EXECUTION_STATUS.executableWithConfirmation);
  assert.notEqual(inferred.safety.interaction, INTERACTION.approvalRequired);
  assert.match(inferred.execution.reason, /not confidently known/i);

  const unknown = classifyShopifyOperationSafety({
    operation: "collectionUpdate",
    operationKind: "MUTATION",
    domain: "collections",
    scopeConfidence: "unknown",
  });
  assert.equal(unknown.execution.status, EXECUTION_STATUS.executableWithConfirmation);
  assert.equal(unknown.safety.interaction, INTERACTION.explicitHighRiskConfirmation);
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

// 2026-08-25, second authorization: the founder asked for the named "system-critical operations"
// list removed entirely — no bespoke allow/deny-shaped list for individually dangerous
// operations, generic structural rules only. These formerly-named operations (self-
// deauthorization, GDPR erasure, payment reversal, arbitrary bulk mutation) must still land at
// explicit confirmation — but via the SAME domain/name-shape structural rules every other
// operation uses, sourced STRUCTURAL_NAME_INFERENCE like anything else, never a bespoke source.
test("formerly-named high-risk operations (self-deauth, GDPR erasure, payment reversal) are classified purely structurally now — no bespoke list, still explicit confirmation", () => {
  const formerlyNamedOperations = [
    { operation: "appUninstall", domain: "app_platform" },
    { operation: "appRevokeAccessScopes", domain: "app_platform" },
    { operation: "customerCancelDataErasure", domain: "privacy_compliance" },
    { operation: "customerRequestDataErasure", domain: "privacy_compliance" },
    { operation: "transactionVoid", domain: "financial_payment" },
    { operation: "disputeEvidenceUpdate", domain: "financial_payment" },
  ];
  for (const { operation, domain } of formerlyNamedOperations) {
    const { execution, safety } = classifyShopifyOperationSafety({
      operation,
      operationKind: "MUTATION",
      domain,
      scopeConfidence: "high",
    });
    assert.equal(execution.status, EXECUTION_STATUS.executableWithConfirmation, `${operation} must be executable`);
    assert.equal(
      execution.classificationSource,
      CLASSIFICATION_SOURCE.structuralNameInference,
      `${operation} must be classified structurally, not via a bespoke named list`,
    );
    assert.equal(safety.interaction, INTERACTION.explicitHighRiskConfirmation, `${operation} must require explicit confirmation`);
  }
});

test("there is no bespoke high-risk operation list left in the module's public exports", async () => {
  const mutationSafetyModule = await import("../app/lib/shopify/api/mutation-safety.server.js");
  assert.equal(Object.hasOwn(mutationSafetyModule, "SYSTEM_CRITICAL_OPERATIONS"), false);
  assert.equal(Object.hasOwn(mutationSafetyModule, "PROHIBITED_OPERATIONS"), false);
  assert.equal(mutationSafetyModule.INTERACTION.systemCriticalConfirmation, undefined);
});

test("no schema-valid mutation the real catalog carries resolves to UNSUPPORTED_SEMANTICS or PROHIBITED", () => {
  const catalog = loadShopifyApiCatalog();
  const mutations = catalog.operations.filter((op) => op.operationKind === "MUTATION");
  const notExecutable = mutations.filter(
    (op) => op.execution.status !== "EXECUTABLE" && op.execution.status !== "EXECUTABLE_WITH_CONFIRMATION",
  );
  assert.deepEqual(
    notExecutable.map((op) => op.operation),
    [],
    "every mutation in the generated catalog must have a generic execution path",
  );
});
