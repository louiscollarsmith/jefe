# Live Shopify verification queries (read-only, run 2026-08-25 ~19:20 BST)

All against `jefe-local-store.myshopify.com`, API version `2026-07` (the pinned `SHOPIFY_API_VERSION`),
using the real granted access token from the local `Session` table. Read-only; nothing executed.

## 1. Do the two named anchor products actually exist?

Request:
```graphql
{ products(first: 10, query: "title:'Borderlands Discovery Four' OR title:'Cloud Needle Tsolikouri'") { nodes { id title status } } }
```

Response:
```json
{
  "data": {
    "products": {
      "nodes": [
        { "id": "gid://shopify/Product/10375206699304", "title": "Cloud Needle Tsolikouri", "status": "ACTIVE" },
        { "id": "gid://shopify/Product/10375207780648", "title": "Borderlands Discovery Four", "status": "ACTIVE" }
      ]
    }
  },
  "extensions": { "cost": { "requestedQueryCost": 6, "actualQueryCost": 3 } }
}
```

Both products exist, are ACTIVE, and are trivially found by a standard `title:'...' OR title:'...'`
search — the exact same shape of search the candidate investigation needed and, per its own stated
reasoning, could not get a match for.

## 2. Does the "Proven Products" collection referenced in the prior forensics report exist?

```graphql
{ collections(first: 10, query: "title:'Proven Products'") { nodes { id title productsCount { count } updatedAt } } }
```
→ `{ "data": { "collections": { "nodes": [] } } }` — does not exist.

Full collection list (`collections(first: 20)`) returns 10 real collections (All Wine, Red, White,
Orange, Chilled Red, Bundles, Moldova, Uruguay, New Arrivals, Under GBP 20) — no "Proven Products"
among them. Combined with `merchant_actions` having zero rows for this shop (see 02-run-identification.md),
the previously-investigated Action never durably executed on live Shopify and no longer exists in the
local database either — see 02 for the local-database-reset finding.

## 3. Granted OAuth scopes (from `Session.scope`, same token used above)

`write_products` and `read_products` are both present in the granted scope list (72 scopes total,
broadened 2026-08-24 per the standing CLAUDE.md authorization record). A `collectionAddProducts` /
`collectionUpdate` mutation is authorized to execute if a recommendation reached that stage.
