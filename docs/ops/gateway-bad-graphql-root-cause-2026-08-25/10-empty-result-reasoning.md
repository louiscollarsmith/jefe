# Part 13 — Empty-result reasoning, kept separate from query generation

Two distinct questions, deliberately not merged:

```text
QUERY_GENERATION_BUG   — did the model write/choose the wrong query?
EMPTY_RESULT_REASONING_BUG — did the model handle a surprising empty/null result correctly?
```

## `QUERY_GENERATION_BUG`: confirmed, three independent mechanisms (03, 04, 06, 07, 08)

Internal-id-as-GID, search-DSL grouping, wrong field name / cost-limit. Real, reproduced, fixed at
the data-source root for the first (`12`); flagged, not fixed, for the second and third.

## `EMPTY_RESULT_REASONING_BUG`: the evidence is mixed, and more encouraging than the original run suggested

Given `{"nodes": [null, null]}` (Attempt C) while its own candidate context strongly asserts these
products recently sold heavily, the model's very next turn said, verbatim:

> "The prior nodes read completed technically but returned null for both requested product IDs,
> leaving the required Shopify predicates unverified. **A title-based product search is required**
> before deciding whether a promotional merchandising placement is safe and actionable."

That is exactly the reconciliation behavior the task brief hoped to find: the model **did** question
the unexpected null, **did** try another lookup, with a materially different query shape (title
search instead of id lookup) — not a blind retry of the same failing call. This directly answers the
task's own question in the affirmative: *"does the current prompt tell it to reconcile
contradictions... try another lookup?"* — nothing in the prompt says this explicitly, but the model
did it anyway, unprompted, once given the chance.

**The problem is not that the model "stopped too early" in its own reasoning.** The problem (`12`) is
that the *harness* attached that correct next query to the same turn as a terminal `BLOCKED`
declaration, and the terminal declaration was honored before the query's result could be seen — a
structural defect in the loop, not a defect in the model's judgment about when to keep investigating.

Other attempts (A, B) did **not** self-correct within their iteration budget — Attempt A accepted its
one empty `products` read as final without retrying a different search shape at all; Attempt B's
model explicitly declared it needed a live read but described the read as unavailable ("no
shopify_query tool is available in this execution context" — an inaccurate framing of "I chose not to
call it this turn," not a real tool outage) and terminated without ever calling it. So the self-
correction behavior in Attempt C is real but **not reliable across attempts** — this is consistent
with an LLM whose behavior varies run-to-run, not a deterministic prompt instruction either present
or absent.

## Classification

```text
QUERY_GENERATION_BUG: CONFIRMED, multiple independent mechanisms, primary one fixed in this pass.
EMPTY_RESULT_REASONING_BUG: PARTIALLY CONFIRMED — the model's own reasoning is inconsistent
  (self-corrects in some attempts, accepts a bad result in others), but the one case where it *did*
  self-correct was defeated by the harness bug in `12`, not by the model's judgment. Fixing `12`
  removes the harness-level failure mode; it does not make the model's willingness to retry after an
  empty result more consistent across attempts, which remains an open, real, unfixed risk.
```
