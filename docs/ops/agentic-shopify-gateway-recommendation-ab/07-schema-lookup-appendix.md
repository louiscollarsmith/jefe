# Part 8 — Schema lookup appendix

## This run: zero schema lookups

The real winning gateway run made 0 `shopify_schema` calls — the model went straight to
`shopify_query` and repaired its one mistake directly from Shopify's own error message (see
`06-generated-graphql-appendix.md`). This is itself informative: it demonstrates Part 4's design
goal (schema lookup is optional, not ritualistic) actually held in a real run, not just as an
untested policy.

## Real schema-lookup evidence (from the prior session's standalone run)

Since this run has no lookups to inspect, the best available real evidence for `shopify_schema`
behaviour is the previous session's live run (`docs/ops/agentic-shopify-gateway/10-real-shopify-query-examples.md`):
20 `shopify_schema` calls across 6 turns, including a real, useful failure mode — the model tried
`inspect_field` on object *type* names (`Product`, `ProductVariant`, ...), which correctly returned
`FIELD_NOT_FOUND` (that action only resolves root Query/Mutation field names), and the model
adapted by falling back to `search`/`list_fields`. That coverage gap is unchanged this session — see
`15-remaining-limitations.md`.

## Response-size measurement (Part 12 of the brief)

Measured directly against the real schema index this session, four representative recommendation-
shaped questions:

| Question | Results returned | Response size |
| --- | --: | --: |
| "active products and their variants" | 8 (bounded) | 2,003 bytes |
| "inventory availability by location" | 8 (bounded) | 1,882 bytes |
| "collections and their products" | 8 (bounded) | 1,945 bytes |
| "recent orders and line items" | 8 (bounded) | 1,929 bytes |
| `inspect_field(productVariants)` | 1 field, full detail | 961 bytes |
| `list_fields(QUERY, limit=100)` | 100 names | 2,006 bytes |

For comparison: the full generated catalogue artifact these lookups are sourced from is 2.66MB
(810 operations). Every measured lookup returned well under 1% of that — "small question → small
relevant fragment," not "small question → enormous introspection dump," matching the architecture
goal. No over-fetching found; no fix was needed before running the comparison.

Results stay tied to the configured Shopify API version (`2026-07`) because the schema index is
built directly from the pinned, versioned catalogue snapshot — there is no path for a lookup to
return data from a different version.
