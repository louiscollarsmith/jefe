## Objective

Fix a traced regression where viable recommendation candidates were ending `NO_ACTIONABLE_OPPORTUNITY`
(via `ITERATION_LIMIT`) because the candidate investigation loop repeated already-satisfied Shopify
reads, attempted recommendation validation before any read existed, and burned the whole candidate
budget on those avoidable protocol mistakes — not on genuine evidence gaps.

## Data used

Real persisted trace, run `ff109274-230c-4a39-b593-f4d4874f619d`
(`pre-fix-persisted-trace-run-ff109274.json` in this folder), extracted from
`merchant_plan_runs.result_json` in the local dev DB. Candidate `reduce-product-specific-returns`:

| iteration | turn |
|---|---|
| 0 | `recommendation_validation` attempted with **zero** prior Shopify reads → `INSUFFICIENT_INVESTIGATION` |
| 1 | successful `shopify_query` (`HighReturnProducts`) |
| 2 | exact same query again → `ALREADY_AVAILABLE` |
| 3 | exact same query again → `ALREADY_AVAILABLE` |
| terminal | `ITERATION_LIMIT` |

`increase-multi-product-baskets`, `recover-lapsed-customer-revenue`, and `reactivate-draft-products`
showed the same or a related pattern in the same run.

## Root causes confirmed (matching the prior investigation's conclusions)

1. **Repeated `ALREADY_AVAILABLE` reads burn the budget.** `investigationState.investigationComplete`
   already told the model to stop, and the system prompt already framed this as a hard instruction —
   this was not a prompt-wording gap. The runtime had no structural consequence for ignoring it: a
   duplicate read consumed a full iteration exactly like a genuine one.
2. **Premature validation.** `validateInvestigation` deterministically rejects a terminal-status
   attempt before any successful read (`INSUFFICIENT_INVESTIGATION`), but that rejection still
   consumed an iteration — a deterministic, guaranteed-to-fail transition was priced the same as a
   genuine attempt.
3. **Capability-state leakage — confirmed diagnostics-only, not runtime state leakage.**
   `buildRecommendationDiagnostics` (the function that serializes `diagnostics.retrievedOperations`
   for persistence) was the *only* consumer of the shared `toolResults` array in this file that did
   not scope itself to `ownResultsStartIndex` — every other consumer
   (`validateInvestigation`/`buildInvestigationState`/`terminalFailureStatus`/`terminalFailureBlocker`)
   already did. The actual investigation *decision* (what counted as evidence for validation) was
   never affected — only the diagnostics a candidate's own record showed after the fact. Proven from
   the real trace: three unrelated candidates carried byte-identical `retrievedOperations` lists that
   only `add-product-cost-coverage` had actually earned.
4. **Schema recovery didn't reach the model cleanly.** `buildInvestigationState`'s `failedReads` only
   carried `operation` (frequently `null` for exactly the case that matters — a malformed/invalid-field
   document fails before a root field resolves), giving the model no structured reason to act on.
5. **A separate, pre-existing diagnostic-clarity bug**, found while fixing (3): the iteration-budget
   fallback blocker string was the literal `"ITERATION_LIMIT"` — byte-identical to the actual
   `CANDIDATE_STATUS.iterationLimit`/`terminalFailureStatus` value — so a candidate whose real
   `terminalFailureStatus` was `"BLOCKED"` (a validation attempt happened, and its only recorded
   reason was later cured) could render a `blocker` message that looked exactly like the unrelated
   true iteration-limit disposition.

## Fix

All changes are in `app/lib/shopify/agentic-runtime/recommendation-agent.server.js`.

### 1. Structural "wasted-turn refund" (the core fix, items 1 & 2)

A small, hard-capped counter (`MAX_WASTED_TURN_REFUNDS`, currently 3 — see "Iteration limit" below)
that does **not** advance the iteration counter for a turn that produced zero new evidence:

- **Pattern 1 — premature terminal status.** In each of the three terminal branches
  (`RECOMMEND_ACTION`, `NO_ACTIONABLE_OPPORTUNITY`, `BLOCKED`), when `validateInvestigation` rejects
  the attempt specifically because no read exists yet (`!investigation.unresolved` — this excludes
  the separate "unresolved coverage family" rejection, which reflects genuinely incomplete work and
  must still cost a turn), the refund fires before `continue`.
