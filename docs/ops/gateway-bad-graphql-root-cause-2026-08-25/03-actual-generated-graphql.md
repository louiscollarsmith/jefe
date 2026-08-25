# Part 4 — Actual generated GraphQL vs. the known-good query

Known-good reference (from the prior investigation's independent live verification):

```graphql
{ products(first: 10, query: "title:'Borderlands Discovery Four' OR title:'Cloud Needle Tsolikouri'") { nodes { id title status } } }
```

## Attempt A — search-DSL grouping

```graphql
query CandidateProducts($query: String!) {
  products(first: 10, query: $query) { nodes { id title status handle totalInventory vendor productType onlineStoreUrl } }
}
```
variables: `{"query": "title:(\"Borderlands Discovery Four\" OR \"Cloud Needle Tsolikouri\")"}`

- Schema-valid: yes. Sent to Shopify: yes, unmodified. Shopify's response: `FULL_SUCCESS`,
  `{"products":{"nodes":[]}}`.
- Diff from known-good: known-good repeats the field per clause (`title:'A' OR title:'B'`); this
  groups both values under one `title:(...)` with double-quoted values and no per-clause field
  prefix. Shopify's search DSL does not treat that as "either exact title" — it silently matches
  nothing rather than erroring.
- Search DSL details checked: field prefix `title:` (correct field), **grouped parenthesised OR
  with quoted values** (the actual defect), double quotes (accepted syntactically), no escaping
  issue, no comma, no whitespace issue, no pagination issue (`first: 10` is fine), no status filter
  present (so status:active exclusion is not the cause here).

## Attempt B — internal id, no GID wrapper

```graphql
query ReadPromotionCandidates($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on Product { id title status handle totalInventory variants(first: 10) { nodes { id inventoryQuantity price } } } }
}
```
variables: `{"ids": ["e00fb90c-15a8-44ed-8f26-d702e11c2322", "15523d15-581c-4e80-80c3-bdb36a524dc8"]}`

- Schema-valid: yes (the document itself is syntactically and structurally fine — `nodes(ids:
  [ID!]!)` is a real root field, real arguments).
- Sent to Shopify unmodified (see `05-gateway-document-transform.md` for the AST round-trip proof).
- Shopify's response: **hard `GRAPHQL_FAILURE`** — `"Variable $ids of type [ID!]! was provided
  invalid value for 0 (Invalid global id 'e00fb90c-15a8-44ed-8f26-d702e11c2322'), 1 (Invalid global
  id '15523d15-581c-4e80-80c3-bdb36a524dc8')"`.
- The second id, `15523d15-581c-4e80-80c3-bdb36a524dc8`, is an **exact character-for-character match**
  for `products.id` (our internal Postgres primary key) for Cloud Needle Tsolikouri. The first is a
  near-match (two hex digits differ from Borderlands Discovery Four's internal id — see
  `07-stable-id-analysis.md` for why that's a plausible transcription slip on top of the underlying
  namespace confusion, not a separate defect).
- Product IDs: **this is exactly a stale/wrong-namespace ID, not a hallucinated GID** — see `07`.
- Handles: not attempted in this call.

## Attempt C — internal id wrapped in a `gid://` prefix (the closest match to the original run's symptom)

```graphql
query CandidateProducts($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Product { id title status handle totalInventory ... } }
}
```
variables: `{"ids": ["gid://shopify/Product/e00fb90c-15a8-44ed-8f26-d702e11c2322", "gid://shopify/Product/15523d15-581c-4e80-80c3-bdb36a524dc8"]}`

- Schema-valid: yes. Syntactically a well-formed GID (`gid://shopify/{Type}/{numeric-or-opaque-id}`).
- Sent to Shopify unmodified.
- Shopify's response: `FULL_SUCCESS`, `{"nodes": [null, null]}` — **no error, silent nulls**. This is
  the precise mechanical match for the original run's own words ("the products query returned zero
  nodes... executed successfully") — a well-formed GID whose id segment does not correspond to any
  real Shopify object resolves to `null`, not an error.
- Product IDs: confirms the model has independently learned/inferred Shopify's
  `gid://shopify/{Type}/{id}` convention and mechanically applied it to the wrong id value.

## Attempt D — the corrected query the model issued immediately after Attempt C

```graphql
query CandidateProductsByTitle {
  products(first: 10, query: "title:\"Borderlands Discovery Four\" OR title:\"Cloud Needle Tsolikouri\"") {
    nodes { id title handle status totalInventory vendor productType onlineStoreUrl variants(first: 10) { nodes { id title availableForSale inventoryQuantity } } }
  }
}
```
- This is the *correct* shape (`title:'A' OR title:'B'`, double-quoted this time, no grouping).
- Result: `FULL_SUCCESS`, real data — both products, `ACTIVE`, with real inventory and variant data.
- **This call's result was discarded by the harness** — see `10-empty-result-reasoning.md` and
  `11-cache-evidence-propagation.md` are not the mechanism here; `12-root-cause-and-fix.md` covers
  the actual mechanism (a terminal status paired with a pending tool call).

## `restore-unavailable-variants` — two more GraphQL rejections, unrelated to product identity

```graphql
query CurrentUnavailableVariants {
  products(first: 100, query: "status:active") {
    nodes { id title status variants(first: 100) { nodes { id title inventoryItem { id inventoryLevels(first: 5) { nodes { available location { name } } } } } } }
  }
}
```
- Shopify: `GRAPHQL_FAILURE` — `"Field 'available' doesn't exist on type 'InventoryLevel'"`
  (real field is `InventoryLevel.quantities(names: [...])` in this API version, not a flat
  `.available`).
- Repaired call, same shape but wider: `GRAPHQL_FAILURE` — `"Query cost is 2540, which exceeds the
  single query max cost limit (1000)"`.
- A later attempt with `first: 100` products but a narrower nested selection succeeded cleanly
  (`FULL_SUCCESS`, 17 products) — see `08-three-products-query-comparison.md`.

None of `restore-unavailable-variants`' queries ever touched a `productId`/GID at all — its own
Merchant Memory evidence (`inventory.out_of_stock_variant_count`, `inventory.in_stock_variant_share`)
carries no product-level identifiers (see `07`), so this candidate's failures are a completely
separate mechanism from the anchor-products candidate's.
