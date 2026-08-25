// @ts-check
//
// Durable candidate-discovery queue lifecycle (see docs/ops/recommendation-opportunity-set-24h/).
//
// Candidate discovery (the ~70k-token LLM call in candidate-pipeline.server.js) is expensive and,
// run repeatedly against near-identical merchant state, produces near-identical rankings. This
// module persists one ranked discovery result — a MerchantOpportunitySet — for 24h, so every
// subsequent "Generate another proposal" resumes from the next unconsumed
// MerchantOpportunityCandidate instead of rediscovering.
//
// This module owns claim/resume/retry semantics; candidate-pipeline.server.js treats the set as
// data (it decides *when* to discover vs. reuse, this module decides *how* a candidate is safely
// claimed exactly once).

import { PLAN_RUN_STATUS } from "../../merchant-plan/constants.server.js";

export const OPPORTUNITY_SET_TTL_MS = 24 * 60 * 60 * 1000;

export const CANDIDATE_CONSUMPTION_STATUS = Object.freeze({
  queued: "QUEUED",
  inProgress: "IN_PROGRESS",
  rejected: "REJECTED",
  recommended: "RECOMMENDED",
});

// A candidate claimed (IN_PROGRESS) by a run that has since reached one of these terminal,
// non-completed statuses was abandoned mid-investigation (worker crash, deploy, timeout) — its
// claim is reclaimable by a later request rather than blocking the queue forever. A run that
// completed (produced a recommendation) never leaves a candidate IN_PROGRESS — it resolves it to
// RECOMMENDED in the same transaction — so "completed" is deliberately absent from this list.
const ABANDONED_OWNER_RUN_STATUSES = [
  PLAN_RUN_STATUS.failed,
  PLAN_RUN_STATUS.insufficientData,
  PLAN_RUN_STATUS.modelDisabled,
  "no_actionable_opportunity",
  "opportunity_set_exhausted",
];

/**
 * The latest opportunity set for a merchant/shop that has not yet expired, with candidates
 * ordered by discovery rank. Returns null if none exists or the latest one has expired — both
 * cases mean the caller must run fresh discovery.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function loadActiveOpportunitySet(prisma, { merchantId, shopId, now = new Date() }) {
  if (typeof prisma?.merchantOpportunitySet?.findFirst !== "function") return null;
  const set = await prisma.merchantOpportunitySet.findFirst({
    where: { merchantId, shopId, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    include: { candidates: { orderBy: { rank: "asc" } } },
  });
  return set ?? null;
}

/**
 * True iff no candidate in the set can still be claimed or is actively being investigated —
 * i.e. every candidate has reached a terminal REJECTED/RECOMMENDED disposition. This is a cheap
 * pre-check used before creating a new MerchantPlanRun at all (Part 10: exhaustion must not
 * silently trigger rediscovery, and should not even spend a run to discover that).
 * @param {{ candidates: { status: string }[] } | null} set
 */
export function isDefinitelyExhausted(set) {
  if (!set) return false;
  return !set.candidates.some(
    (c) =>
      c.status === CANDIDATE_CONSUMPTION_STATUS.queued ||
      c.status === CANDIDATE_CONSUMPTION_STATUS.inProgress,
  );
}

/**
 * Persist a freshly discovered candidate queue as a new 24h opportunity set. Called once, at the
 * end of a "discover" mode pipeline run (whether it produced a recommendation or exhausted into
 * NO_ACTIONABLE_OPPORTUNITY) — never mid-run. `candidates` are pre-mapped rows carrying the
 * pipeline's final in-memory state for each candidate (queued/terminal), in final rank order.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string; shopId: string; sourceRunId: string | null; sourceMode?: string | null;
 *   candidates: Array<{
 *     candidateId: string; diagnosedProblem: string; businessEvidenceRefs?: string[];
 *     mechanismHypothesis?: string | null; possibleIntervention?: string | null;
 *     relevantFamilyId?: string | null; confidence?: number | null; rescue?: boolean;
 *     status: string; finalDisposition?: string | null; reason?: string | null;
 *     investigated?: boolean;
 *   }>;
 *   discoveryLog?: unknown; llmCallCount?: number | null; now?: Date;
 * }} input
 * @returns {Promise<string>} the new opportunity set id
 */
export async function persistFreshOpportunitySet(
  prisma,
  { merchantId, shopId, sourceRunId, sourceMode = null, candidates, discoveryLog, llmCallCount, now = new Date() },
) {
  const expiresAt = new Date(now.getTime() + OPPORTUNITY_SET_TTL_MS);
  return prisma.$transaction(async (/** @type {any} */ tx) => {
    const set = await tx.merchantOpportunitySet.create({
      data: {
        merchantId,
        shopId,
        createdAt: now,
        expiresAt,
        sourceRunId: sourceRunId ?? null,
        sourceMode,
        discoveryLog: discoveryLog ?? [],
        llmCallCount: Number.isFinite(llmCallCount) ? Number(llmCallCount) : null,
      },
    });
    if (candidates.length) {
      await tx.merchantOpportunityCandidate.createMany({
        data: candidates.map((candidate, index) => ({
          opportunitySetId: set.id,
          rank: index + 1,
          candidateId: candidate.candidateId,
          diagnosedProblem: candidate.diagnosedProblem,
          businessEvidenceRefs: candidate.businessEvidenceRefs ?? [],
          mechanismHypothesis: candidate.mechanismHypothesis ?? null,
          possibleIntervention: candidate.possibleIntervention ?? null,
          relevantFamilyId: candidate.relevantFamilyId ?? null,
          confidence: candidate.confidence ?? null,
          rescue: Boolean(candidate.rescue),
          status: candidate.status,
          finalDisposition: candidate.finalDisposition ?? null,
          reason: candidate.reason ?? null,
          investigatedByRunId: candidate.investigated ? sourceRunId : null,
          claimedAt: candidate.investigated ? now : null,
          resolvedAt:
            candidate.status !== CANDIDATE_CONSUMPTION_STATUS.queued && candidate.investigated ? now : null,
        })),
      });
    }
    return set.id;
  });
}

