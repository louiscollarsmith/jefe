# Part 15 — Remaining limitations

## 1. The `validateInvestigation` bug (found and fixed this session)

Two of three `validateInvestigation` call sites inside `generateAgenticShopifyRecommendation`
(reached on `NO_ACTIONABLE_OPPORTUNITY` and `BLOCKED`, not just `RECOMMEND_ACTION`) were still
hardcoded to the catalogue's tool names when first wired. Consequence: every gateway-mode candidate
that concluded anything other than `RECOMMEND_ACTION` was misreported as `INVESTIGATION_FAILED`
with the message "Recommendation decisions require at least one Shopify operation retrieval and
one successful Shopify read" — regardless of whether real, successful `shopify_query` reads had
actually happened. This was caught by inspecting the first A/B run's raw trace (all 8 gateway
candidates showed this exact catalog-worded message despite the run's own summary counting 6
successful reads), not by a pre-written test — the tests that would have caught it
(`agentic-shopify-gateway-recommendation-ab-safety.test.mjs` tests 7 and 8) were written *after*
finding the bug, specifically to cover it. Fixed; the A/B was re-run post-fix, and the numbers in
this report are all from that second run. This is worth stating plainly: **the first A/B run's
results were not usable and are not reported here** (both trace files were overwritten by the
re-run; the pre-fix gateway trace is preserved only at `/tmp/trace-gateway-run1.json` outside the
repo, for engineering reference, not as reportable evidence).

## 2. Redundant read execution due to imprecise dedup fingerprinting

`findExistingGatewayQuery` fingerprints on raw, trimmed document text. Since the model regenerates
GraphQL text fresh each turn rather than reusing a literal prior string, two semantically identical
queries can fail to match if their incidental formatting differs — observed directly in the A/B run
(the corrected query executed 3 times instead of being served from cache after the first success).
Not a safety issue: each execution is still independently validated and ledgered. Fix: fingerprint
on the `print(parse(document))`-normalized form (already computed once per call inside
`analyzeGatewayDocument` as `normalizedDocument`) rather than the model's raw pre-validation text —
straightforward, not done this session due to time.

## 3. The stub-binding relevance-search gap is a catalogue-mode issue this task surfaced, not fixed

`13-candidate-quality-comparison.md` documents a real, reproduced false negative: the catalogue
path's server-side capability-binding search missed `collectionCreate`/`collectionAddProducts` for
a candidate about multi-product merchandising, because of keyword-relevance ranking against a
top-8 cap. This is a pre-existing property of `retrieveShopifyApiOperations`/the catalogue's
binding step, not something this task's changes caused — but it was discovered *because of* this
task's A/B methodology. Not fixed here (out of this task's scope — it's catalogue-path code, and
the brief's restriction is specifically about not redesigning candidate discovery/ranking/binding).
Worth a dedicated follow-up regardless of which surface Jefe ultimately prefers.

## 4. `shopify_schema`'s object-type coverage gap (carried over from the prior session)

Unchanged from `docs/ops/agentic-shopify-gateway/13-known-limitations.md`: `inspect_field` only
resolves root Query/Mutation field names, not arbitrary object types (`Product`, `ProductVariant`,
...). Not exercised in this session's A/B run (0 schema lookups), but real in the prior session's
run and not addressed here.

## 5. n=1 per surface

Stated throughout this report: one real run each. Sufficient to prove the integration is
mechanically sound, safe, and capable of producing a materially different (and in this instance,
better-grounded) real outcome — not sufficient to establish a durable quality edge in either
direction. See `16-strategic-recommendation.md` for how this shapes the recommendation.

## 6. Diagnostics-object gateway-awareness was retrofitted, not designed in from the start

`buildRecommendationDiagnostics`'s `retrievedOperations`/`shopifyReads` fields were still hardcoded
to catalog tool names when first observed: the reported A/B run's own `trace-gateway.json` shows
`result.diagnostics.shopifyReads: []` and `retrievedOperations: []` despite 4 real
`shopify_query` calls (3 successful) actually happening in that same run — a reporting-only gap,
the actual investigation-gate logic (`validateInvestigation`, already fixed) was unaffected by it.
Fixed with the same parametrization pattern used elsewhere in this file, **after** the reported A/B
run had already completed — so the fix is verified by a dedicated unit test
(`agentic-shopify-gateway-recommendation-ab-safety.test.mjs`, "a real read through shopify_query
reaches RECOMMEND_ACTION," which now asserts `result.diagnostics.shopifyReads.length === 1`) rather
than by re-inspecting real trace data. A third live run would confirm it end-to-end but wasn't run
this session (diminishing evidentiary value against LLM cost for a fix already covered by a passing
targeted test). Indicates the same class of "hardcoded tool name" oversight existed in more places
than the three `validateInvestigation` sites — worth a broader audit before wiring the gateway into
any further call site (execution-agent, verification-agent, action-chat).