- **Pattern 2 — duplicate read after completion.** When a turn's only tool calls resolve as pure
  `ALREADY_AVAILABLE` duplicates (`newWorkThisTurn === 0`) and `investigationState.investigationComplete`
  was already `true` going into that turn, the refund fires.
- Once refunds are exhausted, a repeat of either pattern consumes ordinary budget exactly as before
  this fix — the loop stays bounded either way.

This is intercept-and-redirect, not a parallel recommendation engine: the model is still told
`INSUFFICIENT_INVESTIGATION`/`ALREADY_AVAILABLE` exactly as before; only whether that turn's cost is
charged against the candidate's iteration budget changes.

### 2. Candidate-diagnostics isolation (item 3)

`buildRecommendationDiagnostics` now accepts and honors `ownResultsStartIndex`, scoping
`retrievedOperations`/`shopifyReads` to the current candidate's own turns — matching every other
consumer of `toolResults` in this file. Two of the seven call sites were also missing
`discoveryToolName`/`readToolName` entirely (silently defaulting to the deleted catalog-mode tool
names); fixed alongside.

### 3. Schema-recovery carry-forward (item 4)

`buildInvestigationState`'s `failedReads` now carries `errorCode`/`message` from the same error
detail the gateway already returns (`row.error?.code ?? row.facts?.errorCode`,
`row.error?.message ?? row.message`), not just `operation` (which is `null` for exactly the
structural-failure case that matters). No `ProductVariant.cost`-specific logic — the fix reads
whatever error the gateway already produced for any invalid document.

### 4. `terminalFailureBlocker` fallback string collision (item 5, diagnostic clarity)

The fallback in the final non-terminal-branch return (`terminalFailureBlocker(toolResults,
fallbackScope) ?? "ITERATION_LIMIT"`) is now a distinct sentence
(`"Investigation reached a terminal decision but no specific blocking reason was recorded."`),
no longer colliding with the real `ITERATION_LIMIT` status/disposition value.

## Iteration limit: raised the refund cap from 2 to 3, not `perCandidateIterations`

Per the task's own guidance, the fix targets the wasted turns directly rather than raising the
generic ceiling first. `perCandidateIterations` (4, `candidate-pipeline.server.js`) is unchanged.

The refund cap itself started at 2, based on the design rationale (duplicate-read and
premature-validation are each single mistakes a model should get one or two genuine do-overs for,
not unlimited ones). A live post-fix replay against `jefe-local-store.myshopify.com`
(`post-fix-live-replay-2026-08-26.json`, run `2ac8561b-de78-421f-bd61-bb0c03832404`) showed the
refund mechanism working exactly as designed — candidate `recover-out-of-stock-variants`'s duplicate
read got pinned at the same iteration and freely retried — but the model repeated the identical
duplicate read **5 times** in that one case, 2 more than the original cap of 2 absorbed, so it still
lost the candidate to `ITERATION_LIMIT` with real evidence already in hand and no turn left for a
terminal decision. Raised the cap to 3, which would have fully rescued this observed case (2
consumed instead of 3, leaving one real iteration free for the terminal decision). The loop remains
bounded regardless of the cap value — a model that keeps repeating past it still exhausts ordinary
budget and terminates safely (see "Bounded failure" test).

## Tests

New file `tests/recommendation-turn-waste-fix.test.mjs` (8 tests): duplicate read progression,
validation prerequisite (plus a direct check that an unresolved-coverage rejection is never
refunded), candidate isolation, schema recovery, completed-work carry-forward, and two bounded-failure
tests (a candidate that only ever duplicates, and one that never produces any tool call).

Three pre-existing tests asserted exact LLM call counts that were true only in the pre-fix runtime
(a premature/duplicate turn always cost a real iteration) — updated to reflect the new, intentional
behavior, with two of them also made robust to *how many* calls get refunded (branching on a plain
call counter instead of `payload.iteration`, which the refund mechanism can now repeat across calls):
`tests/agentic-shopify-runtime.test.mjs`, `tests/recommendation-iteration-limit-fallback.test.mjs`,
`tests/recommendation-repair-loop-fairness.test.mjs`. No existing assertion was weakened — only
call-count expectations that the refund mechanism deliberately changes.

