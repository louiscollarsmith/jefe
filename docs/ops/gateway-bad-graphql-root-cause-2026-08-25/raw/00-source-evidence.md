# Raw source evidence referenced by this investigation

## Merchant Memory beliefs that leaked an internal database id as `productId` (pre-fix)

Pulled directly from the shared local Postgres (`merchant_memory_beliefs.value_json`), before the
`productShopifyGid` fix in `app/lib/merchant-memory/shopify-derivations.server.js`:

```json
{
  "id": "48949d7f-81d5-4f64-83a8-9d7d8b12e8e6",
  "key": "products.product_momentum.trailing_60d",
  "value_json": {
    "window": "current_30d_vs_prior_30d",
    "currency": "GBP",
    "topRiser": {
      "title": "Cloud Needle Tsolikouri",
      "productId": "15523d15-581c-4e80-80c3-bdb36a524dc8",
      "priorRevenue": 92, "changePercent": 25, "currentRevenue": 115
    },
    "topFaller": { "title": "Lemon Grove Vidiano", "productId": "ec2e8fd3-7c76-4e30-bbca-22dd133176f3", "...": "..." },
    "risingProductCount": 1, "decliningProductCount": 13
  }
}
{
  "id": "25fac365-289b-4763-ae53-a4ae06b3199d",
  "key": "products.bestseller_by_revenue.trailing_90d",
  "value_json": {
    "title": "Borderlands Discovery Four",
    "productId": "e00fb90c-15a8-44ed-8fce-d702e11c2322",
    "revenue": 444, "currency": "GBP", "revenueSharePercent": 22.96, "sellingProductCount": 16
  }
}
```

Compare `"productId": "15523d15-581c-4e80-80c3-bdb36a524dc8"` above to the local `products` table's
own primary key for the same row:

```sql
select id, external_id, title from products where title='Cloud Needle Tsolikouri';
--                   id                  |             external_id              |          title
-- 15523d15-581c-4e80-80c3-bdb36a524dc8  | gid://shopify/Product/10375206699304 | Cloud Needle Tsolikouri
```

Exact match: the belief's `productId` is our own internal Postgres row id — not
`products.external_id`, which already holds the real Shopify GID.

## Where this is computed (pre-fix, `app/lib/merchant-memory/shopify-derivations.server.js`)

Seven belief-construction sites shared this exact shape (fixed in this pass — see
`12-root-cause-and-fix.md`):

```js
const entry = {
  productId,                          // <- our internal products.id, unqualified
  title: productTitle(context, productId),
  ...
};
```

## Live-store reproduction attempt raw captures

- `anchor-products-attempt-A-search-dsl-failure.json` — `products(query: "title:(\"Borderlands
  Discovery Four\" OR \"Cloud Needle Tsolikouri\")")`, `classification: FULL_SUCCESS`,
  `data.products.nodes: []`. Grouped-OR-with-quoted-values inside `title:(...)` does not match, even
  though the products exist.
- `anchor-products-attempt-B-hard-error-graphql-failure.json` — `nodes(ids: $ids)` with the raw
  internal `products.id` values as-is (no `gid://` prefix). Shopify: `"Invalid global id
  'e00fb90c-15a8-44ed-8f26-d702e11c2322'"` (`GRAPHQL_FAILURE`).
- `anchor-products-attempt-C-discarded-self-correction.json` — `nodes(ids: ["gid://shopify/Product/
  e00fb90c-...", "gid://shopify/Product/15523d15-..."])`: syntactically valid GID shape, wraps the
  internal id, resolves to `{"nodes": [null, null]}` (`FULL_SUCCESS`, silently empty — the exact
  "returned zero nodes" symptom from the original run). The model's own next turn correctly
  diagnosed this ("prior nodes read... returned null... a title-based product search is required")
  and fired a corrected `products(query: "title:\"Borderlands Discovery Four\" OR
  title:\"Cloud Needle Tsolikouri\"")` query in the **same turn** it declared `status: "BLOCKED"`.
  That corrected query succeeded and returned both real products — but the harness discarded the
  result because it only re-consults the model when `status === "CONTINUE"` (fixed in this pass).
- `unavailable-variants-attempt-1-field-and-cost-errors.json` — two independent, unrelated GraphQL
  rejections for the *other* originally-failing candidate: `Field 'available' doesn't exist on type
  'InventoryLevel'` (wrong field name), then `Query cost is 2540, which exceeds the single query max
  cost limit (1000)` (nested products→variants→inventory read too large for one call).
- `margin-control-attempt-1-known-good.json` — the control candidate: `products(first: 50, query:
  "status:active")` with a bounded nested `variants(first: 100) { inventoryItem { unitCost } }`
  selection. Clean `FULL_SUCCESS`, real data, no retries needed.
