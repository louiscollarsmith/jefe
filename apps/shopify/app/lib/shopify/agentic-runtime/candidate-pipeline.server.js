// @ts-check

// Recommendation-first investigation runtime (see AGENTS.md / task brief 2026-08-24).
//
// Full Merchant Memory exposure fixed hypothesis breadth: Luna now sees 100+ beliefs and
// considers 10-18 distinct business signals. The remaining failure mode was structural, not
// evidentiary — a single open-ended investigation loop let Luna spend its whole turn budget
// browsing the Shopify operation catalogue (7-8 retrieve_shopify_operations calls) without
// ever reading live state, so it hit INVESTIGATION_FAILED / NO_ACTIONABLE_OPPORTUNITY despite
// a genuinely executable opportunity existing in the store.
//
// This module turns that single loop into a server-owned pipeline:
//   DISCOVER_CANDIDATES -> candidateQueue -> per-candidate bounded investigation
//   (with server-side capability binding, see generateAgenticShopifyRecommendation's
//   focusCandidate mode) -> pivot on failure -> rescue discovery -> high-bar terminal.
//
// Candidate investigation itself (capability binding, Shopify reads, validation, semantic
// repair, retrieval-loop prevention) is NOT reimplemented here — it reuses
// generateAgenticShopifyRecommendation in focusCandidate mode so the existing validation and
// safety guarantees (novelty, eligibility, evidence-id checks) apply unchanged per candidate.

import { Type } from "@google/genai";
import { logger as baseLogger } from "../../observability/logger.server.js";
import {
  buildRecommendationContext,
  generateAgenticShopifyRecommendation,
  CANDIDATE_DISPOSITION,
} from "./recommendation-agent.server.js";
import { withRecommendationLlmRetry } from "./recommendation-llm-retry.server.js";
import {
  resolveCandidateFamily,
  classifyDispositionDetail,
} from "./candidate-disposition-taxonomy.server.js";

const log = baseLogger.child({ component: "agentic-shopify-candidate-pipeline" });

export const AGENTIC_CANDIDATE_DISCOVERY_PROMPT_VERSION = "agentic-candidate-discovery-v1";

// Server-owned candidate lifecycle (distinct from OPPORTUNITY_COVERAGE_STATUS, which tracks
// API-domain families during open-ended discovery). RECOMMENDED is terminal-success; the rest
// are terminal-failure dispositions that cause an automatic pivot to the next candidate.
export const CANDIDATE_STATUS = Object.freeze({
  queued: "QUEUED",
  investigating: "INVESTIGATING",
  rejected: "REJECTED",
  blockedByEvidence: "BLOCKED_BY_EVIDENCE",
  nonExecutable: "NON_EXECUTABLE",
  alreadySatisfied: "ALREADY_SATISFIED",
  alreadyCovered: "ALREADY_COVERED",
  recommended: "RECOMMENDED",
});

// Observability states threaded through progressLog (Part 16). VERIFYING_CURRENT_STATE and
// BINDING_CAPABILITY happen inside generateAgenticShopifyRecommendation's focusCandidate mode;
// they are not separately instrumented here to avoid duplicating that loop's turn tracking.
export const PROGRESS_STATE = Object.freeze({
  discoveringCandidates: "DISCOVERING_CANDIDATES",
  investigatingCandidate: "INVESTIGATING_CANDIDATE",
  tryingNextCandidate: "TRYING_NEXT_CANDIDATE",
  rescueDiscovery: "RESCUE_DISCOVERY",
  validatingRecommendation: "VALIDATING_RECOMMENDATION",
  completed: "COMPLETED",
  noActionableOpportunity: "NO_ACTIONABLE_OPPORTUNITY",
  failed: "FAILED",
});

