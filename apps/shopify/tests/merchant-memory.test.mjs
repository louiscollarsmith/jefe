import assert from "node:assert/strict";
import test from "node:test";
import {
  assertClaimStatusTransition,
  claimHasTruthSupport,
  normalizeClaimStatus,
} from "../app/services/merchant-memory.server.js";

test("merchant memory claim statuses normalize supported values", () => {
  assert.equal(normalizeClaimStatus("MODEL_INFERENCE"), "model_inference");
  assert.throws(
    () => normalizeClaimStatus("fact_because_ai_said_so"),
    /Unsupported merchant memory claim status/,
  );
});

test("model inference cannot become fact without evidence or merchant input", () => {
  assert.throws(
    () =>
      assertClaimStatusTransition({
        from: "model_inference",
        to: "observed_fact",
        reason: "model_revision",
      }),
    /deterministic evidence/,
  );

  assert.doesNotThrow(() =>
    assertClaimStatusTransition({
      from: "model_inference",
      to: "observed_fact",
      reason: "deterministic_evidence",
    }),
  );

  assert.doesNotThrow(() =>
    assertClaimStatusTransition({
      from: "model_inference",
      to: "merchant_confirmed_fact",
      reason: "merchant_confirmation",
    }),
  );
});

test("truth support requires evidence or merchant correction", () => {
  assert.equal(
    claimHasTruthSupport({ status: "observed_fact", evidenceCount: 1 }),
    true,
  );
  assert.equal(
    claimHasTruthSupport({ status: "observed_fact", evidenceCount: 0 }),
    false,
  );
  assert.equal(
    claimHasTruthSupport({
      status: "merchant_confirmed_fact",
      correctionType: "correction",
    }),
    true,
  );
  assert.equal(claimHasTruthSupport({ status: "model_inference" }), false);
});
