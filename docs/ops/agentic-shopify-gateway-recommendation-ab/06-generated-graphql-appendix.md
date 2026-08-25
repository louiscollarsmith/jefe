# Part 7 — Generated GraphQL appendix

All 4 `shopify_query` calls from the real winning gateway run
(`docs/ops/agentic-shopify-gateway-recommendation-ab/trace-gateway.json`), reproduced verbatim
(reformatted from the single-line normalized form only for readability here — the executed
documents are byte-identical modulo whitespace).

## Attempt 1 — REJECTED by live Shopify (not the local validator)

```graphql
query VerifyDecliningRangeMerchandising {
  products(first: 50, query: "status:active") {
    nodes {
      id
      title
      handle
      status
      totalInventory
      variants(first: 20) {
        nodes {
          id
          inventoryQuantity
        }
      }
    }
  }
  collections(first: 50) {
    nodes {
      id
      title
      handle
      productsCount
    }
  }
}
```

Shopify's response: `Field must have selections (field 'productsCount' returns Count but has no
selections. Did you mean 'productsCount { ... }'?)`

## Attempt 2 — repaired, succeeded (reused verbatim for attempts 3 and 4)

```graphql
query VerifyDecliningRangeMerchandising {
  products(first: 50, query: "status:active") {
    nodes {
      id
      title
      handle
      status
      totalInventory
      variants(first: 20) {
        nodes {
          id
          inventoryQuantity
        }
      }
    }
  }
  collections(first: 50) {
    nodes {
      id
      title
      handle
      productsCount {
        count
      }
    }
  }
}
```

The only change from attempt 1: `productsCount` → `productsCount { count }`. This is the exact fix
Shopify's own error message suggested.

## Why attempts 2–4 are byte-identical and weren't deduplicated

`findExistingGatewayQuery` (the gateway's dedup helper, added this session) fingerprints on trimmed
document text, and the model regenerated its GraphQL text fresh each turn rather than reusing a
literal prior string — even functionally-identical queries can differ in incidental whitespace
between generations. This means the same query executed 3 times instead of being served from cache
after the first success. Not a safety issue (each call is independently validated and ledgered),
but a real, minor efficiency gap — see `15-remaining-limitations.md`.

## Quality assessment of this GraphQL

- Correct root fields, correct connection pagination shape (`first`, `nodes`), correct use of
  Shopify's search-query mini-language (`query: "status:active"`) rather than a non-existent
  `status` argument.
- The one error was a real, non-obvious Shopify schema subtlety (`Count` is an object type, not a
  scalar) — not a hallucinated field or a wrong argument name.
- No pagination abuse, no excessive nesting, no unbounded queries.
- See `14-graphql-reliability-assessment.md` for the full classification against Part 11's rubric.
