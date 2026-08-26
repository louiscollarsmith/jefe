## Objective

Instrument a recommendation run so every `toolResult` is attributable to the candidate and
iteration that produced it, trace exactly what happens after a candidate fails the
`validateInvestigation` successful-read requirement, determine why the repair instruction wasn't
resulting in the candidate calling its own `shopify_query`, and fix the repair/continuation loop
if it wasn't giving the model a fair chance to comply — **without changing the successful-read
rule itself** (`validateInvestigation`, from `docs/ops/recommendation-already-available-validation-fix/`,
is untouched by this change).

## Instrumentation added

Every `toolResults.push(...)` call inside `generateAgenticShopifyRecommendation`
(`app/lib/shopify/agentic-runtime/recommendation-agent.server.js`) now goes through a
`tagToolResult(row, iteration)` helper that stamps `candidateId` (the focus candidate's id, or
`null` for the open-ended non-candidate loop) and `iteration` (the loop counter at push time) onto
every row — the discovery/read dispatch rows, the `ALREADY_AVAILABLE` dedup marker, the
`RETRIEVAL_ALREADY_SUFFICIENT` guard row, and every `recommendation_validation` failure row. These
tags survive into the persisted/returned trace: `publicShopifyToolResults`
(`app/lib/shopify/gateway/tools.server.js`) now preserves `candidateId`/`iteration` instead of
stripping them, and `buildRecommendationDiagnostics`'s `shopifyReads` list carries them too (that
list's `status` field was also silently always `undefined` for fresh reads — it read
`facts.status`, which is only ever set on the `ALREADY_AVAILABLE` marker; fixed to fall back to
`facts.classification`, the field a real dispatch actually sets — a small, directly-related
correctness fix made while touching this exact line for the requested instrumentation).

## Traced: what happens after INSUFFICIENT_INVESTIGATION

Using the new tags plus a scripted-provider reproduction through the real
`runCandidateDrivenRecommendation` → `generateAgenticShopifyRecommendation` path (two candidates;
the first candidate's own successful `orders` read is inherited by the second, `reduce-return-exposure`,
via `initialToolResults` — the same shape as the real run investigated previously), the six-stage
chain for a candidate that fails the successful-read requirement is:

1. **Candidate terminal output** — the model declares a terminal status (`RECOMMEND_ACTION`,
   `NO_ACTIONABLE_OPPORTUNITY`, or `BLOCKED`) with no tool calls attached.
2. **Validation error** — `validateInvestigation` (already correctly scoped to
   `ownResultsStartIndex` from the prior fix) finds no read within this candidate's own turns and
   returns `{ ok: false, error: "Recommendation decisions require at least one successful Shopify
   read (shopify_query)." }`. A `recommendation_validation` row is pushed with
   `errorCode: "INSUFFICIENT_INVESTIGATION"` and `repairInstruction: "Call shopify_query to read
   relevant Shopify state before recommending/concluding."`, and the loop `continue`s.
