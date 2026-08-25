# Part 11 — A/B metrics

Real run, `jefe-local-store.myshopify.com`, same merchant/Merchant Memory/LLM config, back to back,
2026-08-25T13:29–13:33Z (post `validateInvestigation` fix — see `15-remaining-limitations.md`).

| Metric | Catalogue | Gateway |
| --- | --: | --: |
| Result | `NO_ACTIONABLE_OPPORTUNITY` | `RECOMMEND_ACTION` (materialized) |
| Candidates discovered | 8 (shared discovery — identical code) | 8 (same discovery pass) |
| Candidates investigated | 8 | 1 (won on the investigated candidate) |
| Useful Shopify reads | 11 (0 failed) | 4 (1 initial rejection repaired live, 3 successful — see below) |
| Schema lookups | 5 (`retrieve_shopify_operations`) | 0 (`shopify_schema`) |
| Generated GraphQL queries | n/a (pre-generated bounded documents) | 2 distinct documents (1 invalid, 1 valid; the valid one reused 3×) |
| Invalid GraphQL attempts | n/a | 1 (rejected by Shopify's live schema, not locally — see `06-generated-graphql-appendix.md`) |
| Successful automatic repairs | n/a | 1/1 |
| Candidates grounded with live Shopify state | 8/8 (every disposition cites a real read or specific Merchant Memory figure) | 1/1 |
| Blocked by insufficient evidence | 3 | 0 |
| Non-executable candidates | 3 (1 of which is a false negative — see `13-candidate-quality-comparison.md`) | 0 |
| Recommendation produced | No | Yes |
| LLM provider calls | 14 | 34 total for the run, but only 2 for the winning candidate's own investigation |
| Shopify calls | 16 (5 schema + 11 read) | 4 |
| Provider 429 retries | 0 observed in either run's logs | 0 observed |
| Wall-clock runtime | 272,667 ms (~4.5 min) | 104,621 ms (~1.7 min) |

## Reading this honestly

This is **one real run per surface**. The result — Gateway reaching a grounded recommendation
faster, with fewer Shopify calls, where Catalogue reached a defensible-looking but ultimately false
`NO_ACTIONABLE_OPPORTUNITY` — has a specific, reproducible, understood cause (`13-candidate-quality-
comparison.md`): the catalogue path's server-side stub-binding step missed the right operation for
one candidate due to keyword-search relevance ranking, not because catalogue mode is generally
worse at Shopify investigation. The other 7 catalogue dispositions look sound. A single run cannot
establish whether this specific miss is common or rare — that requires either many more real runs
or a fix to the catalogue's stub-binding relevance search (which would also resolve this specific
gap in the catalogue path, independent of whether Gateway ships).
