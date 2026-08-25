# Part 11 — Recommendation-time vs. execution-time gating

## Question

Is recommendation generation rejecting candidates merely because a later explicit confirmation would
be required, a mutation risk tier is high, or execution-time authorization hasn't happened yet — i.e.
is `RECOMMENDABLE_BUT_REQUIRES_APPROVAL_BEFORE_EXECUTION` being incorrectly folded into
`NOT_RECOMMENDABLE`?

## Finding: not observed this run

None of the six candidates' rejection reasons mention confirmation tiers, blast-radius caps,
execution authorization, or anything from the mutation-safety/explicit-confirmation machinery at all.
Every rejection reason in `diagnostics.candidateQueue` is phrased entirely in terms of evidence
sufficiency ("the required live Shopify predicates were not confirmed", "Shopify cannot provide
authoritative supplier purchase costs", "cannot be identified or verified from current Shopify
state"). The recommendation-agent tool list for this mode is `shopify_schema` + `shopify_query` only
— the mutation tools (`shopify_prepare_mutation`, `shopify_execute_mutation`) are structurally absent
from what the model could call during recommendation generation (`tools.server.js`: both mutation
tools return `MUTATION_TOOL_UNAVAILABLE` when `ctx.recommendationMode` is set, and are omitted from
the tool list entirely at this call site per the file's own header comment) — so there was no
opportunity for an execution-approval concept to leak into this phase's reasoning even if the model
had wanted to raise it.

**Every one of the 5 executable-in-principle candidates in this run (06) would have reached
`RECOMMENDABLE_BUT_REQUIRES_APPROVAL_BEFORE_EXECUTION` had its evidence question been answered
correctly** — none of them were blocked by approval semantics; they were blocked upstream of that, on
the evidence step this pass documents in 04/05/06.

## Conclusion

This is a real distinction worth preserving as a standing check for future runs (the task correctly
anticipated it as a plausible failure mode), but it did not occur in this run. No fix or policy change
is warranted here.
