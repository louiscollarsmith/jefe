# Shopify Admin schema coverage — what Jefe *could* know vs what it *does* know

**Date:** 2026-08-13 · **Lane:** memory/ontology · **API version:** 2026-07 (matches
`shopify.server.ts` runtime default)

Written because we kept discovering ingestion gaps one at a time — discount depth without
discount *codes*, a sales-channel belief that bins every marketplace, no marketing
attribution at all. This is the systematic version, so the next gap is a decision rather
than a surprise.

## How this was produced

Full introspection against `https://shopify.dev/admin-graphql-direct-proxy/2026-07`
(unauthenticated, HTTP 200 — no token needed to introspect). 3,552 types, 2,035 objects,
268 top-level query roots. Diffed against every GraphQL document in `apps/shopify/app`
(13 documents, extracted mechanically, not by reading).

⚠️ **The diff over-counts our usage.** A field counts as "used" if its name appears as a
token anywhere in our documents, so `node`, `nodes` and `return` register as used roots
when they aren't. Treat every "used" number below as a ceiling. The gaps are therefore
*at least* as large as stated.

## Headline

| | Available | Jefe uses | |
|---|---|---|---|
| Top-level query roots | 268 | ~13 | **95% of the API surface is never touched** |
| `Order` fields | 127 | 27 | |
| `Customer` fields | 39 | 6 | |
| `Product` fields | 63 | 13 | |
| `ProductVariant` fields | 41 | 9 | |
| `Shop` fields | 57 | 10 | |

We query: `orders`, `ordersCount`, `products`, `productsCount`, `product`,
`productVariant(s)`, `inventoryItem(s)`, `customers`, `location`, `shop`,
`metafieldDefinitions`.

The shape of the gap is consistent: we ingest **transactions and stock** thoroughly and
know almost nothing about **why the transaction happened** — where the customer came from,
what discount pulled them, which channel they bought through, whether they came back.
That is precisely the material Merchant Memory needs to hold beliefs about *how a business
works*, as opposed to *what it sold*.

## Domain-by-domain

### 1. Marketing attribution — nothing ingested (8 unused roots + `Order.customerJourneySummary`)

`customerJourneySummary` gives first/last visit with `source`, `referralCode`,
`landingPage`, `utmParameters { source medium campaign }`, plus `daysToConversion` and
`customerOrderIndex`. Also unused: `abandonedCheckouts`, `abandonment`,
`marketingActivities`, `marketingEvents`.

**Scope:** `read_orders` — *already held*. Not a scopes change.
**Open question for Matt:** protected customer data approval level in the Partner
Dashboard. Journey data is customer behavioural data; the scope is satisfied but the
app-level approval needs confirming. That is a founder call, not an agent call.

Unlocks: paid vs organic vs email vs social revenue split; a real
`business.acquisition_mix` belief; abandoned-checkout recovery as an action type.

### 2. Discount identity — amounts only, no codes (13 unused roots)

We store `totalDiscount` and per-line `discountAllocations { allocatedAmountSet }`. The
query never asks for `discountApplication`, so no code, title or type survives ingestion.
`Order.discountCodes` and `Order.discountApplications` are both unused, as are
`discountNodes`, `codeDiscountNodeByCode`, `discountCodesCount`.

Today `business.discount_depth.trailing_90d` can say a store gives away 14% of gross. It
can never say *which code*, so it cannot answer the questions that change behaviour: is a
code cannibalising full-price sales, does one bring back repeat buyers, is a permanent
`WELCOME10` just a price cut with extra steps.

**Scope:** `read_orders` / `read_discounts`. No new customer-data approval.

### 3. Selling channels — a classifier that destroys the answer (18 unused roots)

`classifySalesChannel` ([shopify-derivations.server.js:1821](../../apps/shopify/app/lib/merchant-memory/shopify-derivations.server.js))
buckets `sourceName` into `pos` / `online` / `draft` / `other`. Amazon, eBay, Faire, Etsy,
TikTok and Instagram all land in `other`.

