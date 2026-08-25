# Part 6 — Full Gateway recommendation trace

Real run, 2026-08-25T13:33:24Z, `jefe-local-store.myshopify.com`, `openai`/`gpt-5.6-luna`,
`SHOPIFY_AGENT_SURFACE=gateway`. Full JSON:
`docs/ops/agentic-shopify-gateway-recommendation-ab/trace-gateway.json`.

## Outcome

**`RECOMMEND_ACTION`** — materialized into a real `MerchantAction` row
(`actionId: 835011b6-d7cb-4e02-9acb-c0ec2ecfae9f`, `recommendationId: e712a34a-441c-4038-a0ca-61501f66a558`).

**Title:** "Create a curated in-stock discovery collection to encourage larger baskets"

**Diagnosed problem:** 54% of trailing-90-day orders contained exactly one item; median order
size one item; only 6% contained four or more items.

**Mechanism:** A focused, in-stock discovery collection reduces the friction for a single-item
shopper to add a second product.

**Evidence actually read from live Shopify** (not asserted from Merchant Memory alone): 17 active
products, 16 selling products, specific per-product `totalInventory` figures (Borderlands Discovery
Four: 61, Cloud Needle Tsolikouri: 222, Bora Line Rebula: 176, Meadow Clock: 25, Cedar Ink: 112),
an existing "Bundles" collection containing only 2 products, and 2 active variants at zero
inventory (used to add an eligibility constraint rather than being ignored).

**Feasible write operations named:** `collectionCreate`, `collectionAddProducts` — both real,
already-reviewed catalogue operations (not invented).

**Constraints the model wrote into the recommendation itself:** no new SKUs, no price changes, no
discounts, no inventory changes, exclude zero-inventory variants, avoid duplicating the existing
Bundles collection.

## Investigation shape

- 34 total LLM calls across the whole run (discovery + all candidates investigated + this
  candidate's investigation + validation).
- This specific winning candidate's investigation: 2 LLM turns, 4 `shopify_query` tool calls, 0
  `shopify_schema` calls.
- Wall clock: 104,621 ms for the entire run (discovery through materialized Action).

## The repair loop, observed live (not simulated)

Turn 1 wrote a query selecting `collections { nodes { ... productsCount } }` — `productsCount` is a
`Count`-typed field on Shopify's real schema, requiring a sub-selection (`{ count }`), not a bare
scalar. Shopify's live GraphQL layer rejected it with:

```
Field must have selections (field 'productsCount' returns Count but has no selections.
Did you mean 'productsCount { ... }'?)
```

The model repaired it in its very next tool call by adding `{ count }`, matching Shopify's own
suggested fix exactly, and the corrected query then succeeded (see `06-generated-graphql-appendix.md`
for both documents verbatim). This is real evidence for Part 3's requirement ("If Shopify rejects a
field or arguments, return a compact error that allows the LLM to repair its query") — the rejection
came from Shopify's live response, not from the local structural validator, which is the
architecture's documented, intentional division of labour (the local validator does not have a full
output-type field graph — see `docs/ops/agentic-shopify-gateway/13-known-limitations.md` from the
prior session).

## Why 0 `shopify_schema` calls

The model apparently already knew enough about `products`/`collections`/`totalInventory` to write a
plausible query directly — consistent with Part 4's design intent ("should not be forced to call
shopify_schema before every query"). The one error it did hit was caught and repaired without
needing schema discovery at all — it inferred the fix from Shopify's own error message.
