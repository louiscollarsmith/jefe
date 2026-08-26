## Objective

Find and fix why otherwise-plausible recommendation candidates were consuming their entire
investigation budget and being persisted as `ITERATION_LIMIT` → `INSUFFICIENT_EVIDENCE`, instead of
converging to a real `RECOMMEND_ACTION` or a substantive blocker.

## Data used — real, not synthetic

Second run of opportunity set `25008faa-3138-4479-8ee9-133d07ea1b06`, run
`c217b81e-6e3e-4a62-9294-6b73ac3bef23`: `discoveryReused: true`, `startingCandidateRank: 3`,
`endingCandidateRank: 5`, `llmCallCount: 12`. All three investigated candidates ended
`ITERATION_LIMIT` → `INSUFFICIENT_EVIDENCE`:

| candidateId | rank | resultStatus (pre-fix persisted) | reason |
|---|---|---|---|
| `reactivate-high-value-customers` | 3 | `INSUFFICIENT_EVIDENCE` | `ITERATION_LIMIT` |
| `recover-recent-demand-momentum` | 4 | `INSUFFICIENT_EVIDENCE` | `ITERATION_LIMIT` |
| `reduce-product-return-friction` | 5 | `INSUFFICIENT_EVIDENCE` | `ITERATION_LIMIT` |

A fourth real example from the *first* run against the same set — `complete-variant-cost-data`
(rank 1) — shows the identical pattern, confirming this isn't specific to reuse mode.

`llmCallCount: 12` for 3 candidates = exactly 4 each = `perCandidateIterations`, the full budget,
for every single one. All four real examples hit exactly 100% of budget, never less — a strong
signal this is systemic, not per-candidate evidence variance.

## What the available evidence does and does not show

Reconstructing "every iteration exactly — LLM status output, tool calls, validation result,
repair instruction" turned out to require data that **is not persisted anywhere in this
codebase**, and I want to be explicit about that rather than presenting an inferred narrative as
observed fact:

- The `OPPORTUNITY_SET_EXHAUSTED` persistence path (`recommendation-service.server.js`) does not
  write a `trace` field to `result_json` at all — only `RECOMMEND_ACTION` and the generic
  `no_actionable_opportunity`/`failed` branches do. This run's own `toolResults`/`turns` trace
  was never written to the DB.
- The running dev server's own terminal log (checked directly, covering the full
  `11:29:30Z`–`11:38:32Z` window) contains only LLM-retry/429-backoff events and unrelated
  structured logs (belief derivation, etc.) — **no per-turn LLM status, tool call, or validation
  content was logged anywhere**, before this fix.

What I *can* establish with certainty, from the code rather than inference: `reason: "ITERATION_LIMIT"`
is a literal string that can only be produced by one code path —
`terminalFailureBlocker(toolResults) ?? "ITERATION_LIMIT"` returning `null`, which only happens
when the candidate's own scope contains **zero** `recommendation_validation` rows at all. That is
a direct, code-guaranteed proof that these candidates never once attempted a terminal decision —
not that they attempted one and were rejected. (Instrumentation added below closes this gap for
future incidents — see "Observability".)

## Root cause 1 (labeling): `ITERATION_LIMIT` silently became `INSUFFICIENT_EVIDENCE`

`terminalFailureStatus`/`terminalFailureBlocker` (the fallback classifier for "the model exhausted
its budget without landing on a validated terminal status" — already fixed once this session for
cross-candidate scoping, see `docs/ops/recommendation-fallback-path-attribution-fix/`) had no
distinct outcome for "never attempted a decision at all". It fell through to the generic `"BLOCKED"`
status with a bare `"ITERATION_LIMIT"` blocker string.

`classifyCandidateOutcome` (`candidate-pipeline.server.js`) maps `status: "BLOCKED"` to
`CANDIDATE_STATUS.blockedByEvidence`. `classifyDispositionDetail`
(`candidate-disposition-taxonomy.server.js`) maps `candidateStatus: "BLOCKED_BY_EVIDENCE"` to
`INSUFFICIENT_EVIDENCE` by default (its `INPUT_MISSING_PATTERN` regex doesn't match the literal
text "ITERATION_LIMIT"). **A runtime/convergence failure was silently reported as though Jefe had
reached and rejected the opportunity on the evidence** — exactly the semantic violation the task
called out.

Separately, in reuse mode, every non-recommended outcome was persisted with consumption
`status: REJECTED` unconditionally — permanently burning the candidate for the rest of this 24h
opportunity set's lifetime, even when Jefe never actually judged it.

