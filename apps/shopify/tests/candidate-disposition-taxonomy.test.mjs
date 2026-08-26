import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_DISPOSITION_DETAIL,
  classifyDispositionDetail,
  resolveCandidateFamily,
} from "../app/lib/shopify/agentic-runtime/candidate-disposition-taxonomy.server.js";

function family(overrides = {}) {
  return {
    id: "customers",
    capabilityState: "available",
    executionSummary: { executable: 0, executableWithConfirmation: 1, unsupportedSemantics: 14, prohibited: 0 },
    writeOperations: [{ operation: "customerUpdate", executionStatus: "EXECUTABLE_WITH_CONFIRMATION", scopeSatisfied: true }],
    ...overrides,
  };
}

test("ALREADY_SATISFIED / ALREADY_COVERED map 1:1", () => {
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "ALREADY_SATISFIED" }),
    CANDIDATE_DISPOSITION_DETAIL.alreadySatisfied,
  );
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "ALREADY_COVERED" }),
    CANDIDATE_DISPOSITION_DETAIL.duplicateExistingAction,
  );
});

test("REJECTED (Shopify state disproved the diagnosis) maps to WEAK_DIAGNOSIS", () => {
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "REJECTED", reason: "Shopify read disproved the premise." }),
    CANDIDATE_DISPOSITION_DETAIL.weakDiagnosis,
  );
});

test("BLOCKED_BY_EVIDENCE splits INPUT_MISSING vs INSUFFICIENT_EVIDENCE by reason text", () => {
  assert.equal(
    classifyDispositionDetail({
      candidateStatus: "BLOCKED_BY_EVIDENCE",
      reason: "The merchant's actual cost per item cannot be read from Shopify.",
    }),
    CANDIDATE_DISPOSITION_DETAIL.inputMissing,
  );
  assert.equal(
    classifyDispositionDetail({
      candidateStatus: "BLOCKED_BY_EVIDENCE",
      reason: "Shopify state does not confirm which variants are out of stock.",
    }),
    CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence,
  );
});

test("NON_EXECUTABLE with no resolvable family is CAPABILITY_RETRIEVAL_FAILURE, not an assumed API limitation", () => {
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "NON_EXECUTABLE", reason: "No matching operation found.", family: null }),
    CANDIDATE_DISPOSITION_DETAIL.capabilityRetrievalFailure,
  );
});

// Since the 2026-08-25 execution-safety architecture change (mutation-safety.server.js), every
// mutation in a family with at least one write op resolves to EXECUTABLE or EXECUTABLE_WITH_
// CONFIRMATION — a family can no longer be "scope_missing" because every op in it is genuinely
// unsupported; scope_missing now always means "the merchant's real Shopify authorization
// doesn't (yet, or confidently) cover this," i.e. SCOPE_NOT_GRANTED, regardless of the
// executionSummary composition. See mutation-safety-classifier-audit.test.mjs's real-catalog
// invariant test for the guarantee this relies on.
test("NON_EXECUTABLE with a scope_missing family is always SCOPE_NOT_GRANTED, regardless of executionSummary composition", () => {
  const f = family({
    capabilityState: "scope_missing",
    executionSummary: { executable: 0, executableWithConfirmation: 12, unsupportedSemantics: 0, prohibited: 0 },
  });
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "NON_EXECUTABLE", reason: "write_discounts not granted", family: f }),
    CANDIDATE_DISPOSITION_DETAIL.scopeNotGranted,
  );
});

test("NON_EXECUTABLE with an available family (some op attemptable) but no matching intervention is EXECUTION_SEMANTICS_MISSING", () => {
  const f = family({ capabilityState: "available" });
  assert.equal(
    classifyDispositionDetail({
      candidateStatus: "NON_EXECUTABLE",
      reason: "customerUpdate does not implement store-wide identity capture.",
      family: f,
    }),
    CANDIDATE_DISPOSITION_DETAIL.executionSemanticsMissing,
  );
});

test("resultStatus overrides map VALIDATION_FAILED and INVESTIGATION_INCOMPLETE distinctly", () => {
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "NON_EXECUTABLE", resultStatus: "VALIDATION_FAILED" }),
    CANDIDATE_DISPOSITION_DETAIL.validationFailure,
  );
  assert.equal(
    classifyDispositionDetail({ candidateStatus: "NON_EXECUTABLE", resultStatus: "INVESTIGATION_INCOMPLETE" }),
    CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence,
  );
});

// Regression for a live run (25008faa-3138-4479-8ee9-133d07ea1b06, candidate
// reactivate-high-value-customers): a candidate that genuinely attempted a terminal decision, was
// correctly rejected for never achieving a satisfying read, and exhausted its budget without
// curing it (resultStatus: "INVESTIGATION_FAILED") was defaulting to NON_EXECUTABLE ->
// CAPABILITY_RETRIEVAL_FAILURE — "no Shopify write operation exists" — which is false; the real
// gap is "never got a read". Must be reported as an evidence gap, not a capability gap.
test("INVESTIGATION_FAILED is reported as INSUFFICIENT_EVIDENCE, never CAPABILITY_RETRIEVAL_FAILURE, even with no resolvable family", () => {
  const detail = classifyDispositionDetail({
    candidateStatus: "NON_EXECUTABLE", // classifyCandidateOutcome's default fallback for this status
    resultStatus: "INVESTIGATION_FAILED",
    reason: "Recommendation decisions require at least one successful Shopify read (shopify_query).",
    family: null,
  });
  assert.equal(detail, CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence);
  assert.notEqual(detail, CANDIDATE_DISPOSITION_DETAIL.capabilityRetrievalFailure);
});

test("resolveCandidateFamily prefers relevantFamilyId, falls back to a resolved opportunityCoverage entry", () => {
  const surface = { families: [family({ id: "customers" }), family({ id: "discounts_promotions" })] };
  assert.equal(resolveCandidateFamily({ relevantFamilyId: "discounts_promotions" }, surface).id, "discounts_promotions");
  assert.equal(
    resolveCandidateFamily(
      {
        relevantFamilyId: null,
        investigation: { diagnostics: { opportunityCoverage: [{ familyId: "customers", status: "REJECTED" }] } },
      },
      surface,
    ).id,
    "customers",
  );
  assert.equal(resolveCandidateFamily({ relevantFamilyId: "not-a-real-domain" }, surface), null);
  assert.equal(resolveCandidateFamily({}, null), null);
});
