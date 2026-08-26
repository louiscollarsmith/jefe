## Objective

Investigate a path-specific `validateInvestigation` false negative surfaced via a newly-tagged
live run (`9022ca1a-ab09-445f-ade3-62c12dd783dc`, after `candidateId`/`iteration` tagging and the
`safeTrace` persistence fix landed). Control candidates from that run:

- **PASS**: `repair-product-cost-coverage` reached a substantive `BLOCKED_BY_EVIDENCE`.
- **FAIL**: `restart-intermittent-trading`, `investigate-return-heavy-products`,
  `refresh-inventory-freshness`, `stabilise-declining-product-range` — each has its own
  `FULL_SUCCESS` Shopify read on record (confirmed from the persisted, candidate-tagged trace),
  yet the run's final result for each still reported *"Recommendation decisions require at least
  one successful Shopify read (shopify_query)."*

Task: find the exact distinction between the PASS and FAIL branches, reproduce it with a focused
test, fix the inconsistent call site, and prove every terminal-status path (`RECOMMEND_ACTION`,
`BLOCKED`, `NO_ACTIONABLE_OPPORTUNITY`) recognises a prior candidate-owned successful read across
several later `ALREADY_AVAILABLE` re-asks. The successful-read invariant itself, prompts, and
candidate logic were explicitly out of scope.

## Data used

Real, live run data — not synthetic — pulled directly from `merchant_plan_runs`:

- `result_json.diagnostics.candidateQueue`: each candidate's `resultStatus`/`reason`.
- `result_json.trace.toolResults`: every row's `candidateId`, `iteration`, `tool`, `ok`,
  `facts.status` (the newly-tagged, newly-persisted fields from the two prior fixes in this
  session — this investigation would not have been possible without them).

Findings:

| candidateId | resultStatus | reason |
|---|---|---|
| `activate-draft-product-pipeline` | `BLOCKED` | `ITERATION_LIMIT` |
| `repair-product-cost-coverage` | `BLOCKED` | substantive evidence-grounded judgement |
| `recover-one-time-customers` | `INVESTIGATION_FAILED` | "successful Shopify read" |
| `restart-intermittent-trading` | `INVESTIGATION_FAILED` | "successful Shopify read" |
| `investigate-return-heavy-products` | `INVESTIGATION_FAILED` | "successful Shopify read" |
| `refresh-inventory-freshness` | `INVESTIGATION_FAILED` | "successful Shopify read" |
| `stabilise-declining-product-range` | `INVESTIGATION_FAILED` | "successful Shopify read" |

The persisted (candidate-tagged, `.slice(-16)`-truncated) `toolResults` trace shows every FAIL
candidate has its own `ok: true` `shopify_query` row — a `FULL_SUCCESS` at iteration 0 or 1 for
four of them, plus `refresh-inventory-freshness`'s own `INSUFFICIENT_INVESTIGATION` rejection at
iteration 0 followed by its own `FULL_SUCCESS` at iteration 1 — then further own `ALREADY_AVAILABLE`
re-asks of the same query at later iterations, all the way to the 4-iteration budget
(`perCandidateIterations`).

## The distinction

`repair-product-cost-coverage` returned via the direct `turn.status === "BLOCKED"` branch inside
the candidate's own iteration loop (`recommendation-agent.server.js` line ~703) — it landed on a
*validated* terminal status before exhausting its budget. That branch's `validateInvestigation`
call was already correctly scoped to `ownResultsStartIndex` (docs/ops/
recommendation-already-available-validation-fix/), so it passed.

Every FAIL candidate instead **exhausted its `maxIterations` budget without the model ever landing
back on a validated terminal status** — each kept issuing more tool calls (a genuine own read, then
repeat/discovery calls) rather than re-attempting `RECOMMEND_ACTION`/`BLOCKED`/
`NO_ACTIONABLE_OPPORTUNITY` after its read succeeded. That drops execution into the **iteration-budget
fallback** at the very end of `generateAgenticShopifyRecommendation` — a fourth, distinct code path
that does not call `validateInvestigation` at all. It calls two separate helpers,
`terminalFailureStatus(toolResults)` / `terminalFailureBlocker(toolResults)`, to classify the
outcome and pick a blocker message.

**Root cause**: unlike all three `validateInvestigation` call sites in this file (lines ~509, ~671,
~703, all already scoped to `ownResultsStartIndex` + `acceptAlreadyAvailableRead`), these two
fallback helpers took the raw, **unscoped**, full cross-candidate `toolResults` array and:

1. Scanned the *entire shared history* for "the last `recommendation_validation` row with
   `error.code === "INSUFFICIENT_INVESTIGATION"` anywhere" — including a different, earlier
   candidate's own rejection, sitting in the history this candidate inherited via
   `initialToolResults`.
