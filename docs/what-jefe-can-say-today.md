# The ten things Jefe can tell a typical merchant today

Roadmap item #8. **No new data, no new adapters, no new integrations** — every line below is
derivable from a Shopify connection that already exists, from beliefs already in
`DETERMINISTIC_BELIEF_REGISTRY` on `main`.

This is the content brief the core loop depends on. Statements (#6) and unbinding proposals
from `ACTION_REGISTRY` (#7) are machinery; **this is the thing the machinery is for.** If a
line here can't be said, that's the specification for #6, not a reason to widen the ontology.

## What the registry actually holds — measured, 2026-08-12

| | count |
|---|---|
| Beliefs in the registry | **140** |
| `category: "data"` — our ingestion diagnostics, never merchant-facing | 19 |
| Excluded by `isMerchantVisibleBeliefKey` (business-shape tranche, held back deliberately) | 7 |
| **Merchant-facing in practice** | **~114** |
| Of those, listed in `STATEMENT_FORMATTED_KEYS` — i.e. sayable in plain English | **5** |

Those five are `products.dead_stock.trailing_90d`,
`products.top_product_revenue_share.trailing_90d`,
`products.top_returned_products.trailing_180d`,
`inventory.low_cover_products.trailing_30d`,
`refunds.refunded_order_rate.all_time`.

**Five of about a hundred and fourteen.** That number is the argument for #6. Four of the ten
below are already sayable; the other six are the first tranche of statements worth writing,
chosen because a merchant would act on them.

⚠️ **`isMerchantVisibleBeliefKey` does not exclude the 19 diagnostics.** It only filters
`merchantVisible === false`, which today is the business-shape tranche. The diagnostics are
kept off the merchant's screen by a *separate* category filter in the memory view
(`bd47706`). Two gates that disagree, and the truth is in neither — which is what the
audience field (#5) is for. No live leak today because the view is the only consumer.

## The ten

Each has: what Jefe says, where it comes from, and — per the no-dead-ends invariant — whether
Jefe can **do** it, must **ask**, or can only **instruct**.

### 1. Money is sitting in stock that isn't moving
> "£X is tied up in N products that haven't sold in 90 days. Three of them account for most
> of it."

`products.dead_stock.trailing_90d` · **sayable today** · **Jefe can execute** — clearance is
live in production behind a reversible typed adapter. This is the one complete loop we have,
end to end.

### 2. One product is carrying the store
> "One product is X% of your revenue. If it goes out of stock or gets returned heavily, most
> of your month goes with it."

`products.top_product_revenue_share.trailing_90d`, `top_5_product_revenue_share` ·
**sayable today** · **instruct** — the useful move is stock cover and a second bestseller,
neither of which Jefe can do for them yet. Concentration is a risk statement, not a task.

### 3. Something is about to run out
> "At the rate it's selling, X runs out in about N days. Your last reorder took M."

`inventory.low_cover_products.trailing_30d`, `at_risk_stockout_count.trailing_30d` ·
**sayable today** · **instruct** — no purchasing adapter. Jefe gives the date and the
quantity; the merchant places the order. Already partly surfaced via Horizon heads-ups.

### 4. Returns are concentrated, not general
> "Your refund rate is X%. Over half of it is two products — here they are."

`refunds.refunded_order_rate.all_time`, `products.top_returned_products.trailing_180d` ·
**sayable today** · **instruct** — the fix is a product page, a size guide, or a supplier
conversation. Naming *which* products is what makes this useful rather than a metric.

### 5. Customers come back, or they don't
> "X% of your revenue is from people buying again. For a store selling what you sell, that's
> [high/low] — and it changes whether winning new customers or keeping them is the better
> use of your money."

`customers.repeat_customer_rate.all_time`, `repeat_revenue_share.all_time` ·
**needs a statement (#6)** · **instruct** · pairs with the business-shape tranche —
"considered, rarely repeated" vs "habitual" makes the same number mean opposite things.

### 6. You're discounting more than you think
> "Across the last 90 days you discounted X% on average. On your top sellers it was Y%."

`business.discount_depth.trailing_90d` · **needs a statement** · **instruct** — this is
often the single most surprising number a merchant sees, and it needs no cost data.

### 7. Most orders are one item
> "X% of your orders are a single item. Your average order is £Y; the ones with two or more
> items average £Z."

`orders.single_item_order_share.trailing_90d`, `multi_item_order_share`,
`average_order_value.trailing_90d` · **needs a statement** · **instruct** — bundles, a
threshold for free delivery, related-product placement.

### 8. Some things can be bought for nothing, or oversold
> "N variants are priced at zero and are live. M are showing negative stock, which means
> they've been oversold."

`catalog.zero_price_variant_count`, `inventory.negative_inventory_variant_count` ·
**needs a statement** · **instruct today, executable later** — these are real money leaks
with an unambiguous fix, and the most obviously *correct* thing on this list. A merchant
whose first Jefe message finds a £0 live product trusts the next one.

### 9. Your year has a shape
> "Last year your best month was N — about X% above your average. It starts building about
> six weeks before."

`business.peak_sales_month.all_time`, `revenue_trend.trailing_180d`,
`yoy_revenue_growth.trailing_90d` · **needs a statement** · **instruct** · requires enough
history — `historyKind` already lets Jefe state its own scope honestly ("across your last
5,000 orders since March") rather than implying a full year it doesn't have.

### 10. What Jefe can't tell you yet, and what it would take
> "I can't talk about profit — I only see what you charge, not what things cost you. Add
> cost per item in Shopify and I can tell you which of your bestsellers actually make money."

`products.cost_coverage`, `gross_margin.trailing_90d` (present but starved) ·
**needs a statement** · **instruct** — this is roadmap item #11 and it belongs *in* the ten,
not beside them. Missing data is an invitation, not a blocker; a merchant told precisely what
to add and precisely what it unlocks is being given something, not refused.

## What this exposes

1. **Only #1 completes the loop.** Nine of ten end in instruction because there is one
   adapter. That is fine and it is the design — but it means **instruct-path rendering
   (#10) is not cosmetic.** If an instruction reads as a degraded execution, nine tenths of
   what Jefe can say looks like failure. #10 should be re-ranked accordingly.
2. **Six of ten need statements.** That's #6's first tranche, chosen by merchant value
   rather than by walking the registry alphabetically.
3. **Nothing here needs cost data except #10**, which is *about* not having it. The earlier
   worry that Jefe can't say anything useful without costs is not borne out by the registry.
4. **Nothing here needs a new belief.** The gap is not what Jefe knows — it is that it can't
   phrase it, and mostly can't act on it.
5. **Two of them (#8) are hygiene, not insight**, and they may be the best first messages
   Jefe ever sends: unambiguous, checkable by the merchant in thirty seconds, and worth
   money. Credibility before cleverness.

## What would make this list better, in order

- Statements for the six (#6).
- Instruct-path rendering that reads as substantial (#10).
- Benchmarks, so "X% repeat" can become "high for a store like yours" — `benchmark-priors.server.js`
  exists; this list is a good forcing function for it.
- The business-shape tranche surfaced, so #5 and #9 can be phrased for *this* merchant
  rather than in general.