Full regression sweep: 223/223 across every recommendation-agent/candidate-pipeline/gateway-safety
suite touching the changed files (zero regressions). Full repo suite: 2037/2041 pass; the 4 failures
are pre-existing and unrelated to this change (1 documented baseline failure in
`fast-onboarding.test.mjs`/`learning-progress.server.js`, 3 in the uncommitted/prior
Home/Action-Chat redesign UI-wiring tests — confirmed via `git diff --stat`, this task touched none
of those files). `npx eslint` clean on every touched file. `npx tsc --noEmit -p .` diffed against the
recorded clean baseline (`.context/evidence/tsc-baseline-clean.log`, line/column-normalized): zero
new errors.

## Real replay: pre-fix vs post-fix

Pre-fix (`pre-fix-persisted-trace-run-ff109274.json`): `reduce-product-specific-returns` and 3 other
candidates all terminated `BLOCKED_BY_EVIDENCE` with `reason: "ITERATION_LIMIT"` after the exact
validate-before-read → read → duplicate → duplicate pattern.

Post-fix (`post-fix-live-replay-2026-08-26.json`, run `2ac8561b-de78-421f-bd61-bb0c03832404`, real
OpenAI calls against `jefe-local-store.myshopify.com`, fresh discovery — the prior opportunity set had
already been exhausted investigating candidates in this same session): 10 fresh candidates discovered.
Direct evidence the fix landed:

- `capture-product-margin-data`, `increase-cross-sell-and-basket-size`, `resolve-stale-inventory-signal`
  all reached a genuine terminal judgement backed by real evidence — none hit the old duplicate-read
  spiral.
- The fixed diagnostic-clarity fallback string
  (`"Investigation reached a terminal decision but no specific blocking reason was recorded."`) is
  visible live for 3 candidates, confirming that fix is in effect.
- `recover-out-of-stock-variants`'s raw tool trace shows the refund mechanism operating exactly as
  designed (three `ALREADY_AVAILABLE` rows tagged at the same `iteration: 1`, proving the pin-and-retry
  behavior is real, not just unit-tested) — see "Iteration limit" above for why this specific
  candidate still lost to an unusually persistent 5x repeat, and why the cap was raised in response.
- `activate-draft-products` still hit `ITERATION_LIMIT` via a different, unaddressed pathology: zero
  tool calls across every turn (a model producing content-free `CONTINUE` turns) — this is not the
  duplicate-read or premature-validation pattern this fix targets; see "Remaining genuine reasons"
  below.
- The run overall ended `no_actionable_opportunity` because the separate, pre-existing
  *total-run* LLM call ceiling (`maxTotalLlmCalls`, distinct from the per-candidate iteration limit)
  was reached at candidate 8 of 10 (`llmCallCount: 43`), leaving 2 candidates `QUEUED` and unattempted
  — not because the fixed candidates failed to converge.

Note on process: the opportunity set active at the start of this task had already been exhausted by
the pre-fix investigation captured in `pre-fix-persisted-trace-run-ff109274.json`, so a direct
same-candidate pre/post comparison against a live store wasn't possible; the pre-fix trace is a real
persisted run against the same store, and the post-fix trace is a real live run against the same
store immediately following, with a fresh discovery pass (its active opportunity set's `expiresAt`
was manually reset to force rediscovery — a local-dev-DB-only, reversible action).

## Remaining genuine reasons this store can still return `NO_ACTIONABLE_OPPORTUNITY`

1. Real evidence gaps that are not runtime bugs: `capture-product-margin-data` is genuinely blocked
   because Shopify has no cost-per-item data and Merchant Memory provides none either — populating it
   would mean guessing financial data.
2. No safe/reversible Shopify write exists for the diagnosed problem (e.g. no storefront/customer
   identity-capture mutation, no confirmed replenishment-quantity source for inventory writes).
3. A model producing genuinely empty (`CONTINUE`, zero tool calls) turns for its entire budget —
   observed live in `activate-draft-products`. This is a different failure mode from the two this fix
   targets (there is no deterministic "wasted" signal to refund against — an empty turn isn't
   provably non-productive the way a duplicate read or a pre-rejected validation attempt is) and
   remains an open, real reason a candidate can still exhaust its budget without a bug in this fix.
4. The separate total-run LLM call ceiling can still end a run before every discovered candidate is
   attempted — unrelated to per-candidate convergence, unchanged by this fix.

## What was not changed

`perCandidateIterations`, candidate discovery/ranking, Merchant Memory, Gateway architecture, the
Shopify read-only enforcement during recommendation generation, execution-semantic/real-operation-name
validation, evidence requirements, recommendation novelty/duplicate protections, the Home/Action Chat
UI, and the total-run LLM call ceiling.
