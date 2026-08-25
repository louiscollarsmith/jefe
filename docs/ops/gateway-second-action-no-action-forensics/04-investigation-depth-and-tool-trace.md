# Part 04 — Tool/query trace, GraphQL quality, and investigation-depth analysis

Raw: `raw/tool-results.json` (all 16 real tool calls, unedited).

**Framing note:** this is the catalog dispatcher's tool surface (`retrieve_shopify_operations`/
`call_shopify_operation`), not the Gateway's (`shopify_schema`/`shopify_query`) — see Part 01. The
original task's framing ("Gateway's advantage is supposed to be the ability to dynamically retrieve
whatever evidence the candidate actually needs") does not apply to what actually ran. What follows
answers the closest analogous, still-useful question: did *this* system investigate thoroughly, and
does the specific gap pattern found here explain *why* the Gateway was built the way it was.

## Full tool-call trace, classified

16 calls total across 6 candidates — noticeably lean (2.7 calls/candidate average), because reads
are cached and reused across candidates within the run (the `ALREADY_AVAILABLE` entries below), not
because investigation was shallow.

| # | Tool | Target | Result | Classification |
| -: | --- | --- | --- | --- |
| 0, 1 | `retrieve_shopify_operations` | server-bound capability search, 8 stubs each | ok | VALID_AND_USEFUL — but see "the top-N binding step" below |
| 2 | `call_shopify_operation` | `product` | ok | VALID_AND_USEFUL |
| 3 | `call_shopify_operation` | `collections` | ok | VALID_AND_USEFUL |
| 4 | `call_shopify_operation` | `channels` | **denied** | AUTHORIZATION_BLOCKED — real: `read_publications` genuinely not granted (verified against the real `Session.scope` row, Part 06) |
| 5, 6 | `call_shopify_operation` | `product`, `collections` (reused) | ok, `ALREADY_AVAILABLE` | VALID_AND_USEFUL — correct de-dup, not a wasted call |
| 7 | `call_shopify_operation` | `channels` | **denied** | AUTHORIZATION_BLOCKED — same real scope gap, re-hit by a second candidate |
| 8 | `retrieve_shopify_operations` | server-bound capability search, 8 stubs | ok | VALID_AND_USEFUL |
| 9 | `call_shopify_operation` | `customers` | ok | VALID_AND_USEFUL |
| 10 | `call_shopify_operation` | `segments` | ok | VALID_AND_USEFUL — this is the read that found the existing customer segment (Part 05) |
| 11, 12 | `call_shopify_operation` | `customers`, `segments` (reused) | ok, `ALREADY_AVAILABLE` | VALID_AND_USEFUL |
| 13 | `retrieve_shopify_operations` | server-bound capability search, 8 stubs | ok | VALID_AND_USEFUL |
| 14 | `call_shopify_operation` | `inventoryItems` (reused from an earlier candidate) | ok, `ALREADY_AVAILABLE` | **VALID_BUT_WRONG_EVIDENCE** — see below |
| 15 | `call_shopify_operation` | (mutation attempt) | **denied** | Correctly blocked: `RECOMMENDATION_WRITE_DENIED` — recommendation investigation is read-only by construction; the model attempted a write and was structurally refused before it reached Shopify. This is *correct* safety behavior, not a defect. |

No partial GraphQL errors, no invalid/malformed documents, no repaired-after-failure calls in this
trace — everything that reached Shopify either succeeded cleanly or failed on a real, externally
verifiable authorization gap.

## The one real investigation-depth gap found: `refresh-inventory-confidence`

The last candidate concluded it could not obtain "a trustworthy current quantity source" for
inventory, citing the reused `inventoryItems` read (call #14 — the *same* read call #2's candidate
used to check `unitCost`, not the same question this candidate needed answered).

- **What Luna said:** "the Shopify reads do not provide a trustworthy current quantity source."
- **Does Shopify's schema expose enough to answer this?** Plausibly yes, in a way this run never
  tried: an `inventoryLevel`/`InventoryItem.inventoryLevels` read (location-scoped on-hand/available
  quantities, which is what live "is this stale/trustworthy" freshness questions actually need) is
  a different query shape from `inventoryItems`' unit-cost/tracking fields, which is what the
  *cost* candidate (#2) originally fetched it for.
- **Did the model formulate that more specific query?** No — this candidate made zero fresh read
  calls of its own; it reused candidate #2's `inventoryItems` result and one denied mutation
  attempt, then concluded `BLOCKED_BY_EVIDENCE`.
- **Was this the model incorrectly concluding Shopify couldn't answer it, or a genuine limitation?**
  `THE_AGENT_DID_NOT_FINISH_LOOKING`, not `SHOPIFY_DOES_NOT_EXPOSE_THIS`. Shopify's Admin API does
  expose per-location inventory levels; this run never queried them for this candidate.
- **Did iteration budget stop it?** No evidence of that — see Part 07 (budget analysis): this
  candidate used the fewest turns of any of the six.

**Why this happened — the top-N capability-binding step.** Calls 0/1/8/13 are all
`retrieve_shopify_operations` returning **"Server-bound N Shopify operation stubs for this
candidate"** — a server-side step that pre-filters the model's available operation list to a ranked
top-8 *before* the model chooses what to call, then reuses cached results across candidates. This
is exactly the "pre-filter to a ranked top-N, then hand the model that shortlist" pattern this
session's own work on the Agentic Shopify Gateway branch identified and removed, for precisely this
failure shape: a real, relevant operation (here, a location-scoped inventory-level read) can fail to
rank into the top-N for a given candidate's query wording, so the model never even sees it as an
option. `refresh-inventory-confidence`'s own `retrievedOperations` list (see
`03-candidate-discovery-and-lifecycle.md`'s raw candidate data) contains only inventory *mutation*
stubs (`inventoryAdjustQuantities`, `inventorySetQuantities`, etc.) plus generic property fields —
no inventory-level *query* operation at all. Whether that's because the search ranking genuinely
missed it, or because the reused `inventoryItems` result satisfied the server-side "already have a
relevant read" heuristic and suppressed a fresh search, this report cannot fully distinguish from
the trace alone — but either way, the effect is the same: the model was never offered the query
that would have actually answered its own stated question.

This is a real, specific, evidence-grounded example of the exact architectural risk the Gateway was
built to eliminate — found in the wild, in the system that is *not* the Gateway, on the same day the
Gateway branch removed that pattern for this exact reason.

## Execution-capability verification (task Part 11) — not applicable here

None of the six candidates reached a genuine `NON_EXECUTABLE`/`EXECUTION_SEMANTICS_MISSING`/
"Shopify API limitation" disposition to verify — all six were rejected for evidence/authorization
reasons (Part 03), not because a needed mutation doesn't exist. There is nothing to check against
the schema for this run.
