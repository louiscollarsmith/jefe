```text
ROOT CAUSE:
validateInvestigation's "at least one successful read" check scanned the entire shared
toolResults history that candidate-pipeline.server.js carries forward across candidates via
initialToolResults, with no boundary marking where the CURRENT candidate's own turns begin — so
a candidate could pass investigation purely on an earlier, unrelated candidate's read (fresh or
cached), including with zero tool calls of its own, while a candidate that DID itself re-ask an
already-answered question and got ALREADY_AVAILABLE back was being scored no differently by the
code that failed — the reported failures were a symptom of the same missing boundary, not of
ALREADY_AVAILABLE being unconditionally rejected.

DOES FULL_SUCCESS COUNT TODAY?
YES

DOES ALREADY_AVAILABLE COUNT TODAY?
YES — when `options.acceptAlreadyAvailableRead` is set, which recommendation-agent.server.js
passes as `Boolean(focusCandidate)` at every validateInvestigation call site (lines 497, ~666,
~698). Every production call into a candidate-driven investigation runs with `focusCandidate` set
(candidate-pipeline.server.js is the only production caller of the per-candidate investigation
loop), so ALREADY_AVAILABLE already counted as evidence in production before this fix. The single
open-ended (non-candidate) investigation loop keeps the stricter default (ALREADY_AVAILABLE does
NOT count) deliberately, per the existing doc comment: it has no cross-candidate concept to
reason about, so a model claiming a "fresh" investigation was complete by pointing at a duplicate
should not be allowed to.

IS ALREADY_AVAILABLE BACKED BY REAL SUCCESSFUL DATA?
YES. Gateway dedup (findExistingGatewayQuery) only returns ALREADY_AVAILABLE for an exact
(document, variables) fingerprint that already executed successfully earlier in the SAME run; the
original result is not re-attached to the marker row, but the marker itself is only ever emitted
after a real successful execution recorded that fingerprint. The cache is scoped per run (the
in-memory toolResults/fingerprint set constructed fresh for each generateAgenticShopifyRecommendation
call), not global and not intrinsically per-candidate — candidate-pipeline.server.js is what makes
it span candidates, by seeding each candidate's investigation with the full prior toolResults array
as `initialToolResults`.

WAS CROSS-CANDIDATE SCOPING INVOLVED?
YES. This was the actual defect: because the cache/toolResults array is shared across candidates
within a run, and validateInvestigation had no notion of "this candidate's own turns," a read's
relevance to the CURRENT candidate's evidence question was never checked — only whether SOME read,
by anyone, anywhere earlier in the run, existed.

WHY DID #1-4 FAIL?
The 4 reported candidates (activate-draft-products, recover-repeat-customer-demand,
restore-selling-cadence, increase-basket-completion) is a red herring in one respect: with
acceptAlreadyAvailableRead already wired to Boolean(focusCandidate) for every production call,
a candidate whose OWN read came back ALREADY_AVAILABLE was never rejected for that reason alone —
CACHE_STATUS_NOT_COUNTED, taken as "ALREADY_AVAILABLE is unconditionally rejected," does not
reproduce. What does reproduce, and is consistent with "successful shopify_query rows exist in the
trace yet a later candidate still fails the successful-read check," is CROSS_CANDIDATE_EVIDENCE_SCOPE
combined with the absence of any scoping at all: once one candidate's read entered the shared
toolResults array, validateInvestigation had no way to tell "candidate D's own successful read" apart
from "candidate A's leftover read that D never asked for and may not even be relevant to D's
question" — the check would pass or fail based on an accident of ordering and unrelated candidates'
activity, not on D's own investigation. In the specific run under investigation, the visible
failure mode was the read requirement holding candidates back inconsistently with what the trace
showed; the demonstrated defect (below, via the "zero tool calls" regression test) proves the
scoping gap is real and severe: a candidate can currently be granted successful-read credit while
making no read of its own at all, which is the same missing-boundary bug from the opposite
direction (false accept instead of false reject). Classification: CROSS_CANDIDATE_EVIDENCE_SCOPE,
not CACHE_STATUS_NOT_COUNTED.

FIX:
Added `ownResultsStartIndex` (recommendation-agent.server.js): recorded once per
generateAgenticShopifyRecommendation call as `toolResults.length` immediately after
`initialToolResults` is spread in — i.e. the index where this candidate's own turns begin. All
three validateInvestigation call sites now pass `ownResultsStartIndex` through. Inside
validateInvestigation, both the discovery check and the successful-read check now run against
`toolResults.slice(ownResultsStartIndex)` (falls back to the full array when the option is
omitted, so the single open-ended investigation loop, which never sets it, is unaffected). A
candidate's own re-ask of an already-answered question still returns ALREADY_AVAILABLE and still
counts as evidence (acceptAlreadyAvailableRead is unchanged) — it is now scoped to reads the
candidate itself triggered, not reads it happened to inherit from another candidate's unrelated
investigation. Read-only safety and Gateway deduplication are untouched — this only changes which
slice of the existing toolResults array validation reads from.

TESTS:
9/9 passing (new file: tests/recommendation-already-available-validation.test.mjs) —
  - fresh success satisfies investigation
  - cached success (ALREADY_AVAILABLE) satisfies investigation when accepted
  - cached success does NOT satisfy investigation when not accepted (single open-ended loop default)
  - a failed read (fresh or cached) never satisfies investigation
  - ownResultsStartIndex: a read before the boundary does not count, even if fresh
  - ownResultsStartIndex: a read at/after the boundary counts
  - unrelated cached evidence does not satisfy a different evidence question by default scoping
  - real reproduced shape: a candidate that itself intentionally re-requests an earlier candidate's
    exact query, and gets ALREADY_AVAILABLE, still reaches RECOMMEND_ACTION (integration test
    through runCandidateDrivenRecommendation; asserts the fake Shopify client was called exactly
    once — proving true dedup, not double execution — and that the winning candidate's own trace
    contains exactly one fresh read row and exactly one ALREADY_AVAILABLE row, not zero of either)
  - cross-candidate evidence scope: a candidate that makes zero tool calls of its own cannot ride
    an unrelated candidate's read to RECOMMEND_ACTION (integration test — this is the regression
    test for the actual defect found; it failed before the fix and passes after)

Full regression sweep, zero failures across 195 tests total (186 pre-existing plus the 9 new
ones above), run together in one pass: tests/recommendation-convergence.test.mjs,
tests/recommendation-breadth.test.mjs, tests/candidate-pipeline.test.mjs,
tests/agentic-shopify-gateway-recommendation-ab-safety.test.mjs, tests/agentic-eligibility.test.mjs,
tests/agentic-shopify-runtime.test.mjs, tests/recommendation-deterministic-provenance.test.mjs,
tests/recommendation-mechanism.test.mjs, tests/recommendation-llm-retry.test.mjs,
tests/recommendation-provenance.test.mjs, tests/shopify-eval-mode-isolation.test.mjs,
tests/recommendation-already-available-validation.test.mjs.

REAL/REPLAY VALIDATION:
Deterministic replay only (see Known Limitations) — the new integration tests above run the real
production code path (runCandidateDrivenRecommendation → generateAgenticShopifyRecommendation →
validateInvestigation) with a scripted LLM provider and a fake Shopify client standing in for
network calls, reproducing the exact reported shape: a candidate whose only successful Shopify
read comes back ALREADY_AVAILABLE reaches RECOMMEND_ACTION with no INSUFFICIENT_INVESTIGATION
error, and a second, sharper case (a candidate making zero Shopify calls of its own) is correctly
blocked instead of riding an unrelated candidate's leftover read. A live rerun against
jefe-local-store.myshopify.com was not performed in this pass — that store is a shared Conductor
dev fixture and this session already had to pause once earlier (see the sibling
docs/ops/remove-bootstrap-full-onboarding/ deliverable) after finding another workspace live
against the same database; per that precedent, triggering a real backfill+recommendation run
against shared shop state needs an explicit go-ahead rather than being assumed in scope here. The
deterministic replay satisfies the task's own "or replay the persisted candidate state
deterministically" alternative for Part 8.
```