### Fix

- `terminalFailureStatus` now returns a distinct `"ITERATION_LIMIT"` status when the candidate's
  own scope has zero `recommendation_validation` rows (never attempted a decision). Every other
  case — a real attempt that was validated-rejected, a cured rejection, a genuine `BLOCKED` — is
  unchanged.
- `terminalFailureBlocker` returns *"Investigation did not converge on a terminal decision within
  the iteration budget."* for the same case, instead of `null`/the bare literal.
- New `CANDIDATE_STATUS.iterationLimit` (`candidate-pipeline.server.js`) and
  `CANDIDATE_DISPOSITION_DETAIL.convergenceFailure` (`candidate-disposition-taxonomy.server.js`) —
  genuinely distinct from every evidence-based bucket, checked before the pattern-matching switch
  so it can never fall through to `insufficientEvidence`.
- **Requeue, not reject**: a candidate classified `ITERATION_LIMIT` is now persisted `QUEUED`
  (discover mode: safe immediately, since `investigateCandidates` only ever visits each candidate
  once per run — see `mapCandidateForPersistence`) or explicitly requeued mid-run (reuse mode).

### The reuse-mode requeue needed one more fix, not just a status change

Reuse mode's `investigateReusedOpportunitySet` runs a `while` loop that calls `claimNextCandidate`
(rank-ascending, from `QUEUED`/abandoned-`IN_PROGRESS`) every iteration. Naively setting a
convergence-failed candidate back to `QUEUED` would make it the very next thing that same loop
claims again — an unbounded same-run retry loop, directly **increasing** latency instead of
reducing it (verified: reverting just this part of the fix and rerunning the new test suite
reproduces exactly this — the run exhausts its 40-call ceiling reclaiming the same candidate and
never reaches the next one; see Tests).

Fix: `claimNextCandidate` now accepts `excludeCandidateIds`; `investigateReusedOpportunitySet`
tracks candidate ids it has already seen fail to converge *this run* and excludes them from further
claims for the remainder of this run, while the DB row itself is reset to a genuinely fresh
`QUEUED` state (`resolveCandidate`: status `QUEUED` now also clears `investigatedByRunId`/
`claimedAt`/`resolvedAt`/`finalDisposition`/`reason`, not just the status string) — retryable by a
*future* run, not this one.

## Root cause 2 (convergence itself): the "stop and decide" instruction was too weak

Correct labeling doesn't reduce how often a candidate hits the ceiling in the first place — that's
a separate, real problem worth fixing on its own. `buildInvestigationState`'s `doNotRepeat` field
(injected into every turn once `investigationComplete === true`) only ever said *"do not repeat
[these specific tool calls]"* — a model can satisfy that literally while still spending its
remaining turns on a schema lookup, a slightly-different-but-unnecessary read, or simply not
producing a terminal-status turn at all. Nothing in either the ledger or the system prompt
affirmatively told the model *"you must decide now."* The system prompt itself never referenced
`investigationState` at all.

### Fix (the actual latency-facing change — see caveat below)

- `doNotRepeat`'s text now ends with an explicit instruction: *"You have sufficient evidence —
  return a terminal decision (RECOMMEND_ACTION, BLOCKED, or NO_ACTIONABLE_OPPORTUNITY) this turn
  instead of calling more tools."*
- The system prompt (`buildGatewayCandidateInvestigationSystemPrompt`) now explicitly tells the
  model that `investigationState` is authoritative and that `investigationState.investigationComplete
  === true` means stop and decide this turn — not a suggestion.
- **Not changed**: `perCandidateIterations`/the global iteration limit (explicitly out of scope
  per the task — "do not increase the iteration limit as the first fix"), candidate
  discovery/ranking, Merchant Memory, Gateway architecture, the Shopify-grounding requirement, 24h
  opportunity-set semantics, or the model.
- Checked and confirmed **not a bug**: the final available iteration (`iteration === maxIterations
  - 1`) runs through the exact same terminal-status handling as every other iteration — the loop
  never exits early or denies the model a last decision turn.