This is the "marketplace channels being binned" finding from the 207-merchant Quiver
validation. A merchant doing 40% of revenue through Faire reads as *"60% online store, 40%
other"* — the single most interesting fact about that business, deleted by a classifier
that only ever wanted to answer "online vs in-store".

Two fixes, and the second is the right one:
- **Cheap:** widen the classifier to preserve named marketplaces. No new data — the
  `sourceName` string is already on disk and already backfilled. Makes a live belief stop
  lying, today.
- **Correct:** read `publications` / `channels` properly rather than pattern-matching a
  free-text string.

### 4. Customer depth — 6 of 39 fields, and it blocks another lane (15 unused roots)

Unused: `numberOfOrders`, `amountSpent`, `lifetimeDuration`, `statistics`, `lastOrder`,
`productSubscriberStatus`, `state`, plus the whole native segment API (`segments`,
`customerSegmentMembers`, `customerSegmentMembership`).

⭐ **Cross-lane:** the action-ontology audit (`docs/ops/action-ontology-audit-2026-08-12.md`
§5) says candidate C, customer segments, is blocked on a per-customer cohort belief that
doesn't exist. Most of the raw material for that belief is one query away, and Shopify
already computes segments natively. This is the cheapest route to unblocking a whole
action type and closing the `write_customers` scope question.

### 5. Fulfilment (16 roots), catalog/collections (20 roots), finance (3 roots)

Lower priority for Merchant Memory but worth naming: `collections` is entirely unread,
which means Jefe has no notion of how the merchant *organises* their own catalogue — a
natural evidence source for brand voice and for the merchant's own vocabulary.
`shopifyPaymentsAccount`, `tenderTransactions` and `payouts` are unread, so we infer
nothing about real settlement or fees.

## Recommended build order

1. **Widen the sales-channel classifier.** Hours, not days. No new data, no scope, no
   approval. Stops a live belief from lying. Best first build for the successor —
   smaller than brand_voice and no LLM departure.
2. **Discount code identity.** Query + canonical + a `discount_code` dimension. Turns an
   existing belief from a number into an explanation.
3. **Order attribution.** Bigger: new columns, new derivations, a new belief family.
   Gated on the protected-customer-data answer above.
4. **Customer cohort fields / native segments.** Unblocks the actions lane.

## Landmines

- **API version drift.** `.graphqlrc.ts` pins `ApiVersion.October25` for codegen while
  `shopify.server.ts` defaults to `July26`. Generated types are a different version from
  the runtime. Fix before leaning on codegen for any of the above.
- **Coverage gating is the house pattern and must be kept.** `onlineRevenueShare` refuses
  to report below 70% channel coverage. Every new belief here inherits that duty: older
  orders will lack journey and discount-application data until re-backfilled, and a
  confident answer computed from 20% of orders is worse than silence.
- **Deriving is not surfacing.** Beliefs can derive, test green and never reach the model,
  because the prompt has ~40 keyword-ranked slots. This has now bitten three surfaces.
  Verify reachability explicitly, not just a green test.

## Validated query (passes against 2026-07, `read_orders`)

```graphql
query OrderAttribution($cursor: String) {
  orders(first: 50, after: $cursor, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      discountCodes
      discountApplications(first: 10) {
        nodes {
          allocationMethod
          targetType
          ... on DiscountCodeApplication { code }
          ... on AutomaticDiscountApplication { title }
          ... on ManualDiscountApplication { title }
          ... on ScriptDiscountApplication { title }
        }
      }
      customerJourneySummary {
        customerOrderIndex
        daysToConversion
        firstVisit { source referralCode landingPage occurredAt utmParameters { source medium campaign } }
        lastVisit  { source referralCode landingPage occurredAt utmParameters { source medium campaign } }
      }
    }
  }
}
```

Raw artefacts (scratchpad, not committed): full introspection JSON, `query-coverage.json`,
`object-coverage.json` — regenerate with the introspection call above.
