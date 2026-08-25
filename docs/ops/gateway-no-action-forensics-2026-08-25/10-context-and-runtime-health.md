# Parts 14, 16 — Context sizes and runtime health

## Token accounting (from `llm_usage_event`, `run_id = 80553fc7-…`)

| Call # | Time (UTC) | Input | Cached input | Output | Total | Latency | Status |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 (discovery) | 18:04:45 | 57,372 | 0 | 1,287 | 58,659 | 13.6s | ok |
| 2 (`reactivate-sales-after-gap`) | 18:04:59 | 59,092 | 0 | 399 | 59,491 | 5.6s | ok |
| 3 (belief-id repair) | 18:05:05 | 59,307 | 1,798 | 252 | 59,559 | 5.2s | ok |
| 4 (`improve-customer-retention-measurement`) | 18:05:10 | 59,274 | 1,798 | 303 | 59,577 | 5.1s | ok |
| 5 (`raise-items-per-order`) | 18:05:15 | 59,277 | 1,798 | 294 | 59,571 | 4.3s | ok |
| 6 (`recover-declining-product-demand`) | 18:05:19 | 59,247 | 1,798 | 246 | 59,493 | 14.6s | ok |
| 7 (`restore-unavailable-variants`) | 18:05:34 | 59,233 | 1,798 | 734 | 59,967 | 22.8s | ok |
| 8 (`capture-product-margin-data`, part 1) | 18:05:57 | 59,431 | 1,798 | 1,139 | 60,570 | 21.2s | ok |
| 9 (`capture-product-margin-data`, part 2) | 18:06:19 | 64,883 | 1,798 | 1,222 | 66,105 | 18.1s | ok |
| 10 (retry target) | 18:06:37 | 0 | 0 | 0 | 0 | 5.7s | **error** |
| 11 (belief-id repair, retried) | 18:06:45 | 65,884 | 1,798 | 492 | 66,376 | 5.7s | ok |
| 12 (rescue discovery) | 18:06:51 | 58,249 | 0 | 420 | 58,669 | 19.7s | ok |

Total: ~721k input tokens (including cached), ~6.8k output tokens, 12 calls, 2m 25s wall clock.

## Growth pattern

Input size grows modestly and monotonically within a candidate's investigation (59,092 → 64,883 for
the longest-running candidate) as prior tool results accumulate — expected, bounded, not runaway.
Discovery and rescue calls are both ~57–58k tokens, essentially identical in size, so rescue is not
receiving a bloated "everything that happened so far" dump.

No context-limit failure occurred (no call errored on size; the one error had 0 tokens reported,
consistent with a request-level failure — timeout or 5xx — before the provider tokenized anything,
not a context-window overflow).

## Provider errors and retries

One error at 18:06:37 UTC (`status: error`, 0 tokens, `latency_ms: 5671`) during the 2nd belief-id
repair attempt for `capture-product-margin-data`. The very next call, 8 seconds later at 18:06:45,
succeeded and completed that repair. The run then proceeded normally into rescue at 18:06:51 — 6
seconds after the successful retry, not a delayed/degraded continuation.

**No candidate's outcome depends on the failed call.** `capture-product-margin-data`'s final
disposition (`BLOCKED_BY_EVIDENCE`, correctly grounded — 07) was reached via the successful retry, and
its diagnosed problem/evidence citations are identical in substance to what a clean single-attempt run
would have produced. Per the task's instruction not to blame provider errors without evidence they
affected an outcome: this one did not.

## Migration residue check (Part 15, expanded)

Runtime-code grep across `apps/shopify/app` on this branch (`773a713`) for the strings the task named:

| String | Occurrences in live/runtime code | Status |
| --- | --- | --- |
| `retrieve_shopify_operations` | `recommendation-agent.server.js` (default-parameter fallback values, unreachable at this branch's call sites — see 01), `candidate-pipeline.server.js` (a comment) | Historical/dead default, not exercised — confirmed via the trace itself (0 occurrences of the tool actually being called) |
| `call_shopify_operation` | Same file, same fallback pattern | Same |
| `relevantFamilyId` | Not found | — |
| `catalog` | Present only in doc comments describing what was removed (`gateway/tools.server.js` header) and in `docs/ops/agentic-shopify-gateway-full/` | Documentation only |
| `retrievedOperations` | `candidateQueue` rows, always `[]` for Gateway runs | Vestigial persisted field name, harmless, flagged in 13 |
| "operation stubs" / "top-N capability retrieval" | Removed entirely from the runtime call path (`gateway/tools.server.js`'s replacement, `schema-index.server.js`, does targeted search/inspect, not top-N binding) | Confirmed removed |

No live occurrence silently penalizes Gateway candidates because catalogue-specific concepts are
absent — the unreachable default-parameter values in `recommendation-agent.server.js` are dead code at
this commit (accra's own call sites always pass the Gateway tool names explicitly), not a live branch
that could fire.
