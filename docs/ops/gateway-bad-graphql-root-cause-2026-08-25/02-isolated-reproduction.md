# Part 3 — Isolated reproduction, outside the full recommendation loop

## Method

Rather than spending another ~700k tokens on a full `runCandidateDrivenRecommendation` pass (6-way
discovery + rescue), this investigation called `generateAgenticShopifyRecommendation()` directly with
`focusCandidate` set to each of the three candidates whose original queries were of interest,
reconstructed verbatim from the persisted `candidateQueue` of run `80553fc7-…`
(`docs/ops/gateway-no-action-forensics-2026-08-25/04-candidate-lifecycle.md`):

- **`reactivate-sales-after-gap`** ("anchor-products") — the candidate whose evidence names
  Borderlands Discovery Four / Cloud Needle Tsolikouri by title.
- **`restore-unavailable-variants`** ("unavailable-variants") — the second candidate whose `products`
  read came back empty in the original run, with *no* named products in its own evidence.
- **`capture-product-margin-data`** ("margin-control") — the one candidate whose `products` read
  succeeded in the original run, used here as a working baseline.

Real model (`gpt-5.6-luna` via the `openai` provider — identical to the original run), real
`shopify_schema`/`shopify_query` tool surface, no prewritten GraphQL supplied. `maxIterations: 4` per
attempt (same as production's `perCandidateIterations` default).

## Attempts run and determinism

| Candidate | Attempts | Deterministic? |
| --- | ---: | --- |
| anchor-products | 5 | **No** — 4 materially different failure mechanisms observed across 5 attempts (below) |
| unavailable-variants | 3 | No — 2 different GraphQL-level rejections, converging to success on the 3rd |
| margin-control | 1 | Succeeded cleanly; not repeated (control case, not the subject of this investigation) |

Full raw captures: `raw/anchor-products-attempt-A-search-dsl-failure.json`,
`raw/anchor-products-attempt-B-hard-error-graphql-failure.json`,
`raw/anchor-products-attempt-C-discarded-self-correction.json`,
`raw/unavailable-variants-attempt-1-field-and-cost-errors.json`,
`raw/margin-control-attempt-1-known-good.json`.

## Headline result

**The bad-query mechanism is not one thing — it is at least four independent, individually
reproducible defects**, three in query/evidence generation and one in the orchestration harness
itself:

1. **Internal database id mistaken for a Shopify GID** (`nodes(ids:)` called with `products.id`
   values straight from a Merchant Memory belief's `productId` field — sometimes raw, sometimes
   wrapped in a `gid://shopify/Product/` prefix that makes the mistake syntactically invisible).
2. **A Shopify search-DSL grouping gotcha**: `title:("A" OR "B")` executes without error but matches
   nothing, where `title:'A' OR title:'B'` matches correctly.
3. **Schema/cost-limit misses specific to broader inventory reads**: a hallucinated field name
   (`InventoryLevel.available`) and a query exceeding Shopify's single-query cost cap (2540 vs. a
   1000-point limit) when reading too much nested data in one call.
4. **A harness defect**: a terminal status (`BLOCKED`) declared in the same turn as a corrective tool
   call is honored immediately, discarding that tool call's result even when — as directly observed —
   it was correct and would have overturned the terminal verdict.

These are detailed with full raw evidence in `03`–`06`, `08`–`11`. `12` gives the root-cause ranking
and the fixes made in this pass.
