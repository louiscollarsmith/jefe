# Part 07 — Budget/runtime analysis, rescue discovery, and comparison to the real Gateway run

## Budget/runtime analysis (task Part 12)

| Candidate | Wall time | LLM turns (approx, from tool-call grouping) | Terminal reason |
| --- | ---: | ---: | --- |
| `restore-order-momentum` | 35.3s | 2 | Reached `BLOCKED_BY_EVIDENCE` cleanly |
| `capture-product-margin` | 44.2s | 2 | Reached `BLOCKED_BY_EVIDENCE` cleanly |
| `increase-basket-combination` | 23.8s | 1 | Reached `BLOCKED_BY_EVIDENCE` cleanly (fully reused prior reads) |
| `activate-rising-product` | 49.4s | 2 | Reached `BLOCKED_BY_EVIDENCE` cleanly (including the real scope denial) |
| `improve-repeat-purchase-measurement` | 43.6s | 2 | Reached `ALREADY_COVERED` (mislabeled downstream, Part 05) cleanly |
| `refresh-inventory-confidence` | 25.0s | 1 | Reached `BLOCKED_BY_EVIDENCE` cleanly — but see Part 04: this is the candidate that stopped *before* trying the query that might have answered its own question, not because of a budget cutoff |

**No candidate in this run exhibits `INVESTIGATION_FAILED`, `ITERATION_LIMIT`, `CALL_LIMIT`,
`TOKEN_LIMIT`, or `PROVIDER_RETRY_EXHAUSTED`.** Every one of the six reached its terminal
disposition through the model's own conclusion, not through budget exhaustion — `refresh-inventory-
confidence`'s shallow investigation (Part 04) is a *quality* gap (didn't ask the right question), not
a *budget* gap (never ran out of turns trying to).

**Global run budget:** 14 total LLM calls (2 discovery + 12 investigation, well under whatever this
codebase's `maxTotalLlmCalls` ceiling is), 0 provider retries/errors this run. Contrast directly with
the two sibling runs for this same shop that *did* hit a hard limit —
`69cd77bb`/`6921311d`, both `Estimated ~84,100 input tokens exceeds 80000` at the very first
candidate-discovery call, before a single candidate was even produced (see Part 01: riyadh's own
documented, since-fixed `buildOpportunitySurface` token-bloat bug). Those two are genuine
`TOKEN_LIMIT` failures and must not be read as "no second action" evidence — they never got far
enough to investigate anything. The target run (`5540e23a`) is not one of them.

## Rescue discovery (task Part 13)

- First-pass candidates: did they all fail? Yes — all 6 reached a terminal rejection (Part 03).
- Did rescue discovery run? Yes — `RESCUE_DISCOVERY` at 17:19:37.025Z, one LLM call (66,058 tokens,
  0 cached — a cold rescue-mode prompt, distinct from the cached discovery-mode prompt).
- What rejection history did it receive? The full first-pass candidate queue with each one's real
  disposition and reason (the same data in Part 03's table) — this is how the pipeline's own novelty
  gate prevents rescue from re-proposing a near-duplicate of something already rejected.
- What new candidates did it produce? **Zero** (`discoveryLog[1].candidateCount: 0`).
- If rescue produced nothing, was that itself premature? No evidence of that in this trace — the
  rescue call completed normally (no error, no truncation, real token usage consistent with a full
  reasoning pass) and simply concluded there was nothing further to propose given what the first
  pass had already tried and the store's actual state.

**This is meaningful evidence, not just an empty result.** Rescue discovery's entire purpose is to
look past the first pass's specific ideas for something genuinely different. Given the full context
of six already-explored, already-rejected candidates across six different domains, it still came up
empty — which is a reasonably strong (though not absolute) signal that the store's currently
investigable opportunity space really was exhausted for *this* system's capability surface, not that
discovery quit early.

## Comparison to the earlier real Gateway run (task Part 14)

| Dimension | Earlier Gateway run (`f8cbea9e`, 16:36–16:37Z) | Formal A/B, gateway surface (13:33Z, separate session) | Target run (`5540e23a`, catalog surface, 17:15–17:19Z) |
| --- | ---: | ---: | ---: |
| System that ran it | **Agentic Shopify Gateway** (`shopify_query`) | **Agentic Shopify Gateway** | **Old catalog dispatcher** (`retrieve_shopify_operations`/`call_shopify_operation`) — see Part 01 |
| Active Action present | No (this run *produced* the Action) | No | Yes |
| Candidates discovered | 7 | not recorded in `ab-summary.json` | 6 |
| Candidates investigated | 3 (stopped early — found a winner) | not recorded | 6 (exhaustive — no winner found) |
| Server-side capability pre-binding | **None** — Gateway has no top-N binding step | None | **Yes** — `retrieve_shopify_operations` "Server-bound N stubs" on every candidate (Part 04) |
| Shopify reads | 5 | 4 (3 successful, 1 failed) | 12 successful, 2 authorization-denied |
| Schema/capability lookups | 0 (Gateway's `shopify_schema` unused — not needed) | 0 | 4 (server-bound, catalog-only) |
| Wall time | 49.1s | 104.6s | 255.3s |
| Grounded candidates | 3/3 investigated were evidence-checked live | — | 6/6 investigated were evidence-checked live |
| Duplicate suppression | N/A (no active Action yet) | N/A | 0 genuine (1 mislabeled — Part 05) |
| Insufficient evidence | 2 of 3 investigated | — | 5 of 6 |
| Non-executable | 0 | — | 0 |
| Final result | `RECOMMEND_ACTION` | `completed` (catalog surface's A/B counterpart: `no_actionable_opportunity` in 272.7s) | `NO_ACTIONABLE_OPPORTUNITY` |

**What actually changed between the successful run and the no-action run is not "the first
opportunity was already taken."** It is, primarily: (1) a different execution system entirely (Part
01), and (2) that system's own architecture (server-side top-N capability binding) surfaced a real
investigation-depth gap on one candidate (Part 04) that the Gateway's architecture is specifically
designed not to have. The remaining candidate space was not proven "genuinely weak" so much as
investigated by a system carrying a known, already-identified failure mode for exactly this kind of
question — and even so, five of six rejections hold up on their own merits regardless of which
system ran them (Parts 03–04, 06).

The formal A/B's own catalog-surface run (272.7s, `no_actionable_opportunity`) for the *same shop
domain*, run under controlled conditions the same day, is a striking independent data point: the
catalog surface reached `NO_ACTIONABLE_OPPORTUNITY` in that earlier, controlled A/B too — this is not
a one-off fluke of the target run's specific candidates. Whether that reflects the catalog surface's
general behavior on this store, or the store's genuine opportunity space at that particular moment,
this report cannot fully separate without a Gateway-surface run under equivalent active-work
conditions — the one comparison this investigation cannot make, because it never happened (Part 01).
