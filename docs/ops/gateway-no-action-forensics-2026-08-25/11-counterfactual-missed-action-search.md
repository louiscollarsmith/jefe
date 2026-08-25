# Part 17 — Counterfactual: was there a grounded Shopify Action this run missed?

Read-only. No recommendation persisted, no mutation executed — every query below is a `products`/
`collections` read against the live store using the same granted access token the run itself had
available, at the same pinned API version (`2026-07`).

## 1. Supporting evidence

Merchant Memory (via this run's own candidate #1) already established, from real order data: only 6
of the last 30 days had orders, a 19-day gap despite 13 orders in the preceding window, and
Borderlands Discovery Four / Cloud Needle Tsolikouri as the two products with the strongest recent
momentum (the same basis the earlier, no-longer-extant Gateway run used for its "Proven Products"
collection).

## 2. Exact Shopify state (verified independently in this investigation)

```json
{ "products": { "nodes": [
  { "id": "gid://shopify/Product/10375206699304", "title": "Cloud Needle Tsolikouri", "status": "ACTIVE" },
  { "id": "gid://shopify/Product/10375207780648", "title": "Borderlands Discovery Four", "status": "ACTIVE" }
] } }
```

Both products are real, `ACTIVE`, and immediately actionable. Store has 10 existing collections (All
Wine, Red, White, Orange, Chilled Red, Bundles, Moldova, Uruguay, New Arrivals, Under GBP 20) — none
named for these two products, and no "Proven Products" collection exists (see 02, 05).

## 3. Mutation availability

`collectionCreate` (with an initial product list) or `collectionAddProducts` against an existing,
relevant collection (e.g. "New Arrivals" or "Bundles") are both standard, schema-available Shopify
Admin mutations. `write_products` is a granted scope on the session used for this run (confirmed in
`raw/live-shopify-verification.md`).

## 4. Why this would not duplicate current work

There is no current work to duplicate — 02 established that `merchant_actions` has zero rows for this
shop and no equivalent collection exists live. A merchandising placement action here would be net-new,
not a re-proposal of a completed or in-progress Action.

## 5. Why the original run missed/rejected it

Per 04/05/06: the original run's `products` query for exactly these two products returned zero nodes,
and the model treated that as conclusive without retrying a different query shape. This investigation
re-issued the equivalent search (by title, no special handling) minutes later against the same store
and token and got both products back on the first attempt.

## Verdict on this part

**YES — there is at least one grounded, executable Shopify Action (a merchandising placement
featuring these two currently-ACTIVE products) that this run's own evidence trail supports, that a
correctly-executed live query would have confirmed, and that the run rejected on a since-disproven
evidence basis.** This is the strongest single piece of evidence that `NO_ACTIONABLE_OPPORTUNITY` was
not correct for this run (00, executive summary).

This counterfactual does not re-litigate *which specific mechanism* (collection vs. bundle vs.
promotion) is the single best next action — only that the evidentiary basis for rejecting all of them
was wrong, which is the narrower and more defensible claim this investigation can actually support.