/**
 * Atomically claim the next investigable candidate in a set for a given run:
 *
 * 1. If this exact run already has a candidate IN_PROGRESS, resume it (worker retry of the same
 *    run must not jump to a different candidate merely because infrastructure failed).
 * 2. Otherwise walk QUEUED candidates — plus any IN_PROGRESS candidate whose owning run has since
 *    reached an abandoned terminal state — in rank order, attempting an atomic
 *    `updateMany({ where: { id, status: <expected> } })` claim per candidate. The first
 *    `count === 1` wins; a losing request (racing another simultaneous claim) falls through to
 *    try the next candidate rather than independently investigating the one it lost.
 *
 * Returns the claimed row, or null if nothing is claimable (the set is exhausted).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ opportunitySetId: string; runId: string; now?: Date }} input
 */
export async function claimNextCandidate(prisma, { opportunitySetId, runId, now = new Date() }) {
  const resumed = await prisma.merchantOpportunityCandidate.findFirst({
    where: {
      opportunitySetId,
      investigatedByRunId: runId,
      status: CANDIDATE_CONSUMPTION_STATUS.inProgress,
    },
  });
  if (resumed) return resumed;

  const claimable = await prisma.merchantOpportunityCandidate.findMany({
    where: {
      opportunitySetId,
      status: { in: [CANDIDATE_CONSUMPTION_STATUS.queued, CANDIDATE_CONSUMPTION_STATUS.inProgress] },
    },
    orderBy: { rank: "asc" },
  });

  for (const candidate of claimable) {
    if (candidate.status === CANDIDATE_CONSUMPTION_STATUS.inProgress) {
      const owningRun = candidate.investigatedByRunId
        ? await prisma.merchantPlanRun.findUnique({
            where: { id: candidate.investigatedByRunId },
            select: { status: true },
          })
        : null;
      const abandoned = !owningRun || ABANDONED_OWNER_RUN_STATUSES.includes(owningRun.status);
      if (!abandoned) continue; // legitimately being worked by a still-active run
    }
    const claimed = await prisma.merchantOpportunityCandidate.updateMany({
      where: { id: candidate.id, status: candidate.status },
      data: { status: CANDIDATE_CONSUMPTION_STATUS.inProgress, investigatedByRunId: runId, claimedAt: now },
    });
    if (claimed.count === 1) {
      return prisma.merchantOpportunityCandidate.findUnique({ where: { id: candidate.id } });
    }
    // Lost the race for this candidate (or it moved on since the list was read) — try the next.
  }
  return null;
}

/**
 * Terminal update for a claimed candidate: REJECTED (pivot to the next candidate) or
 * RECOMMENDED (consumed for this opportunity set — Part 6 — even before the merchant reviews it).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ id: string; status: string; finalDisposition?: string | null; reason?: string | null; recommendationId?: string | null; now?: Date }} input
 */
export async function resolveCandidate(
  prisma,
  { id, status, finalDisposition = null, reason = null, recommendationId = null, now = new Date() },
) {
  return prisma.merchantOpportunityCandidate.update({
    where: { id },
    data: { status, finalDisposition, reason, recommendationId, resolvedAt: now },
  });
}

/**
 * Full candidate list for a set, for observability (Part 12: "why did this proposal start at
 * candidate #4?" answerable from result.diagnostics without reading code). Safe to call for any
 * opportunitySetId, discover or reuse mode.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} opportunitySetId
 */
export async function loadOpportunitySetSummary(prisma, opportunitySetId) {
  if (!opportunitySetId || typeof prisma?.merchantOpportunitySet?.findUnique !== "function") return null;
  const set = await prisma.merchantOpportunitySet.findUnique({
    where: { id: opportunitySetId },
    include: { candidates: { orderBy: { rank: "asc" } } },
  });
  if (!set) return null;
  return {
    id: set.id,
    createdAt: set.createdAt,
    expiresAt: set.expiresAt,
    candidates: set.candidates.map((/** @type {any} */ candidate) => ({
      rank: candidate.rank,
      candidateId: candidate.candidateId,
      diagnosedProblem: candidate.diagnosedProblem,
      status: candidate.status,
      finalDisposition: candidate.finalDisposition,
      reason: candidate.reason,
      investigatedByRunId: candidate.investigatedByRunId,
      recommendationId: candidate.recommendationId,
    })),
  };
}

/**
 * Attach a recommendation id to the candidate that produced it, located by the
 * (opportunitySetId, candidateId) natural key so callers don't need to carry the row id across
 * the pipeline/persistence boundary.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ opportunitySetId: string; candidateId: string; recommendationId: string }} input
 */
export async function attachRecommendationToCandidate(prisma, { opportunitySetId, candidateId, recommendationId }) {
  return prisma.merchantOpportunityCandidate.update({
    where: { opportunitySetId_candidateId: { opportunitySetId, candidateId } },
    data: { recommendationId },
  });
}