export const AGENTIC_CANDIDATE_DISCOVERY_SCHEMA = {
  type: Type.OBJECT,
  required: ["candidates"],
  properties: {
    candidates: {
      type: Type.ARRAY,
      description:
        "Ranked, materially distinct business opportunities. Each must emerge from Merchant Memory evidence, not a fixed category list.",
      items: {
        type: Type.OBJECT,
        required: ["candidateId", "diagnosedProblem", "priority"],
        properties: {
          candidateId: {
            type: Type.STRING,
            description: "Short kebab-case identifier for this candidate, e.g. activate-draft-product.",
          },
          diagnosedProblem: {
            type: Type.STRING,
            description: "The specific constraint or gap in current Shopify state, grounded in cited evidence.",
          },
          businessEvidenceRefs: {
            type: Type.ARRAY,
            nullable: true,
            items: { type: Type.STRING },
            description: "Belief ids or insight ids from Merchant Memory that support this diagnosis.",
          },
          mechanismHypothesis: {
            type: Type.STRING,
            nullable: true,
            description: "Why the possible intervention would address the diagnosed problem.",
          },
          possibleIntervention: {
            type: Type.STRING,
            nullable: true,
            description: "The semantic Shopify change that could implement this, e.g. 'publish the draft product'.",
          },
          relevantFamilyId: {
            type: Type.STRING,
            nullable: true,
            description: "Opportunity surface family id this most likely binds to, if apparent.",
          },
          priority: {
            type: Type.NUMBER,
            description: "1 is highest priority. Order by expected materiality and confidence.",
          },
          confidence: { type: Type.NUMBER, nullable: true, description: "0 to 1." },
        },
      },
    },
  },
};

export function buildCandidateDiscoverySystemPrompt({ rescue = false } = {}) {
  const base = `You are Jefe, generating a ranked queue of distinct, evidence-backed business opportunities for this merchant.

You have full Merchant Memory: merchant-confirmed intent, deterministic store evidence, and Jefe-generated hypotheses/goals. You also have activeWork (Actions already proposed or in progress) and an opportunitySurface of executable Shopify capability families.

This is discovery only. Do not call Shopify. Do not verify anything against live state — that happens in a later phase, one candidate at a time. Your only job is to propose candidates and rank them.

For each candidate, diagnosedProblem must identify a specific gap or constraint the evidence establishes — not merely that something is commercially important. Commercial importance (e.g. "White Wine = 34% of revenue") does not by itself establish a problem to fix.

Do not hardcode categories such as dead stock, restock, listing copy, or markdown. Candidates must emerge from what Merchant Memory actually shows for this merchant: revenue trajectory, repeat customers, basket composition, product momentum, returns, inventory capital, zero-sales patterns, catalogue/publication state, collections, or anything else the evidence supports.

Check activeWork before proposing a candidate that duplicates an Action already proposed or in progress with the same diagnosed problem and mechanism.

Produce as many independent, materially distinct candidates as the evidence genuinely supports — for onboarding, aim for enough (typically 3-8) that one failed hypothesis does not end the search. Do not force weak candidates merely to pad the count; a shorter list of genuinely distinct, evidence-backed candidates is better than a longer list of restated ideas.

Rank by priority: 1 is the strongest candidate to investigate first, considering materiality, confidence, and how directly the evidence supports it.`;

  if (!rescue) return base;

  return `${base}

RESCUE MODE: every candidate from the first discovery pass has already been investigated and rejected, blocked, or found non-executable. You receive alreadyAttemptedCandidates with the exact reason each failed.

Propose only materially different candidates — different underlying business signal, not a rephrasing of a rejected one. If a candidate failed because required evidence was missing (e.g. cost data), do not propose another candidate that depends on the same missing evidence. If a candidate failed because no safe Shopify write exists, do not propose another candidate needing the same missing capability.

It is legitimate to return few or no new candidates if the evidence genuinely does not support anything materially different. Do not fabricate a candidate merely to fill the queue.`;
}

/** @param {any} value @param {number} [max] */
function clean(value, max = 520) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {unknown} value */
function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 220)).filter(Boolean))];
}

/** @param {unknown} value */
function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** @param {string} text */
function normalizeWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

