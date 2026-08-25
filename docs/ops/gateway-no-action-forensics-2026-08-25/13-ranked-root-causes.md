# Part 20 — Ranked root causes

Ranked by evidence strength, for this specific verified-Gateway run
(`80553fc7-13d4-4b5a-b151-a82648c949d2`). "Not observed" entries are load-bearing — they rule out
hypotheses the task explicitly wanted checked, not omissions.

1. **Investigation depth / GraphQL evidence quality (dominant, proven).** Two independently-issued
   `products` reads for real, `ACTIVE`, immediately-searchable products returned zero nodes, and the
   model accepted each as conclusive without retrying a different query shape; three further
   candidates then inherited the first empty result via the (correctly-functioning)
   `ALREADY_AVAILABLE` cache without checking it actually answered their own evidence question. This
   alone explains 4 of 6 rejections and this run's `NO_ACTIONABLE_OPPORTUNITY` outcome. Evidence: 04,
   05, 06, 11 (live counter-proof).
2. **Migration-residue observability bug (proven, fixed in this pass).** `safeTrace()`
   (`recommendation-service.server.js`) persisted the old catalog dispatcher's `facts.query`/
   `facts.status` field names and silently dropped the Gateway's actual `facts.document`/
   `facts.classification`, making the exact GraphQL text behind cause #1 unrecoverable from this run's
   database record. Fixed with a 3-case regression test (`recommendation-gateway-trace-fields.test.mjs`);
   does not change recommendation logic. Ranked second because it's the reason cause #1's *exact
   mechanism* (malformed filter vs. wrong field vs. something else) stays open rather than fully
   nailed down. Evidence: 05, 10.
3. **Genuine, correctly-grounded absence of an immediately executable action, for 1 of 6
   candidates.** `capture-product-margin-data` — supplier cost-per-item verified `null` for all 25
   active variants, no substitute signal exists anywhere in Merchant Memory. Evidence: 04, 07.
4. **Rescue discovery possibly compounding cause #1 (plausible, not independently confirmed).**
   Rescue's prompt content wasn't persisted (same gap as #2, one level up the call stack), so whether
   it was told "the anchor products can't be found" and suppressed related ideas as a result is a
   reasonable inference from token counts and timing, not a proven mechanism. Evidence: 09.
5. **Vestigial catalogue-shaped field name (`retrievedOperations: []`), cosmetic.** Always empty for
   Gateway runs, doesn't affect any decision, worth removing/renaming but not blocking anything.
   Evidence: 03, 10.
6. **UI message genericity, not a root cause of the outcome but worth its own fix.** The single
   generic "no grounded action" string doesn't distinguish `DISCOVERY_FAILURE` from `TRUE_NO_ACTION`
   from `MERCHANT_INPUT_NEEDED`, which matters because this run is the first kind, not the third.
   Evidence: 12.
7. **Candidate discovery / formulation quality: not a cause.** 6 commercially diverse, concretely
   formulated, mostly-executable candidates were generated from a freshly-rebuilt Merchant Memory.
   Evidence: 03.
8. **Over-conservative grounding policy ("Jefe only recommends values already explicit in Shopify"):
   not observed.** The one merchant-input-required candidate is genuinely, correctly blocked; no
   candidate was rejected for proposing a value Jefe could have reasonably inferred itself. Evidence:
   07.
9. **Execution-time approval leaking into recommendation-time rejection: not observed.** No candidate
   reached the approval boundary; the mutation tools are structurally absent from this call site
   regardless. Evidence: 08.
10. **Novelty/active-work suppression: not applicable.** No existing Action or active work exists for
    this shop in the current database — the shared local Postgres was reset since the prior
    investigation, and the previously-tracked "Proven Products" collection exists in neither the local
    database nor live Shopify. Evidence: 02.
11. **Authorization/scope: not a cause.** Every candidate that reached a plausible intervention maps
    to a mutation whose required scope is granted. Evidence: 06.
12. **Runtime/call budgets: not a cause.** No candidate hit a turn or global budget limit; termination
    authority was `MODEL_DECISION` throughout. Evidence: 06, 10.
13. **Provider failure: one transient error, immediately retried successfully, no outcome depends on
    it.** Evidence: 10.
14. **Schema discovery: not exercised, not a cause.** Zero `shopify_schema` calls this run — no
    candidate needed one, and none was blocked for lacking one. Evidence: 02 (summary table).

## What this pass fixed vs. flagged

**Fixed** (narrow, deterministic, conclusively proven, blocking the diagnostic, with a regression
test — per this task's fix policy):
- `safeTrace()` field-name mapping (`recommendation-service.server.js`), so future Gateway runs
  persist their actual GraphQL document text and result classification instead of `null`/`null`.

**Flagged, not fixed** (per "report first," these all require either a product-judgment call or
touch behavior beyond a single deterministic mapping bug):
- Why the two suspect `products` queries actually returned zero nodes — needs a fresh run captured
  *after* the `safeTrace()` fix to observe the real query text live, or a targeted unit test against
  `gateway/tools.server.js`/`document.server.js` with a deliberately-malformed multi-word title filter
  to reproduce the Shopify search-DSL failure mode directly.
- Whether candidates should be required to independently re-verify an `ALREADY_AVAILABLE`-reused
  result actually answers their own evidence question before accepting it as conclusive (this run's
  clearest lever for preventing one bad read from cascading into three more rejections).
- Whether rescue discovery should receive an explicit "the prior empty read may itself be wrong,
  consider re-querying" instruction rather than only the rejection outcomes.
- `retrievedOperations: []` — remove or rename the vestigial field in persisted candidate rows.
- The generic `NO_ACTIONABLE_OPPORTUNITY` UI copy not distinguishing discovery failure from genuine
  absence.
- The underlying two-workspaces-one-Shopify-app-registration infra risk from 01, carried forward
  unchanged from the prior investigation's own recommendation #1.

## Answering the task's central question

> Now that the operation catalogue has been removed as a bottleneck, what is the next actual
> bottleneck preventing Jefe from consistently turning good commercial hypotheses into grounded
> executable Actions?

For this run: **the Gateway can generate valid GraphQL and execute it without a GraphQL error, but
neither the model nor the surrounding harness treats a schema-valid, zero-error, empty-result read as
something to question or retry** — even when independent verification (11) shows the same query
intent, run again moments later, immediately returns real data. The catalogue-era failure mode was "I
don't know how to ask this." This run's failure mode is "I asked, got nothing back, and treated that
as the answer." That is a narrower, more tractable problem than the catalogue removal solved, but it
is real, it is not genuine absence of opportunity, and it is compounded by a (now-fixed) observability
gap that made it unnecessarily hard to prove.