**Honest caveat**: I cannot prove via a unit test that a real LLM complies with a strengthened
natural-language instruction — that requires a live run, which this session deliberately avoided
against the shared `jefe-local-store` fixture (see this session's established caution). What is
verified: the instruction is now present, unambiguous, and referenced from the system prompt
(regression-tested for content); the *server-side machinery* (the ledger, the scoping) that decides
when to say "you're done" was already correct (verified in the prior fallback-path-attribution fix
session) — this closes the last plausible gap between "the server knows investigation is complete"
and "the model is told to act on that."

## Observability: a controlled replay is now actually possible

Before this fix, nothing logged per-turn content at all outside of LLM-retry/429 events — which is
why full iteration-by-iteration reconstruction of the three live candidates above was not possible
from any persisted source. Added one structured `logger.info("agentic candidate investigation
turn", { candidateId, iteration, turnStatus, toolCallCount, investigationComplete })` per turn in
`generateAgenticShopifyRecommendation`'s main loop. A future incident of this shape is now
diagnosable from logs alone, without this level of forensic reconstruction.

## Tests

`tests/candidate-pipeline.test.mjs` (5 new tests, appended):

1. `classifyCandidateOutcome`: `ITERATION_LIMIT` → distinct `CANDIDATE_STATUS`, not
   `blockedByEvidence`/`rejected`.
2. `classifyDispositionDetail`: `ITERATION_LIMIT` → `CONVERGENCE_FAILURE`, never
   `INSUFFICIENT_EVIDENCE`.
3. A candidate that always returns `CONTINUE` with a tool call (never attempts a terminal status)
   for its full budget → `generateAgenticShopifyRecommendation` returns `status: "ITERATION_LIMIT"`
   with the new runtime-failure blocker text, not the "successful Shopify read" message.
4. Discover mode: a non-converging candidate alongside a converging one → the run still reaches
   `RECOMMEND_ACTION` via the second candidate; the first is labeled `CONVERGENCE_FAILURE` in
   diagnostics (not `INSUFFICIENT_EVIDENCE`) and persists `QUEUED` (not `REJECTED`) in the
   opportunity set.
5. Reuse mode: same shape, through the real claim/requeue loop. **Verified to fail without the
   exclude-list fix** — reverted just that part, reran: the run exhausts its 40-call ceiling
   re-claiming the same non-converging candidate and never reaches the second one
   (`NO_ACTIONABLE_OPPORTUNITY: Reached the per-run investigation budget...`, not
   `RECOMMEND_ACTION`). Restored the fix, reran clean. This is the direct proof the requeue doesn't
   increase latency.

Full regression sweep: 149/149 across every recommendation-agent/candidate-pipeline/
opportunity-set/gateway-safety/disposition-taxonomy suite touching the changed files, zero
regressions. `npm run typecheck`: 99 errors, identical set to the pre-existing baseline (confirmed
by comparing error messages with line-number shifts normalized out — this change added ~90 lines
earlier in `candidate-pipeline.server.js`, shifting later pre-existing errors' line numbers without
changing their content).

## Pre/post expected LLM-turn count per candidate

| | Pre-fix (observed, all 4 real examples) | Post-fix, labeling/requeue only | Post-fix, with convergence-instruction strengthening |
|---|---|---|---|
| Turns consumed by a candidate that fails to converge | 4/4 (100% of `perCandidateIterations`) | **Unchanged: still 4/4** — relabeling doesn't change *when* the loop gives up, only how the outcome is reported and whether the candidate can be retried later | Expected to drop toward the minimum needed (typically 2: one read, one decision) *if* the model complies with the strengthened instruction — not deterministically provable without a live run |
| Same-run latency impact of a non-converging candidate | N/A (candidate was rejected, pipeline moved on) | **No change** — requeue happens *after* the same 4-turn budget is spent, and the exclude-list fix specifically guarantees the pipeline still moves on to the next candidate in this run, not re-claiming the failed one | Same |
| Candidate's fate for the rest of the 24h opportunity set | Permanently `REJECTED` (`INSUFFICIENT_EVIDENCE`) — a potentially valid opportunity burned by a runtime hiccup | `QUEUED` — retry-eligible on a future run, with (if the prompt fix works) a real chance to converge in fewer turns next time | Same, plus a better chance of resolving on the retry itself |

**Net effect on latency**: this run's own total latency is not worse (same per-candidate ceiling,
same candidate-pivot behavior, exclude-list fix specifically prevents the one path that could have
made it worse). The throughput improvement is at the *24h-queue* level — a candidate no longer
loses its one shot to a runtime hiccup — plus a real (though not test-provable) chance of fewer
turns per candidate from the strengthened convergence instruction. No global iteration limit was
raised.

## What was not changed

Candidate discovery/ranking, Merchant Memory, Gateway architecture, the Shopify-grounding
requirement, 24h opportunity-set semantics (TTL, atomic claim idiom, rank ordering), the model, and
`perCandidateIterations`/the global iteration ceiling.
