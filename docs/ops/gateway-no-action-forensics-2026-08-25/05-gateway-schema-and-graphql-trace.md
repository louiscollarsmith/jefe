# Parts 6, 7, 15 — The actual Gateway GraphQL, the live counter-proof, and the trace bug

## What the persisted trace actually contains

Every `shopify_query` row in `raw/target-run-result.pretty.json` looks like this:

```json
{
  "ok": true,
  "tool": "shopify_query",
  "error": null,
  "facts": { "query": null, "status": null, "operation": "products", "gatewayDecision": null },
  "message": "products query executed."
}
```

`query` is `null` on **every single row**, for both the successful control case
(`capture-product-margin-data`) and the two suspect empty reads. This is not because the Gateway
didn't generate a document — it's a persistence bug (see "The fix" below). This section first
establishes what's independently provable without the missing query text, then explains why it's
missing.

## Independent live-Shopify counter-proof (read-only, run during this investigation)

Using the real granted access token for `jefe-local-store.myshopify.com` from the local `Session`
table, pinned to the same `SHOPIFY_API_VERSION=2026-07` the run used:

```graphql
{ products(first: 10, query: "title:'Borderlands Discovery Four' OR title:'Cloud Needle Tsolikouri'") { nodes { id title status } } }
```

```json
{
  "data": { "products": { "nodes": [
    { "id": "gid://shopify/Product/10375206699304", "title": "Cloud Needle Tsolikouri", "status": "ACTIVE" },
    { "id": "gid://shopify/Product/10375207780648", "title": "Borderlands Discovery Four", "status": "ACTIVE" }
  ] } },
  "extensions": { "cost": { "requestedQueryCost": 6, "actualQueryCost": 3 } }
}
```

Both products exist, are `ACTIVE`, and are found on the first try by an ordinary title search — no
special syntax, no retry needed. Full detail and a second query (confirming the "Proven Products"
collection referenced in the prior report also doesn't exist) are in `raw/live-shopify-verification.md`.

**This directly answers Part 7's central question.** The candidate investigation's own conclusion —
"the required live Shopify predicates were not confirmed: the products query returned zero nodes for
both named products" — is not a case of "Shopify doesn't provide enough information." A reasonable
GraphQL query, run minutes later against the identical store and token, retrieves exactly the
information the candidates needed. Classified per the task's taxonomy:

```text
Evidence blocker classification: WRONG_QUERY, compounded by AGENT_STOPPED_TOO_EARLY
  (the model treated one empty products read as conclusive for 3 downstream candidates via
  ALREADY_AVAILABLE reuse, and issued a second, differently-scoped products query for a 4th
  candidate that also came back empty, without ever retrying either with a different query shape —
  e.g. by exact product ID/handle, without the OR clause, or via a plain `products(first: 50)` scan)
```

## What we cannot prove: the *exact* mechanism of the wrong query

Three hypotheses remain open, and this investigation cannot distinguish between them from the
persisted data:

1. The model wrote a subtly malformed `query:` search-string argument (Shopify's Admin GraphQL
   search DSL is a well-known footgun for multi-word, quoted values — e.g. unquoted or
   inconsistently-quoted multi-word title terms can silently match nothing rather than erroring).
2. The model searched by the wrong field entirely (e.g. `handle:` instead of `title:`, or a stale/
   hallucinated product ID).
3. Something in how the document/variables were passed from the model's tool call through to
   `ctx.client.request()` corrupted the query argument before it reached Shopify.

(3) is the least likely given `document.server.js`'s `analyzeGatewayDocument()` only parses,
validates, and re-prints the AST (`print(ast)`) — a faithful round-trip for a well-formed document —
and given `capture-product-margin-data`'s `products` query executed correctly in the same run through
the same code path. But "least likely" is not "ruled out," because the one thing that would settle it
— the actual GraphQL text and variables Luna sent for the two suspect calls — was not recoverable.

## The fix: `safeTrace()` was dropping the Gateway's actual query text

`app/lib/shopify/agentic-runtime/recommendation-service.server.js`'s `safeTrace()` is what persists
`result.trace` into `MerchantPlanRun.result_json`. It was written against the **old catalog
dispatcher's** tool-result shape, where `call_shopify_operation` populated `facts.query` (the document
text) and `facts.status` (e.g. `ALREADY_AVAILABLE`). The Gateway's own tool
(`gateway/tools.server.js` → `runValidatedQuery`) populates the *same two concepts* under different
key names: `facts.document` (not `facts.query`) and `facts.classification` (not `facts.status`, except
for the synthetic `ALREADY_AVAILABLE` cache-hit rows, which do still set `facts.status` directly —
which is why `ALREADY_AVAILABLE` rows show up correctly in the trace while every real read shows
`query: null, status: null`).

This is exactly the kind of catalog→Gateway migration residue Part 15 asked to hunt for — a
field-name mismatch, not a removed string. It conclusively blocks Part 6 of this diagnostic ("I want
to personally see what Luna is asking Shopify") for every Gateway run ever persisted, including this
one, with no way to reconstruct it after the fact once the originating process has exited. Per this
task's fix policy ("a narrow deterministic bug… conclusively proven… prevents the diagnostic from
continuing… with a focused regression test"), it was fixed in this pass:

```js
// before
query: row.facts?.query ?? null,
status: row.facts?.status ?? null,

// after
query: row.facts?.document ?? row.facts?.query ?? null,
status: row.facts?.status ?? row.facts?.classification ?? null,
```

`data`, `variables`, and `resourceIds` were deliberately **not** added to the persisted whitelist —
those can carry live merchant/customer field values, and `apps/shopify/docs/observability.md`'s
call-site PII discipline (generic scrubbing was removed 2026-08-13) argues for keeping raw response
payloads out of a long-lived diagnostic column. Only the model's *own generated query text* and the
*result classification* (both of which describe what Luna asked, not what a customer's data was) were
restored.

Regression test: `tests/recommendation-gateway-trace-fields.test.mjs` (3 cases — Gateway shape now
round-trips, catalog-dispatcher shape still round-trips unchanged, `data`/`variables`/`resourceIds`
remain excluded). Full existing recommendation test suite (80 tests across
`recommendation-belief-exposure`, `recommendation-run-identity`, `agentic-recommendation-retry-lineage`,
`home-proposal-generation`, `recommendation-novelty`) still passes unchanged.

**This fix does not change any recommendation logic, threshold, or prompt** — it only changes what
gets written to a diagnostics column. It fixes forward: this run's own query text remains
unrecoverable (the bug was live when it ran), but every Gateway run from this commit onward will
persist its actual GraphQL document and result classification.

## Query classification for this run (per the task's taxonomy, based on what's provable)

| Query | Classification |
| --- | --- |
| `products` read for `reactivate-sales-after-gap` | `VALID_BUT_WRONG_QUESTION` or a malformed-filter variant of `WRONG_QUERY` — schema-valid, executed without a GraphQL error, but returned a result contradicted by an independent identical-intent query minutes later |
| `products` read for `restore-unavailable-variants` | Same classification — independently issued, independently empty |
| `products`/variant read for `capture-product-margin-data` | `VALID_AND_USEFUL` — real data, correctly used |
| `ALREADY_AVAILABLE` reuses (×3) | `REDUNDANT` by design (the caching mechanism working as intended) — but propagated a wrong answer to 2 more candidates as a side effect |