/** @param {string} a @param {string} b */
function jaccardSimilarity(a, b) {
  const setA = normalizeWords(a);
  const setB = normalizeWords(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Server-side novelty gate for rescue candidates: a rescue candidate whose diagnosedProblem
 * substantially overlaps an already-queued candidate is not "materially different" — the
 * model regenerated the same idea in different prose (Part 13).
 * @param {{ diagnosedProblem: string }} candidate
 * @param {{ diagnosedProblem: string }[]} existingQueue
 * @param {number} [threshold]
 */
export function isNovelCandidate(candidate, existingQueue, threshold = 0.55) {
  return !existingQueue.some(
    (existing) => jaccardSimilarity(candidate.diagnosedProblem, existing.diagnosedProblem) >= threshold,
  );
}

/**
 * @param {unknown} raw
 * @param {{ candidateId: string }[]} [existingQueue] Used only to keep candidateId unique across passes.
 */
export function normalizeCandidates(raw, existingQueue = []) {
  const seenIds = new Set(existingQueue.map((c) => c.candidateId));
  /** @type {any[]} */
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== "object") continue;
    const diagnosedProblem = clean(row.diagnosedProblem);
    if (!diagnosedProblem) continue;
    const baseId = slugify(row.candidateId) || slugify(diagnosedProblem).slice(0, 48) || "candidate";
    let candidateId = baseId;
    let suffix = 1;
    while (seenIds.has(candidateId)) {
      candidateId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(candidateId);
    out.push({
      candidateId,
      diagnosedProblem,
      businessEvidenceRefs: uniqueStrings(row.businessEvidenceRefs),
      mechanismHypothesis: clean(row.mechanismHypothesis, 420) || null,
      possibleIntervention: clean(row.possibleIntervention, 220) || null,
      relevantFamilyId: typeof row.relevantFamilyId === "string" ? row.relevantFamilyId : null,
      priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : out.length + 1,
      confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : null,
      status: CANDIDATE_STATUS.queued,
      reason: null,
    });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/**
 * Phase 1 / rescue discovery: one non-tool LLM call producing a ranked candidate queue.
 * @param {{
 *   provider: { generateStructuredJson: Function; provider?: string; model?: string };
 *   context: any;
 *   rescue?: boolean;
 *   rejectedCandidates?: any[];
 *   runId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   waitImpl?: (ms: number) => Promise<void>;
 * }} input
 */
export async function discoverCandidates(input) {
  const rescue = Boolean(input.rescue);
  const llmResult = await withRecommendationLlmRetry(
    () =>
      input.provider.generateStructuredJson({
        systemPrompt: buildCandidateDiscoverySystemPrompt({ rescue }),
        prompt: JSON.stringify({
          promptVersion: AGENTIC_CANDIDATE_DISCOVERY_PROMPT_VERSION,
          mode: rescue ? "rescue_discovery" : "candidate_discovery",
          merchantMemory: input.context.merchantMemory,
          opportunitySurface: input.context.opportunitySurface,
          alreadyAttemptedCandidates: rescue
            ? (input.rejectedCandidates ?? []).map((c) => ({
                diagnosedProblem: c.diagnosedProblem,
                status: c.status,
                reason: c.reason,
              }))
            : [],
        }),
        schema: AGENTIC_CANDIDATE_DISCOVERY_SCHEMA,
        maxInputTokens: 120000,
        maxOutputTokens: 3200,
        timeoutMs: 90_000,
      }),
    {
      runId: input.runId ?? null,
      phase: rescue ? "RESCUE_DISCOVERY" : "DISCOVERING_CANDIDATES",
      provider: input.provider.provider ?? null,
      model: input.provider.model ?? null,
      logger: input.logger,
      waitImpl: input.waitImpl,
    },
  );
  return {
    candidates: normalizeCandidates(llmResult.json?.candidates, []),
    usage: llmResult.usage ?? null,
    durationMs: llmResult.durationMs ?? null,
  };
}

/**
 * Maps a single-candidate generateAgenticShopifyRecommendation result onto the
 * candidate-queue lifecycle. INVESTIGATION_FAILED / VALIDATION_FAILED / any other
 * non-terminal-by-design status is treated as NON_EXECUTABLE for this candidate — a poor
 * capability binding or malformed output for Candidate A must not fail the whole run
 * (Part 8 / Part 17).
 * @param {any} result
 */
export function classifyCandidateOutcome(result) {
  if (result?.status === "RECOMMEND_ACTION") return CANDIDATE_STATUS.recommended;
  if (result?.candidateDisposition && Object.values(CANDIDATE_DISPOSITION).includes(result.candidateDisposition)) {
    return result.candidateDisposition;
  }
  if (result?.status === "NO_ACTIONABLE_OPPORTUNITY") return CANDIDATE_STATUS.rejected;
  if (result?.status === "BLOCKED") return CANDIDATE_STATUS.blockedByEvidence;
  return CANDIDATE_STATUS.nonExecutable;
}

/**
 * Structured, permanent per-candidate diagnostics (task: "Instrument permanent candidate
 * diagnostics"). `domain` and `dispositionDetail` are derived deterministically server-side
 * (see candidate-disposition-taxonomy.server.js) from signals already computed during
 * investigation — no LLM call, no schema change, safe to compute on every run including past
 * ones replayed from persisted candidateQueue rows.
 * @param {any} candidate
 * @param {{ families: any[] } | null} [opportunitySurface]
 */
function summarizeCandidateForDiagnostics(candidate, opportunitySurface = null) {
  const family = resolveCandidateFamily(candidate, opportunitySurface);
  const investigationDiagnostics = candidate.investigation?.diagnostics ?? null;
  const isTerminalFailure = candidate.status !== CANDIDATE_STATUS.recommended && candidate.status !== CANDIDATE_STATUS.queued && candidate.status !== CANDIDATE_STATUS.investigating;
  const dispositionDetail = isTerminalFailure
    ? classifyDispositionDetail({
        candidateStatus: candidate.status,
        resultStatus: candidate.resultStatus ?? null,
        reason: candidate.reason,
        family,
      })
    : null;
  return {
    candidateId: candidate.candidateId,
    domain: family?.id ?? null,
    diagnosedProblem: candidate.diagnosedProblem,
    priority: candidate.priority,
    beliefIds: candidate.businessEvidenceRefs ?? [],
    operationQuery: [candidate.possibleIntervention, candidate.diagnosedProblem].filter(Boolean).join(" ").trim() || null,
    retrievedOperations: investigationDiagnostics?.retrievedOperations ?? [],
    scopeRequired: family ? family.writeOperations.some((/** @type {any} */ op) => !op.scopeSatisfied) : null,
    scopeGranted: family ? family.writeOperations.every((/** @type {any} */ op) => op.scopeSatisfied) : null,
    executionStatus: family?.capabilityState ?? null,
    status: candidate.status,
    reason: candidate.reason,
    resultStatus: candidate.resultStatus ?? null,
    finalDisposition: candidate.status === CANDIDATE_STATUS.recommended ? "RECOMMENDED" : dispositionDetail,
  };
}

/**
 * Reconciliation summary (task: "rejection funnel" / "Only accept NO_ACTIONABLE_OPPORTUNITY if
 * this reconciliation balances") — counts every non-recommended terminal candidate by its
 * deterministic disposition-detail category, so exhaustion can be audited by category totals
 * rather than re-reading free-text reasons.
 * @param {any[]} candidateQueue
 * @param {{ families: any[] } | null} opportunitySurface
 */
function summarizeRejectionFunnel(candidateQueue, opportunitySurface) {
  /** @type {Record<string, number>} */
  const counts = {};
  let recommended = 0;
  for (const candidate of candidateQueue) {
    if (candidate.status === CANDIDATE_STATUS.recommended) {
      recommended += 1;
      continue;
    }
    if (candidate.status === CANDIDATE_STATUS.queued || candidate.status === CANDIDATE_STATUS.investigating) continue;
    const family = resolveCandidateFamily(candidate, opportunitySurface);
    const detail = classifyDispositionDetail({
      candidateStatus: candidate.status,
      resultStatus: candidate.resultStatus ?? null,
      reason: candidate.reason,
      family,
    });
    counts[detail] = (counts[detail] ?? 0) + 1;
  }
  const rejected = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { recommended, rejected, total: candidateQueue.length, byDisposition: counts };
}

/**
 * Recommendation-first candidate-driven investigation pipeline.
 *
 * DISCOVER_CANDIDATES -> server-owned candidateQueue -> per-candidate bounded investigation
 * (server-side capability binding, live Shopify verification) -> automatic pivot on failure
 * -> rescue discovery if the first pass exhausts without a recommendation -> only then
 * NO_ACTIONABLE_OPPORTUNITY.
 *
 * Token efficiency is explicitly not optimised here (see task brief Part 25): this trades
 * more LLM calls and more Shopify reads for a materially higher probability of a strong,
 * grounded, executable first recommendation.
 *
 * @param {{
 *   provider: { enabled?: boolean; generateStructuredJson?: Function; provider?: string; model?: string };
 *   prisma?: any;
 *   client: { request: (document: string, variables?: Record<string, unknown>) => Promise<unknown> };
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   snapshot: any;
 *   grantedScopes?: string[];
 *   catalog?: import("../api/catalog.server.js").ShopifyApiCatalog;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   previousAttempt?: any;
 *   maxCandidatesFirstPass?: number;
 *   maxCandidatesRescue?: number;
 *   perCandidateIterations?: number;
 *   maxTotalLlmCalls?: number;
 *   runId?: string | null;
 *   llmRetryWaitImpl?: (ms: number) => Promise<void>;
 *   assumeAllScopesGranted?: boolean;
 * }} input
 */
export async function runCandidateDrivenRecommendation(input) {
  const logger = input.logger ?? log;
  const provider = input.provider;
  if (!provider?.enabled || typeof provider.generateStructuredJson !== "function") {
    return { ok: false, status: "BLOCKED", blocker: "llm_provider_unavailable", trace: null };
  }
  const assumeAllScopesGranted = input.assumeAllScopesGranted === true;

  const context = buildRecommendationContext(input.snapshot, input.catalog, input.grantedScopes, {
    assumeAllScopesGranted,
  });
  /** @type {any[]} */
  const progressLog = [];
  const pushProgress = (state, detail = {}) => {
    progressLog.push({ state, at: new Date().toISOString(), ...detail });
  };

  const maxCandidatesFirstPass = input.maxCandidatesFirstPass ?? 8;
  const maxCandidatesRescue = input.maxCandidatesRescue ?? 4;
  const perCandidateIterations = input.perCandidateIterations ?? 4;
  const maxTotalLlmCalls = input.maxTotalLlmCalls ?? 40;

  let llmCallCount = 0;
  /** @type {any[]} */
  let sharedToolResults = [];
  /** @type {any[]} */
  const candidateQueue = [];
  /** @type {any[]} */
  const discoveryLog = [];

  const investigateCandidates = async (candidates, { rescue }) => {
    for (const candidate of candidates) {
      if (llmCallCount >= maxTotalLlmCalls) {
        logger.warn("candidate pipeline hit total LLM call ceiling", {
          merchantId: input.merchantId,
          shopId: input.shopId,
          llmCallCount,
        });
        break;
      }
      candidate.status = CANDIDATE_STATUS.investigating;
      pushProgress(PROGRESS_STATE.investigatingCandidate, { candidateId: candidate.candidateId, rescue });
      const result = await generateAgenticShopifyRecommendation({
        provider,
        prisma: input.prisma,
        client: input.client,
        merchantId: input.merchantId,
        shopId: input.shopId,
        shopDomain: input.shopDomain,
        grantedScopes: input.grantedScopes,
        catalog: input.catalog,
        snapshot: input.snapshot,
        previousAttempt: input.previousAttempt ?? null,
        logger,
        runId: input.runId ?? null,
        llmRetryWaitImpl: input.llmRetryWaitImpl,
        assumeAllScopesGranted,
        maxIterations: perCandidateIterations,
        focusCandidate: {
          candidateId: candidate.candidateId,
          diagnosedProblem: candidate.diagnosedProblem,
          businessEvidenceRefs: candidate.businessEvidenceRefs,
          mechanismHypothesis: candidate.mechanismHypothesis,
          possibleIntervention: candidate.possibleIntervention,
          relevantFamilyId: candidate.relevantFamilyId,
        },
        initialToolResults: sharedToolResults,
      });
      llmCallCount += Array.isArray(result.trace?.turns) ? Math.max(1, result.trace.turns.length) : 1;
      if (Array.isArray(result.trace?.toolResults)) sharedToolResults = result.trace.toolResults;
      candidate.investigation = { status: result.status, diagnostics: result.diagnostics ?? null };
      candidate.resultStatus = result.status ?? null;

      if (result.status === "RECOMMEND_ACTION") {
        pushProgress(PROGRESS_STATE.validatingRecommendation, { candidateId: candidate.candidateId });
        candidate.status = CANDIDATE_STATUS.recommended;
        candidate.reason = "Verified against current Shopify state.";
        return { done: true, result };
      }
      candidate.status = classifyCandidateOutcome(result);
      candidate.reason = result.blocker ?? candidate.status;
      pushProgress(PROGRESS_STATE.tryingNextCandidate, {
        candidateId: candidate.candidateId,
        disposition: candidate.status,
        reason: candidate.reason,
      });
    }
    return { done: false };
  };

  pushProgress(PROGRESS_STATE.discoveringCandidates, { rescue: false });
  const firstDiscovery = await discoverCandidates({
    provider,
    context,
    rescue: false,
    runId: input.runId,
    logger,
    waitImpl: input.llmRetryWaitImpl,
  });
  llmCallCount += 1;
  discoveryLog.push({ rescue: false, candidateCount: firstDiscovery.candidates.length, usage: firstDiscovery.usage });
  candidateQueue.push(...firstDiscovery.candidates);

  const firstPassOutcome = await investigateCandidates(candidateQueue.slice(0, maxCandidatesFirstPass), {
    rescue: false,
  });
  if (firstPassOutcome.done) {
    pushProgress(PROGRESS_STATE.completed);
    return finalizeRecommendation(firstPassOutcome.result, {
      candidateQueue,
      discoveryLog,
      progressLog,
      opportunitySurface: context.opportunitySurface,
    });
  }

  // Part 13/14: first pass exhausted without a recommendation. Run rescue discovery before
  // any no_actionable_opportunity terminal is legal.
  if (llmCallCount < maxTotalLlmCalls) {
    pushProgress(PROGRESS_STATE.rescueDiscovery);
    const rescueDiscovery = await discoverCandidates({
      provider,
      context,
      rescue: true,
      rejectedCandidates: candidateQueue,
      runId: input.runId,
      logger,
      waitImpl: input.llmRetryWaitImpl,
    });
    llmCallCount += 1;
    const novelRescueCandidates = rescueDiscovery.candidates
      .filter((candidate) => isNovelCandidate(candidate, candidateQueue))
      .slice(0, maxCandidatesRescue);
    discoveryLog.push({ rescue: true, candidateCount: novelRescueCandidates.length, usage: rescueDiscovery.usage });
    candidateQueue.push(...novelRescueCandidates);

    if (novelRescueCandidates.length > 0) {
      const rescueOutcome = await investigateCandidates(novelRescueCandidates, { rescue: true });
      if (rescueOutcome.done) {
        pushProgress(PROGRESS_STATE.completed);
        return finalizeRecommendation(rescueOutcome.result, {
          candidateQueue,
          discoveryLog,
          progressLog,
          opportunitySurface: context.opportunitySurface,
        });
      }
    }
  }

  // High-bar terminal (Part 14): only reachable after first-pass discovery, first-pass
  // investigation, rescue discovery, and rescue investigation have all been exhausted.
  pushProgress(PROGRESS_STATE.noActionableOpportunity);
  logger.info("candidate-driven recommendation exhausted without a candidate", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    candidateCount: candidateQueue.length,
    llmCallCount,
  });
  return {
    ok: true,
    status: "NO_ACTIONABLE_OPPORTUNITY",
    blocker: candidateQueue.length
      ? `Investigated ${candidateQueue.length} candidate(s) across discovery and rescue passes; none verified against current Shopify state. See diagnostics.candidateQueue for the reason each failed.`
      : "Candidate discovery produced no evidence-grounded business opportunities to investigate.",
    diagnostics: {
      candidateQueue: candidateQueue.map((candidate) => summarizeCandidateForDiagnostics(candidate, context.opportunitySurface)),
      rejectionFunnel: summarizeRejectionFunnel(candidateQueue, context.opportunitySurface),
      discoveryLog,
      llmCallCount,
    },
    trace: { progressLog, toolResults: sharedToolResults },
  };
}

/**
 * @param {any} result
 * @param {{ candidateQueue: any[]; discoveryLog: any[]; progressLog: any[]; opportunitySurface: any }} extras
 */
function finalizeRecommendation(result, { candidateQueue, discoveryLog, progressLog, opportunitySurface }) {
  return {
    ok: true,
    status: "RECOMMEND_ACTION",
    recommendation: result.recommendation,
    diagnostics: {
      ...(result.diagnostics ?? {}),
      candidateQueue: candidateQueue.map((candidate) => summarizeCandidateForDiagnostics(candidate, opportunitySurface)),
      rejectionFunnel: summarizeRejectionFunnel(candidateQueue, opportunitySurface),
      discoveryLog,
    },
    trace: {
      progressLog,
      turns: result.trace?.turns ?? [],
      toolResults: result.trace?.toolResults ?? [],
    },
  };
}
