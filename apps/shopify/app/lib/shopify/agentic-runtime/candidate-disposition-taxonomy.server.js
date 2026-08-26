// @ts-check
//
// Deterministic, server-side refinement of a candidate's coarse pipeline outcome
// (CANDIDATE_STATUS / CANDIDATE_DISPOSITION — the LLM's own terminal call, unchanged) into a
// precise root-cause taxonomy for reporting and instrumentation. This module never talks to
// the LLM and never changes what the LLM is asked or allowed to return — it only reclassifies
// an already-terminal candidate using signals already available server-side (the opportunity
// surface's per-family execution-status rollup, the candidate's investigation diagnostics, and
// pattern-matching over the LLM's own free-text reason). Widening the live schema/prompt enum
// was deliberately avoided: it would touch every real Gemini call in production for a benefit
// (reporting granularity) that is entirely achievable downstream of the existing terminal call.
//
// Target taxonomy (task: "Required disposition taxonomy"):
//   WEAK_DIAGNOSIS, INSUFFICIENT_EVIDENCE, SHOPIFY_API_LIMITATION, CAPABILITY_RETRIEVAL_FAILURE,
//   INPUT_MISSING, SCOPE_NOT_GRANTED, SHOPIFY_APPROVAL_REQUIRED, EXECUTION_SEMANTICS_MISSING,
//   EXECUTION_PROTOCOL_GAP, SAFETY_PROHIBITED, DUPLICATE_EXISTING_ACTION, ALREADY_SATISFIED,
//   VALIDATION_FAILURE.

export const CANDIDATE_DISPOSITION_DETAIL = Object.freeze({
  weakDiagnosis: "WEAK_DIAGNOSIS",
  insufficientEvidence: "INSUFFICIENT_EVIDENCE",
  // docs/ops/recommendation-convergence-vs-evidence-fix/: the agent exhausted its turn budget
  // without ever attempting a terminal decision — a runtime/convergence failure. Distinct from
  // insufficientEvidence, which means Jefe actually reached and rejected the opportunity on the
  // evidence. Conflating the two silently converted "the model didn't converge" into "the business
  // lacks evidence" — a candidate should only be reported/treated as substantively rejected when
  // Jefe actually reached that judgement.
  convergenceFailure: "CONVERGENCE_FAILURE",
  shopifyApiLimitation: "SHOPIFY_API_LIMITATION",
  capabilityRetrievalFailure: "CAPABILITY_RETRIEVAL_FAILURE",
  inputMissing: "INPUT_MISSING",
  scopeNotGranted: "SCOPE_NOT_GRANTED",
  shopifyApprovalRequired: "SHOPIFY_APPROVAL_REQUIRED",
  executionSemanticsMissing: "EXECUTION_SEMANTICS_MISSING",
  executionProtocolGap: "EXECUTION_PROTOCOL_GAP",
  safetyProhibited: "SAFETY_PROHIBITED",
  duplicateExistingAction: "DUPLICATE_EXISTING_ACTION",
  alreadySatisfied: "ALREADY_SATISFIED",
  validationFailure: "VALIDATION_FAILURE",
});

