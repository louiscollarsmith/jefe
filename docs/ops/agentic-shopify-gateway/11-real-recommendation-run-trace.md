# Part 11 — Real recommendation-run trace

## Important scope caveat, stated up front

This is **not** a run of the production `generateAgenticShopifyRecommendation()` /
`runAgenticRecommendationInvestigation()` pipeline against `jefe-local-store.myshopify.com` with real
Merchant Memory and the real candidate-discovery machinery — that pipeline is tied to the catalogue
surface's 2-tool shape at ~20 call sites and was not rewired this session (`14-migration-rollback-
strategy.md`). What follows is a real, live, unmocked run of the gateway's own primitives
(`scripts/eval-agentic-shopify-gateway.mjs`) — a real LLM given the gateway's actual tools and a
real investigation task, not the production candidate pipeline. Treat this as validating the gateway
mechanics, not as a like-for-like recommendation-quality comparison with the catalogue path's live
recommendation runs.

## Run metadata

- Provider/model: `openai` / `gpt-5.6-luna`
- Started: 2026-08-25T12:26:05.507Z (per script log), full JSON at
  `.context/agentic-shopify-gateway/latest.json`
- Mode: `recommendationMode: true` (query-only tool set)
- Task given: discover how to query active products, variants, and inventory availability, then
  write and run one query.

## Captured metrics (all real, not estimated)

| Metric | Value |
| --- | --- |
| LLM calls | 8 |
| Total input tokens | 33,959 |
| Total output tokens | 1,866 |
| Wall-clock duration | 25,458 ms |
| `shopify_schema` calls | 20 |
| `shopify_query` calls | 1 (validated on first attempt — no local rejection/repair needed) |
| Successful live Shopify reads | 0 (honest — no token configured, not fabricated) |

## Disposition

Not `RECOMMEND_ACTION` or `NO_ACTIONABLE_OPPORTUNITY` — this run's task was schema-discovery
capability, not a merchant investigation with Merchant Memory attached, so the production disposition
taxonomy doesn't apply to it. The model's own final answer (`10-real-shopify-query-examples.md`)
correctly reported "the live request was attempted but failed... no data was retrieved" rather than
asserting a false result — the honest-failure design held up under a real model, not just in theory.

## Second stage: mutation preparation (no execution)

Also run in the same session, `recommendationMode: false`, against `productVariantsBulkUpdate` (the
same operation the live dead-stock clearance adapter uses):

```json
{
  "operation": "productVariantsBulkUpdate",
  "domain": "variants",
  "safety": { "riskTier": "SENSITIVE", "reversibility": "REVERSIBLE", "interaction": "APPROVAL_REQUIRED" },
  "execution": { "status": "EXECUTABLE", "classificationSource": "EXPLICIT_KNOWN_GOOD",
                 "reason": "Live typed adapter (price_markdown / dead-stock clearance) — ACTION_REGISTRY." },
  "blastRadius": { "resourcesAffected": 1, "publicSurfaceImpact": true, "destructiveCount": 0 },
  "requiresExplicitConfirmation": false
}
```

This confirms the gateway path picks up the *same* curated `EXPLICIT_KNOWN_GOOD` override the
catalogue path uses for this operation (`mutation-safety.server.js`'s `KNOWN_GOOD_OVERRIDES`) — not
a separately-derived, possibly-inconsistent classification. Same operation, same real classification,
regardless of which surface constructed the GraphQL.
