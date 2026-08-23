// @ts-check

/**
 * Structural fingerprinting and overlap detection for recommendation deduplication.
 *
 * Operates on the meaning and effect of an Action — not its prose title.
 *
 * Fingerprint components:
 *   operations       – sorted normalised write operation names (feasibleWriteOperations)
 *   explicitTargetIds – sorted explicit resource IDs pinned via eligibilityCriteria
 *   predicateSig     – canonical hash of predicate-based eligibility criteria
 *
 * Overlap logic:
 *   'exact':   same operations + same targets → exact duplicate
 *   'partial': same operations + partial target overlap → partial duplicate
 *   'none':    no meaningful overlap → novel
 *
 * "Same resources, different intervention" is NOT a duplicate. Different interventions
 * (status change vs description fix) produce different eligibility predicates, so their
 * predicateSig values differ even when feasibleWriteOperations overlap.
 */

/**
 * Extract explicitly pinned resource IDs from eligibility criteria.
 * Matches: { field: "id", operator: "in", value: ["gid://..."] }
 * and:     { field: "id", operator: "eq", value: "gid://..." }
 *
 * @param {any[]} criteria
 * @returns {string[]}
 */
export function extractExplicitTargetIds(criteria) {
  if (!Array.isArray(criteria)) return [];
  const ids = [];
  for (const c of criteria) {
    const field = String(c?.field ?? "")
      .toLowerCase()
      .replace(/[._\s]/g, "");
    if (field !== "id" && field !== "productid") continue;
    const op = String(c?.operator ?? "");
    if (op === "in" && Array.isArray(c.value)) {
      for (const v of c.value) {
        if (v != null) ids.push(String(v));
      }
    } else if (op === "eq" && c.value != null) {
      ids.push(String(c.value));
    }
  }
  return [...new Set(ids)].sort();
}

/**
 * Build a canonical predicate signature from non-id eligibility criteria.
 * Used when operations overlap but targets are predicate-based (not explicit IDs).
 *
 * @param {any[]} criteria
 * @returns {string}
 */
function buildPredicateSig(criteria) {
  if (!Array.isArray(criteria)) return "";
  const predicates = criteria
    .filter((c) => {
      const field = String(c?.field ?? "")
        .toLowerCase()
        .replace(/[._\s]/g, "");
      return field !== "id" && field !== "productid";
    })
    .map((c) => {
      const resourceType = String(c?.resourceType ?? "").toLowerCase();
      const field = String(c?.field ?? "").toLowerCase();
      const operator = String(c?.operator ?? "").toLowerCase();
      const value = c?.value != null ? JSON.stringify(c.value) : "null";
      return `${resourceType}:${field}:${operator}:${value}`;
    })
    .sort();
  return predicates.join("|");
}

/**
 * Normalise an operation name to lowercase for consistent comparison.
 * @param {unknown} op
 * @returns {string}
 */
function normaliseOp(op) {
  return String(op ?? "")
    .toLowerCase()
    .trim();
}

/**
 * Compute a structural fingerprint for a semantic action or recommendation.
 *
 * @param {any} semanticAction Object with feasibleWriteOperations and eligibilityCriteria
 * @returns {{ operations: string[]; explicitTargetIds: string[]; predicateSig: string }}
 */
export function computeActionFingerprint(semanticAction) {
  const operations = [
    ...new Set(
      (semanticAction?.feasibleWriteOperations ?? []).map(normaliseOp),
    ),
  ]
    .filter(Boolean)
    .sort();
  const criteria = semanticAction?.eligibilityCriteria ?? [];
  return {
    operations,
    explicitTargetIds: extractExplicitTargetIds(criteria),
    predicateSig: buildPredicateSig(criteria),
  };
}

/**
 * Determine whether a candidate fingerprint overlaps with an existing one.
 *
 * @param {{ operations: string[]; explicitTargetIds: string[]; predicateSig: string }} candidate
 * @param {{ operations: string[]; explicitTargetIds: string[]; predicateSig: string }} existing
 * @returns {{ overlap: 'none' | 'exact' | 'partial'; coveredTargets: string[]; residualTargets: string[] }}
 */