// A candidate's own free-text `reason` is Luna's explanation, not a structured signal — these
// patterns only ever narrow within a bucket the deterministic signals (family execution
// summary, resolvable family, resultStatus) already placed the candidate in. They never
// override a deterministic signal, only choose between two deterministic-tied categories
// (e.g. INPUT_MISSING vs INSUFFICIENT_EVIDENCE, both currently the LLM's BLOCKED_BY_EVIDENCE).
const INPUT_MISSING_PATTERN =
  /merchant('|’)s? (actual|provided|specific)|cannot be read from shopify|requires? (the |a )?merchant|no recorded (cost|value|amount)|does not (know|have) the merchant|missing merchant input|cost per item|refund amount|international price|consent record/i;

const APPROVAL_REQUIRED_PATTERN = /requires? (explicit |merchant )?confirmation before|needs (merchant )?sign-?off|high-risk.*confirm/i;

const PROTOCOL_GAP_PATTERN = /multi-step|multiple steps|begin.*commit.*verify|cannot be represented as a single (mutation|write)/i;

/**
 * @param {any} candidate Candidate record from candidateQueue (has .relevantFamilyId,
 *   .investigation.diagnostics.opportunityCoverage, .status, .reason, .resultStatus)
 * @param {{ families: any[] } | null} opportunitySurface
 * @returns {any | null} the matching family, or null if none resolvable
 */
export function resolveCandidateFamily(candidate, opportunitySurface) {
  const families = Array.isArray(opportunitySurface?.families) ? opportunitySurface.families : [];
  if (!families.length) return null;
  if (candidate?.relevantFamilyId) {
    const direct = families.find((f) => f.id === candidate.relevantFamilyId);
    if (direct) return direct;
  }
  const coverage = candidate?.investigation?.diagnostics?.opportunityCoverage;
  if (Array.isArray(coverage)) {
    const resolvedEntry = coverage.find(
      (entry) => entry?.familyId && families.some((f) => f.id === entry.familyId) && entry.status && entry.status !== "UNASSESSED",
    );
    if (resolvedEntry) {
      const family = families.find((f) => f.id === resolvedEntry.familyId);
      if (family) return family;
    }
  }
  return null;
}

/**
 * Deterministically classify a terminal candidate into the fine-grained root-cause taxonomy.
 *
 * @param {{
 *   candidateStatus: string,
 *   resultStatus?: string | null,
 *   reason?: string | null,
 *   family?: any | null,
 * }} input
 * @returns {string}
 */
export function classifyDispositionDetail({ candidateStatus, resultStatus = null, reason = null, family = null }) {
  const text = String(reason ?? "");

  if (resultStatus === "VALIDATION_FAILED") return CANDIDATE_DISPOSITION_DETAIL.validationFailure;
  if (resultStatus === "INVESTIGATION_INCOMPLETE") return CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence;
  if (resultStatus === "ITERATION_LIMIT" || candidateStatus === "ITERATION_LIMIT") {
    return CANDIDATE_DISPOSITION_DETAIL.convergenceFailure;
  }
  // classifyCandidateOutcome has no case for INVESTIGATION_FAILED (a candidate that did attempt a
  // terminal decision and was correctly rejected for never achieving a satisfying read, then
  // exhausted its budget without curing it) — it silently defaults to NON_EXECUTABLE, and when no
  // capability family resolves (no read ever succeeded, so there's no coverage data to resolve one
  // from) that reports CAPABILITY_RETRIEVAL_FAILURE: "no Shopify write operation exists", which is
  // false — the real problem is "never got a read", i.e. an evidence gap, not a capability gap.
  if (resultStatus === "INVESTIGATION_FAILED") return CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence;

  switch (candidateStatus) {
    case "ALREADY_SATISFIED":
      return CANDIDATE_DISPOSITION_DETAIL.alreadySatisfied;
    case "ALREADY_COVERED":
      return CANDIDATE_DISPOSITION_DETAIL.duplicateExistingAction;
    case "REJECTED":
      return CANDIDATE_DISPOSITION_DETAIL.weakDiagnosis;
    case "BLOCKED_BY_EVIDENCE":
      return INPUT_MISSING_PATTERN.test(text)
        ? CANDIDATE_DISPOSITION_DETAIL.inputMissing
        : CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence;
    case "NON_EXECUTABLE": {
      if (PROTOCOL_GAP_PATTERN.test(text)) return CANDIDATE_DISPOSITION_DETAIL.executionProtocolGap;
      if (APPROVAL_REQUIRED_PATTERN.test(text)) return CANDIDATE_DISPOSITION_DETAIL.shopifyApprovalRequired;
      if (!family) {
        // The 810-op catalog covers 28 domains; a family failing to resolve at all is now far
        // more likely a retrieval miss than a genuine Shopify gap (task: "no false API
        // limitations" — default to the fixable, verifiable bucket, never assume the more
        // convenient one).
        return CANDIDATE_DISPOSITION_DETAIL.capabilityRetrievalFailure;
      }
      if (family.capabilityState === "scope_missing") {
        // Since the 2026-08-25 execution-safety architecture change (mutation-safety.server.js),
        // every mutation in a family with at least one write op resolves to EXECUTABLE or
        // EXECUTABLE_WITH_CONFIRMATION — "scope_missing" can now only mean the merchant's real
        // Shopify authorization doesn't (yet, or confidently) cover it, never that no attemptable
        // op exists. See mutation-safety-classifier-audit.test.mjs's real-catalog invariant test.
        return CANDIDATE_DISPOSITION_DETAIL.scopeNotGranted;
      }
      // capabilityState === "available": some op in the family is attemptable, but the
      // specific diagnosed intervention wasn't implementable by any of them.
      return CANDIDATE_DISPOSITION_DETAIL.executionSemanticsMissing;
    }
    default:
      return CANDIDATE_DISPOSITION_DETAIL.insufficientEvidence;
  }
}