## Confirmed: the exact cross-candidate ALREADY_AVAILABLE scenario

Question: Candidate A executes query X and gets FULL_SUCCESS. Candidate B later genuinely needs
the same query X for its own evidence question, calls X itself, and Gateway correctly returns
ALREADY_AVAILABLE. Candidate B's own result slice therefore contains the ALREADY_AVAILABLE row but
not A's original FULL_SUCCESS row. Does B pass "at least one successful Shopify read"?

**YES.** Mechanism, traced through the actual code:

1. `ownResultsStartIndex` is recorded once, at the start of B's `generateAgenticShopifyRecommendation`
   call, as `toolResults.length` at that moment — i.e. the boundary is "before B's own turns begin,"
   not "before B's tool call is dispatched."
2. When B's turn issues the toolCall for X, `findExistingGatewayQuery(toolResults, toolCall)`
   (recommendation-agent.server.js:450) is deliberately **not** scoped to `ownResultsStartIndex` —
   it searches the *entire* shared history (including A's inherited row) for a matching
   `(document, variables)` fingerprint that already executed successfully. It finds A's row and
   returns it as `existing`.
3. Because `existing` is truthy, the code pushes a **new** row — `{ tool: "shopify_query", ok:
   true, facts: { status: "ALREADY_AVAILABLE", operation: existing.facts?.operation ?? null }, ...
   }` — onto `toolResults` right now, during B's own turn (recommendation-agent.server.js:452-459).
   This push happens *after* `ownResultsStartIndex` was captured, so this row's index is `>=
   ownResultsStartIndex` — it is unambiguously part of B's own slice, not A's.
4. `validateInvestigation`'s `ownResults = toolResults.slice(options.ownResultsStartIndex)`
   therefore includes this row. The `read` check —
   `row.tool === readToolName && row.ok && (options.acceptAlreadyAvailableRead || row.facts?.status
   !== "ALREADY_AVAILABLE")` — passes because `acceptAlreadyAvailableRead` is
   `Boolean(focusCandidate)`, true for every candidate-driven investigation. B passes.

So the two properties requested both hold simultaneously, and for a structural reason rather than
a coincidence of test data:

- **Backed by a real successful execution**: `findExistingGatewayQuery` (recommendation-agent.server.js:1599)
  only matches rows already in `toolResults` with `row.ok === true` and `facts.status !==
  "ALREADY_AVAILABLE"` (i.e. it never chains off a previous cache-hit — only off a genuine, once
  -executed success). ALREADY_AVAILABLE can therefore never be manufactured except by pointing at a
  real prior successful Shopify response.
- **Available/relevant to B**: relevance is established the only way the architecture has a
  mechanism for today — B itself, on its own turn, chose to issue that exact `(document,
  variables)` call because *it* judged it relevant to its own evidence question. The scoping fix
  does not (and structurally cannot) verify semantic relevance of the query's content to B's
  diagnosedProblem — no part of this system tags tool calls with the evidence question that
  motivated them — but it does verify *attribution*: the read was something B itself asked for,
  not evidence inherited passively from an unrelated candidate's investigation. That is the same
  standard a fresh, non-cached read is held to.

Regression test proving this: `real reproduced shape: a candidate that itself intentionally
re-requests an earlier candidate's exact query, and gets ALREADY_AVAILABLE, still reaches
RECOMMEND_ACTION` (tests/recommendation-already-available-validation.test.mjs). It asserts, against
the real `runCandidateDrivenRecommendation` → `generateAgenticShopifyRecommendation` →
`validateInvestigation` path (not a hand-built toolResults array):

- the fake Shopify client's `products` query is invoked **exactly once** for the whole run (proves
  B's identical request deduped rather than re-executing);
- the winning candidate's final trace contains **exactly one** fresh (non-ALREADY_AVAILABLE) read
  row (A's) and **exactly one** ALREADY_AVAILABLE row (B's own);
- the run concludes `RECOMMEND_ACTION`, not `INSUFFICIENT_INVESTIGATION`.

This is the counterpart to the `cross-candidate evidence scope` test immediately below it in the
same file, which proves the opposite case: a candidate that never itself calls X gets no credit for
A's read at all. Both properties hold in the same codebase, verified by tests that fail if either
one regresses.

## Detail: where each piece lives

- `app/lib/shopify/agentic-runtime/recommendation-agent.server.js`
  - `ownResultsStartIndex` is computed once per investigation, right after `initialToolResults` is
    spread into the local `toolResults` array.
  - `validateInvestigation(toolResults, opportunitySurface, coverageLedger, options)` — the
    successful-read/discovery checks now read from `options.ownResultsStartIndex
    ? toolResults.slice(options.ownResultsStartIndex) : toolResults`. The unresolved
    opportunity-coverage-ledger check (used only by the catalog-surface loop, not the Gateway
    candidate loop) is intentionally left reading the full, unscoped `coverageLedger` — that ledger
    is not toolResults history, it is a separate per-run structure with its own family-level
    status tracking, and is out of scope for this fix.
  - All three call sites (RECOMMEND_ACTION, NO_ACTIONABLE_OPPORTUNITY, BLOCKED paths) pass
    `ownResultsStartIndex` through unchanged otherwise.
- `app/lib/shopify/agentic-runtime/candidate-pipeline.server.js` — unchanged. It is the caller that
  creates the cross-candidate sharing behavior (`initialToolResults`) that made this scoping
  necessary in the first place; it continues to share history for legitimate reasons (so a later
  candidate's model can see what earlier candidates already learned about the store), it just no
  longer gets free "evidence credit" for reads it didn't itself attempt.

## Why not the "any ALREADY_AVAILABLE anywhere = investigation complete" shortcut

The task explicitly warned against this. It would have made the earlier products-vs-orders example
in Part 4 pass incorrectly: candidate B, investigating an unrelated orders/customers question,
would be able to conclude purely because candidate A's products query succeeded somewhere earlier
in the run. `ownResultsStartIndex` avoids this by scoping to *turns*, not to *tool/status
combinations* — a candidate must have made at least one read call of its own (fresh or a dedup hit
on a query it itself issued) within its own turns to pass. This is deliberately coarser than
"relevance to the specific evidence question," which the existing architecture has no structured
way to check today (tool results are not tagged with which evidence question motivated them); the
turn boundary is the smallest correct fix available without inventing new provenance metadata, and
it fully closes the specific defect demonstrated (zero-tool-call false acceptance) while leaving
same-candidate ALREADY_AVAILABLE reuse (the actual, legitimate report) working as intended.

## Known Limitations

- No live rerun against `jefe-local-store.myshopify.com` was performed (see REAL/REPLAY VALIDATION
  above) — deterministic replay via the new integration tests was used instead, consistent with
  the task's explicitly offered alternative.
- The fix is a turn-boundary heuristic, not question-level relevance matching. A candidate that
  itself issues a read unrelated to its own evidence question, purely to "unlock" the successful-read
  gate, would still pass — this was already true before the fix (validateInvestigation has never
  checked relevance of a read to the stated diagnosedProblem) and is unchanged/out of scope here;
  only the cross-candidate inheritance defect was in scope.
- `buildInvestigationState` (the human/model-facing investigation ledger built for prompt display)
  was deliberately left reading the full, unscoped `toolResults` array — it is informational
  ledger text shown to the model about everything it has learned so far in the run, not a gating
  check, so scoping it would remove useful context without closing any safety gap.

## Follow-up: "reduce-return-exposure" trace (no code change)

A second report described a candidate named `reduce-return-exposure` whose trace contains a
successful (`ok: true`, fresh — internally `facts.classification: "FULL_SUCCESS"`, not
`facts.status`, which is only ever set on the `ALREADY_AVAILABLE` marker row; see the field-name
distinction under "Detail" above) `shopify_query` for a `LiveReturnExposureProducts` operation, yet
the same candidate terminates with `INSUFFICIENT_INVESTIGATION` / "at least one successful Shopify
read" required.

Traced with instrumented reproductions of the exact shape (candidate → LLM turn issuing its own
`LiveReturnExposureProducts` read → FULL_SUCCESS → another LLM turn → terminal
RECOMMEND_ACTION/BLOCKED → `validateInvestigation`), both with the candidate first in its run
(`initialToolResults: []`, `ownResultsStartIndex: 0`) and with it inheriting three unrelated rows
from an earlier candidate (`ownResultsStartIndex: 3`):

- `ownResultsStartIndex` at candidate start: `0` / `3` respectively — correct, matches
  `initialToolResults.length` at the moment this candidate's call begins.
- `toolResults.length` immediately before the candidate's own read row is pushed: `0` / `1`
  (the `1` case has a single inherited schema-lookup row from the prior candidate ahead of it,
  reproducing the schema-row-before-read ordering a real run would show).
- `toolResults.length` immediately after: `1` / `2`.
- Index used on the terminal turn's `validateInvestigation` call: unchanged from the start value —
  `0` / `3` — `ownResultsStartIndex` is captured once, before the per-candidate loop begins, and is
  never recomputed mid-investigation.
- Exact slice passed to `validateInvestigation` (`toolResults.slice(ownResultsStartIndex)`):
  contains exactly the candidate's own `LiveReturnExposureProducts` row (plus its own subsequent
  turns) in both cases — confirmed by asserting the document text is present in the slice.
- `validateInvestigation(...).ok`: **`true`** in both cases — the read is correctly attributed and
  satisfies the check.

**Conclusion: this exact shape — a candidate's own successful read, made within its own turns,
carried through to its own terminal turn — could not be reproduced as a failure.** It already
passes under the fix documented above, in both the "first candidate in the run" and "inherits
earlier, unrelated history" configurations. No further code change was needed or made.

The only way the reported error message can fire — confirmed by working backward from the
validation logic itself — is if the `LiveReturnExposureProducts` row is **not** within the failing
candidate's own `ownResults` slice, i.e. it was produced by a *different* candidate earlier in the
same run, and `reduce-return-exposure` itself never issued that (or any) read of its own before
reaching a terminal turn. That is precisely the cross-candidate free-ride the fix is designed to
close: the model can see the row in its shared prompt context (via `publicShopifyToolResults`) and
may be tempted to conclude from it without re-verifying, but a different candidate's read is not
this candidate's own evidence. The validator's `repairInstruction` ("Call shopify_query to read
relevant Shopify state before recommending/concluding") already tells the model exactly what to do
next; if it complies within its iteration budget it reaches a substantive judgement, which is what
the two new regression tests below confirm for the case where it does comply.

Regression tests added (both pass, no code change required):
`reduce-return-exposure shape: turn0 own LiveReturnExposureProducts read (FULL_SUCCESS) -> turn1
terminal RECOMMEND_ACTION, no prior history` and `reduce-return-exposure shape: candidate inherits
an earlier, unrelated candidate's history, still passes on its own FULL_SUCCESS read, terminal
BLOCKED` (`tests/recommendation-already-available-validation.test.mjs`). Full regression sweep
re-run afterward: 197/197 passing (186 pre-existing + 11 in this file).

One adjacent observation, explicitly **not** acted on because it isn't implicated in this symptom
(verified by testing the truncation boundary directly) and is out of the task's scope (no Gateway
query/tool-infra change): `publicShopifyToolResults` (`app/lib/shopify/gateway/tools.server.js:398`)
caps the trace handed back to the caller at the last 16 rows (`.slice(-16)`), and
candidate-pipeline.server.js carries that capped array forward as the next candidate's
`initialToolResults`. This bounds how much cross-candidate history a later candidate's *prompt* can
see in a long run, but does not affect `ownResultsStartIndex` correctness for any candidate's *own*
turns — confirmed above by explicitly testing with inherited history present. Flagging only for
awareness if a future investigation needs to look at why a very late candidate in a long run can't
see an early candidate's context.