export function detectOverlap(candidate, existing) {
  const empty = { coveredTargets: [], residualTargets: candidate.explicitTargetIds };

  // Operations must share at least one common write call
  if (
    candidate.operations.length === 0 ||
    existing.operations.length === 0 ||
    !candidate.operations.some((op) => existing.operations.includes(op))
  ) {
    return { overlap: "none", ...empty };
  }

  // Both sides have explicit IDs → compare by ID set
  if (candidate.explicitTargetIds.length > 0 && existing.explicitTargetIds.length > 0) {
    const existingSet = new Set(existing.explicitTargetIds);
    const covered = candidate.explicitTargetIds.filter((id) => existingSet.has(id));
    const residual = candidate.explicitTargetIds.filter((id) => !existingSet.has(id));
    if (covered.length === 0) return { overlap: "none", ...empty };
    if (residual.length === 0) return { overlap: "exact", coveredTargets: covered, residualTargets: [] };
    return { overlap: "partial", coveredTargets: covered, residualTargets: residual };
  }

  // Predicate-based eligibility: compare normalised criteria signatures
  if (
    candidate.predicateSig &&
    existing.predicateSig &&
    candidate.predicateSig === existing.predicateSig
  ) {
    return { overlap: "exact", coveredTargets: [], residualTargets: [] };
  }

  return { overlap: "none", ...empty };
}

/**
 * Extract the semantic action stored inside a MerchantAction plan JSON blob.
 * @param {any} action
 * @returns {any | null}
 */
export function extractSemanticActionFromRecord(action) {
  const plan = action?.plan;
  if (!plan || typeof plan !== "object") return null;
  return plan?.agentic?.semanticAction ?? null;
}

/**
 * Build a compact activeWork entry from a MerchantAction DB record.
 *
 * @param {any} action  MerchantAction record with plan and outcome JSON fields
 * @returns {{ actionId: string; status: string; diagnosedProblem: string | null; mechanism: string | null; targetResources: string[]; intendedOperations: string[]; achievedOutcome: string | null } | null}
 */
export function buildActiveWorkItem(action) {
  const semanticAction = extractSemanticActionFromRecord(action);
  if (!semanticAction) return null;
  const fp = computeActionFingerprint(semanticAction);
  const outcome = action?.outcome;
  const achievedOutcome =
    outcome && typeof outcome === "object" && typeof outcome.summary === "string"
      ? outcome.summary
      : null;
  return {
    actionId: action.id,
    status: action.status,
    diagnosedProblem: semanticAction.diagnosedProblem ?? null,
    mechanism: semanticAction.mechanism ?? null,
    targetResources: fp.explicitTargetIds,
    intendedOperations: fp.operations,
    achievedOutcome,
  };
}

/**
 * Check whether a candidate recommendation is novel relative to active work.
 *
 * PROPOSED and ACCEPTED (in-progress) actions are hard blocks.
 * Completed actions are not hard-blocked here — the live Shopify investigation
 * during generation is the authoritative check for completed work (since Shopify
 * state may have regressed and the opportunity legitimately recurred).
 *
 * @param {any} candidateRecommendation  Normalised recommendation object from Luna
 * @param {any[]} activeActions  MerchantAction records with plan JSON (status = proposed | accepted)
 * @returns {{ novel: boolean; reason?: string; overlappingActionId?: string; residualTargets?: string[] }}
 */
export function checkCandidateNovelty(candidateRecommendation, activeActions) {
  if (!Array.isArray(activeActions) || activeActions.length === 0) {
    return { novel: true };
  }
  const candidateFp = computeActionFingerprint(candidateRecommendation);
  if (candidateFp.operations.length === 0) return { novel: true };

  for (const action of activeActions) {
    const semanticAction = extractSemanticActionFromRecord(action);
    if (!semanticAction) continue;
    const existingFp = computeActionFingerprint(semanticAction);
    const result = detectOverlap(candidateFp, existingFp);
    if (result.overlap === "exact") {
      return {
        novel: false,
        reason: "exact_duplicate",
        overlappingActionId: action.id,
        residualTargets: [],
      };
    }
    if (result.overlap === "partial") {
      return {
        novel: false,
        reason: "partial_overlap",
        overlappingActionId: action.id,
        residualTargets: result.residualTargets,
      };
    }
  }
  return { novel: true };
}
