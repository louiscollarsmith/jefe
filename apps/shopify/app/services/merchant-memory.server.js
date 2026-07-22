// @ts-check

export const MERCHANT_MEMORY_CLAIM_STATUSES = Object.freeze([
  "observed_fact",
  "merchant_confirmed_fact",
  "model_inference",
  "unresolved_question",
  "rejected",
  "superseded",
]);

export const MERCHANT_MEMORY_CORRECTION_TYPES = Object.freeze([
  "confirmation",
  "correction",
  "rejection",
  "answer",
]);

const FACT_STATUSES = new Set([
  "observed_fact",
  "merchant_confirmed_fact",
]);

/**
 * @param {unknown} value
 */
export function normalizeClaimStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!MERCHANT_MEMORY_CLAIM_STATUSES.includes(status)) {
    throw new Error(`Unsupported merchant memory claim status: ${String(value)}`);
  }
  return status;
}

/**
 * @param {{
 *   from: string;
 *   to: string;
 *   reason: "deterministic_evidence" | "merchant_confirmation" | "merchant_correction" | "model_revision";
 * }} input
 */
export function assertClaimStatusTransition(input) {
  const from = normalizeClaimStatus(input.from);
  const to = normalizeClaimStatus(input.to);

  if (from === to) return;

  if (from === "model_inference" && to === "observed_fact") {
    if (input.reason !== "deterministic_evidence") {
      throw new Error(
        "A model inference can only become an observed fact through deterministic evidence.",
      );
    }
    return;
  }

  if (from === "model_inference" && to === "merchant_confirmed_fact") {
    if (
      input.reason !== "merchant_confirmation" &&
      input.reason !== "merchant_correction"
    ) {
      throw new Error(
        "A model inference can only become merchant-confirmed through merchant input.",
      );
    }
    return;
  }

  if (to === "superseded" || to === "rejected") return;

  if (from === "unresolved_question" && FACT_STATUSES.has(to)) {
    if (
      input.reason !== "merchant_confirmation" &&
      input.reason !== "merchant_correction" &&
      input.reason !== "deterministic_evidence"
    ) {
      throw new Error(
        "An unresolved question needs evidence or merchant input before becoming a fact.",
      );
    }
    return;
  }

  if (FACT_STATUSES.has(from) && to === "model_inference") {
    throw new Error("A fact cannot be downgraded to a model inference.");
  }

  if (FACT_STATUSES.has(to) && input.reason === "model_revision") {
    throw new Error("Model revision alone cannot create a fact.");
  }
}

/**
 * @param {{ status: string; evidenceCount?: number; correctionType?: string | null }} input
 */
export function claimHasTruthSupport(input) {
  const status = normalizeClaimStatus(input.status);
  if (status === "observed_fact") return Number(input.evidenceCount ?? 0) > 0;
  if (status === "merchant_confirmed_fact") {
    return (
      input.correctionType === "confirmation" ||
      input.correctionType === "correction"
    );
  }
  return false;
}