2. Reported it **unconditionally**, with no check for whether a satisfying read had since
   occurred. A candidate whose own first attempt was correctly rejected (no read yet), which then
   read successfully on its very next turn, still had that now-cured rejection reported as the
   final blocker — because nothing re-checked the read requirement at the point of giving up.

This is exactly the same class of gap fixed twice already in this file
(`validateInvestigation`'s `ownResultsStartIndex` scoping, and `buildInvestigationState`'s matching
scoping in `docs/ops/recommendation-repair-loop-fairness/`) — a fourth call site that was never
brought in line with the other three.

## Fix

`app/lib/shopify/agentic-runtime/recommendation-agent.server.js`:

- New `ownResultsForFallback(toolResults, options)` — same slicing rule as
  `validateInvestigation`/`buildInvestigationState`, using a `typeof === "number"` check rather than
  the pre-existing truthy check elsewhere in this file (harmless there only because `0` and
  `undefined` happen to produce the same slice; written correctly here since this is new code).
- New `hasSatisfyingRead(ownResults, options)` — the exact same read-satisfaction rule
  `validateInvestigation` already uses (`row.tool === readToolName && row.ok &&
  (acceptAlreadyAvailableRead || row.facts?.status !== "ALREADY_AVAILABLE")`).
- `terminalFailureStatus`/`terminalFailureBlocker` now take `{ ownResultsStartIndex, readToolName,
  acceptAlreadyAvailableRead }`, scope their `recommendation_validation` scan to `ownResults`, and
  no longer classify/report a read-requirement failure once `hasSatisfyingRead(ownResults, options)`
  is true — a stale, cured, or misattributed rejection can no longer be the final answer.
- The single call site (end of `generateAgenticShopifyRecommendation`) now passes
  `{ ownResultsStartIndex, readToolName, acceptAlreadyAvailableRead: Boolean(focusCandidate) }` —
  the same scope every other `validateInvestigation` call in this file already uses.

**Not changed**: the successful-read invariant itself (`hasSatisfyingRead` mirrors
`validateInvestigation`'s existing rule exactly, nothing new is required or relaxed),
`validateInvestigation`, `buildInvestigationState`, candidate ranking, Gateway queries, prompts, or
the 24h opportunity set.

## Tests

`tests/recommendation-iteration-limit-fallback.test.mjs` (5 tests):

1. **Single-candidate reproduction** — own `INSUFFICIENT_INVESTIGATION` at iteration 0, own
   `FULL_SUCCESS` at iteration 1, then stalls (discovery-only calls) through the rest of its budget.
   Proven to fail without the fix (`status: INVESTIGATION_FAILED`, blocker: "successful Shopify
   read") and pass with it, by reverting only the call-site/helper-signature change, rerunning, and
   restoring it — not asserted from description alone.
2. **Cross-candidate reproduction** (the real `9022ca1a` shape) — a `never-reads` candidate
   genuinely and legitimately fails with `INVESTIGATION_FAILED`; a second, `reads-then-stalls`
   candidate inherits that history, reads successfully on its own, then stalls. Proven the second
   candidate's own read is not shadowed by the first candidate's unrelated rejection. Same
   before/after verification as above.
3–5. **Every terminal-status path** (`RECOMMEND_ACTION`, `BLOCKED`, `NO_ACTIONABLE_OPPORTUNITY`) —
   own `FULL_SUCCESS` at iteration 0, two further own `ALREADY_AVAILABLE` re-asks, then the
   terminal turn — each concludes correctly rather than being rejected. These already passed before
   this fix (the three direct `validateInvestigation` call sites were already correctly scoped);
   kept as permanent regression coverage per the task's explicit request.

Full regression sweep: 107/107 across every recommendation-agent/candidate-pipeline/opportunity-set/
gateway-safety suite touching the changed file, zero regressions. `npm run typecheck`: 99 errors,
identical to the pre-existing baseline, none in the changed lines.

## What was not changed

- The successful-read invariant (`hasSatisfyingRead` mirrors `validateInvestigation`'s existing
  rule verbatim).
- `validateInvestigation`, `buildInvestigationState` — both already correctly scoped; untouched.
- Candidate ranking, Gateway queries, prompts, the 24h opportunity set.
- The pre-existing truthy-vs-`typeof number` check in `validateInvestigation`/
  `buildInvestigationState`'s own `ownResultsStartIndex` handling — confirmed harmless (value `0`
  and `undefined` produce an identical slice either way) and out of scope for this fix; not touched
  to keep the change minimal.

## Real/replay validation

No live rerun against `jefe-local-store.myshopify.com` — consistent with this session's established
caution around the shared dev store. The real, live-run data used to diagnose this (run
`9022ca1a-ab09-445f-ade3-62c12dd783dc`, its candidate-tagged trace) is the ground truth this fix was
derived from and matched against; the regression tests reproduce that exact shape deterministically
through the real, unmodified `generateAgenticShopifyRecommendation`/`runCandidateDrivenRecommendation`
control flow.
