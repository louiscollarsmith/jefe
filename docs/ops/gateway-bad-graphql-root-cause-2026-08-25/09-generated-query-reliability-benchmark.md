# Part 12 — Generated-query reliability: benchmark scope actually covered

The task brief asked for a 10-intent benchmark (exact product by title, two products by title,
product by GID, active products, zero-inventory products, variant cost, collection by title, recent
orders, customer by email, inventory levels for a known variant). This investigation did not run the
full 10-intent benchmark as a separate exercise — by the time it would have been useful, the session's
Shopify access token had expired (`13-post-fix-real-recommendation.md`), and the root cause was
already conclusively identified and reproduced through the targeted candidate reproductions (12 real
model+Shopify round trips across 3 candidates), which is a stronger form of evidence for the specific
question this task asked than a broader, shallower benchmark would have been.

## What the targeted reproductions already cover, mapped onto the benchmark's own intents

| Intent | Covered by | First GraphQL valid? | Correct result? | Schema lookup? | Repair needed? |
| --- | --- | ---: | ---: | ---: | ---: |
| 1. Exact product by known title | Attempt A/D | Yes (both) | No (A) / Yes (D) | No | Yes (A→D) |
| 2. Two products by title | Attempt A/D | Yes (both) | No (A) / Yes (D) | No | Yes (A→D) |
| 3. Product by Shopify GID | Attempts B/C | Yes (both) | No (both — wrong id value) | No | No (never retried the GID path itself) |
| 4. Active products | unavailable-variants / margin-control | Yes | Yes (margin-control); No then Yes (unavailable-variants) | No | Yes (unavailable-variants only) |
| 5. Products with zero inventory | unavailable-variants | No (field name), then No (cost limit), then Yes | Yes (3rd attempt) | No | Yes, twice |
| 6. Products with variant cost | margin-control | Yes | Yes | No | No |
| 7. Collection by title | Not attempted this pass | — | — | — | — |
| 8. Recent orders | Not attempted this pass | — | — | — | — |
| 9. Customer by email (dev fixture) | Not attempted this pass | — | — | — | — |
| 10. Inventory levels for a known variant | Partially — unavailable-variants' nested `inventoryLevels` selection, but never isolated as its own single-purpose query | — | — | — | — |

## What this does and doesn't tell us

**Title search is not "the one footgun."** Of the 6 intents actually exercised, 4 needed a repair
or failed outright on the first attempt, across three unrelated causes (identifier-namespace
confusion, search-DSL grouping, wrong field name, cost-limit). The evidence does not support "the
model broadly struggles to translate business intents into Shopify GraphQL filters" either — every
failure had a specific, nameable, fixable cause, and the control case (intent 6) succeeded cleanly on
the first try. The honest read: **query generation is reliable for scanning/aggregate business
questions and materially less reliable whenever a query must pin down specific named entities or
request enough nested data to approach Shopify's per-query cost ceiling** — both of which are now
addressed, one by removing its data-quality root cause (`12`), the other flagged as a real, distinct,
unfixed risk (nested-read cost budgeting) worth its own follow-up investigation rather than a
guessed fix here.

Intents 7–10 remain a genuine, explicitly-flagged gap in this report's coverage — not fabricated,
not silently skipped.