3. **Repair prompt sent to Luna** — the *next* iteration's prompt is built from
   `buildInvestigationState(toolResults, {...})`. **This is where the bug lived.** Before this fix,
   this call was never scoped to `ownResultsStartIndex`, so it recomputed `investigationComplete`
   and `doNotRepeat` over the *entire* shared history — including the inherited candidate's
   successful read. Measured directly (see Tests below): for a candidate that inherited one
   unrelated prior candidate's successful read, `buildInvestigationState` reported
   `investigationComplete: true` and `doNotRepeat: "Minimum Shopify investigation complete. Do not
   repeat shopify_schema or shopify_query calls for resources already covered unless you need a
   genuinely different resource, query, or page."` — **in the same prompt as** the just-pushed
   `lastValidationError.repairInstruction: "Call shopify_query to read relevant Shopify state
   before recommending."** Those two instructions directly contradict each other.
4. **Luna's next response / tool call or no tool call** — a model that resolves the contradiction
   by trusting `doNotRepeat` (a reasonable reading — it's phrased as an explicit, unconditional
   instruction, not a hint) declines to call `shopify_query` and re-declares a terminal status
   using only the inherited, irrelevant evidence. That produces a **second**
   `recommendation_validation` / `INSUFFICIENT_INVESTIGATION` row, identical to the first, and the
   contradiction repeats verbatim on the following iteration too, since nothing about the ledger
   changed.
5. **Remaining iteration budget** — with `perCandidateIterations` defaulting to 4
   (`candidate-pipeline.server.js`), a candidate that spends even one iteration on discovery before
   its first terminal attempt, then repeats the contradictory non-compliant pattern, can exhaust
   its entire budget without ever issuing its own `shopify_query` call — not because it lacked
   iterations to comply, but because every remaining iteration handed it the same contradictory
   instruction.
6. **Final result** — the per-candidate loop exits via the post-loop fallback
   (`terminalFailureStatus`/`terminalFailureBlocker`), returning `status: "INVESTIGATION_FAILED"`
   with the last `INSUFFICIENT_INVESTIGATION` message as the blocker — exactly the symptom
   originally reported.

## Why the repair instruction didn't result in the candidate issuing its own `shopify_query`

**Because it was competing with a second, contradictory instruction the model had no principled way
to override.** `validateInvestigation` (the actual pass/fail gate) was already correctly scoped to
the candidate's own turns from the prior fix. `buildInvestigationState` (the informational ledger
injected into every prompt, which the model reasonably treats as authoritative — its own doc
comment says exactly that: "This is authoritative — Luna should not infer completed work from the
tool history") was **not** scoped the same way. The gate said "you haven't read yet"; the ledger
said "you're done, don't call it again." This is not a prompt-wording problem (out of scope to
change per the task) — it's a data problem: the ledger and the gate were computing "is this
candidate's investigation complete" from two different slices of the same array.

## Fix

Scoped `buildInvestigationState` to the same `ownResultsStartIndex` boundary
`validateInvestigation` already uses, and added an `acceptAlreadyAvailableRead` option so the
ledger's notion of "complete" matches the gate's exactly (an own-turn `ALREADY_AVAILABLE` read now
counts toward `investigationComplete`, just as it counts toward `validateInvestigation`'s pass —
previously the ledger only counted fresh reads, a second, smaller inconsistency in the same
direction). Both call sites in `generateAgenticShopifyRecommendation` (the per-turn prompt-build
call and the post-tool-call, pre-semantic-repair call) now pass `ownResultsStartIndex` and
`acceptAlreadyAvailableRead: Boolean(focusCandidate)`, mirroring `validateInvestigation`'s own call
sites exactly. Result: a candidate that hasn't yet read anything of its own is now *always* shown
`investigationComplete: false, doNotRepeat: null` — there is no longer any signal telling it not to
call `shopify_query`, so the repair instruction (once it fires) is the only guidance in the room and
a compliant model has a clear, unambiguous next step. `validateInvestigation` itself, and its
pass/fail semantics, are byte-for-byte unchanged.

This does **not** guarantee compliance — a model that ignores a repair instruction for reasons
unrelated to a ledger contradiction (e.g. genuinely stubborn behavior) still fails, correctly, after
exhausting its budget. What the fix removes is the *structural* reason a reasonable model would
decline: it no longer has two instructions to weigh, only one.

## Tests

6 tests, all passing (`tests/recommendation-repair-loop-fairness.test.mjs`):

- `buildInvestigationState: unscoped (pre-fix shape), a candidate inheriting an unrelated prior
  read is wrongly told investigation is complete` — reproduces the exact contradiction on the
  historical (no-`ownResultsStartIndex`) call shape: `investigationComplete: true`,
  `doNotRepeat` set.
- `buildInvestigationState: scoped to ownResultsStartIndex, the same inherited history does not
  falsely claim completeness` — same input, fixed call shape: `investigationComplete: false`,
  `doNotRepeat: null`.
- `buildInvestigationState: an own-turn ALREADY_AVAILABLE read counts toward completeness when
  acceptAlreadyAvailableRead is set` — aligns the ledger with `validateInvestigation`'s actual bar.
- `second candidate inheriting the first candidate's history sees no doNotRepeat contradiction and
  calls its own read on turn 0` — full integration test through
  `runCandidateDrivenRecommendation` with a "realistic" scripted model that reads `doNotRepeat`
  literally; reaches `RECOMMEND_ACTION`, and asserts every persisted `shopify_query` row carries a
  `candidateId`/`iteration` tag, with each candidate's own read attributed to itself.
- `a candidate that never complies with the repair instruction fails honestly after exhausting its
  own budget, with a consistent (non-contradictory) prompt on every turn` — proves the fix doesn't
  paper over genuine non-compliance: the model gets its full 4-iteration budget, `doNotRepeat` is
  `null` on every turn (no contradiction ever appears), and the run correctly ends
  `NO_ACTIONABLE_OPPORTUNITY` rather than silently accepting an unverified recommendation.
- `generateAgenticShopifyRecommendation tags every toolResult row with the focus candidate's id and
  the iteration it was produced on` — direct instrumentation check.

Plus the existing 11 tests in `tests/recommendation-already-available-validation.test.mjs`
(including its prior "reduce-return-exposure" trace tests, unaffected, still passing) and a full
regression sweep: **298/298 passing** across
`recommendation-repair-loop-fairness`, `recommendation-already-available-validation`,
`recommendation-convergence`, `recommendation-breadth`, `candidate-pipeline`,
`agentic-shopify-gateway-recommendation-ab-safety`, `agentic-eligibility`, `agentic-shopify-runtime`,
`recommendation-deterministic-provenance`, `recommendation-mechanism`, `recommendation-llm-retry`,
`recommendation-provenance`, `shopify-eval-mode-isolation`, `recommendation-gateway-trace-fields`,
`merchant-memory`, `agentic-execution-job`, `agentic-execution-lifecycle`,
`agentic-shopify-gateway-execution-safety`, `agentic-shopify-gateway-verification-safety`,
`agentic-verification-phase`, `wire-listing-copy-execution`. `npm run typecheck` error count
unchanged (99, pre-existing, confirmed via `git stash` diff) — zero regressions.

## What was not changed

- `validateInvestigation`'s pass/fail rule — untouched, per the task's explicit instruction.
- Candidate ranking, Gateway queries, prompts, and the 24h opportunity set — untouched.
- `perCandidateIterations` / the iteration budget itself — not raised. The fix is structural
  (remove the contradiction), not "give it more tries."
- `publicShopifyToolResults`'s `.slice(-16)` trace cap — untouched; noted in the prior deliverable
  as unrelated to attribution correctness, and unaffected by this change.

## Real/replay validation

No live rerun against `jefe-local-store.myshopify.com` — consistent with this session's established
caution around the shared dev store (see `docs/ops/remove-bootstrap-full-onboarding/`). Validated
via deterministic scripted-provider replay through the real, unmodified production control flow
(`runCandidateDrivenRecommendation` → `generateAgenticShopifyRecommendation`), which is what the
integration tests above exercise.

## Follow-up: the tags never reached the database (`safeTrace`)

A live run (`68ad8999-fd59-4e8f-9f01-c3f7e2a43860`) still showed no `candidateId`/`iteration` in its
persisted `result_json.trace.toolResults` after this fix landed in the working tree. Before
diagnosing recommendation behaviour again, traced whether this was a stale-build/hot-reload problem
first — it wasn't: the serving process (`shopify app dev` → `react-router dev`, same continuously-live
process per `/health`'s `uptimeSeconds`) booted *after* the fix files were saved to disk, and the run
ran entirely within that one process's lifetime. No second worker process exists — the backfill loop
runs in the same web process by design (`app/lib/observability/heartbeat.server.js`'s own doc
comment), confirmed via `ps`/`pg_stat_activity` that nothing else was attached to the DB.

The real cause: `safeTrace()` in `recommendation-service.server.js` is a **second, independent trace
reconstruction** that runs at every actual DB-persistence call site (the `no_actionable_opportunity`/
`failed` branch and the `RECOMMEND_ACTION` success branch both wrap `result.trace` in it before
writing `MerchantPlanRun.result`). It rebuilds each row from a fixed key whitelist —
`{tool, ok, message, facts: {query, operation, status, gatewayDecision}, error}` — that predates
`candidateId`/`iteration` and silently dropped both. `publicShopifyToolResults()` was never the
problem; nothing downstream of it preserved what it tagged. This is the same failure shape as the
`facts.document`/`facts.status` gap fixed on 2026-08-25 (`docs/ops/gateway-no-action-forensics-2026-08-25/`)
— a hand-maintained whitelist in `safeTrace` going stale every time the upstream row shape gains a
field it doesn't know about.

**Fix**: `safeTrace`'s row mapper now also emits `candidateId: row.candidateId ?? null` and
`iteration: typeof row.iteration === "number" ? row.iteration : null`, mirroring
`publicShopifyToolResults` exactly. New test
(`tests/recommendation-persisted-trace-attribution.test.mjs`) proves the full chain — tagged row →
`publicShopifyToolResults` → `safeTrace` → persisted shape — retains both fields for `FULL_SUCCESS`,
`ALREADY_AVAILABLE`, and `recommendation_validation` rows, both as a direct unit test on `safeTrace`
and as an integration test through the real `generateAgenticShopifyRecommendation` control flow. No
change to `validateInvestigation`, `buildInvestigationState`, candidate ranking, Gateway queries,
prompts, or the 24h opportunity set.

A fresh run's first persisted `shopify_query` row should now visibly contain `candidateId` and
`iteration` — that's the gate the founder set before evaluating whether the repair-loop fix itself
works in a live run.
