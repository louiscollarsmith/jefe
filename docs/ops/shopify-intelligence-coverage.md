# Shopify Intelligence Coverage

Date: 2026-08-13

Source of truth: `apps/shopify/app/lib/shopify/intelligence-coverage.server.js`

This replaces raw Shopify Admin schema percentage as the useful coverage metric. The denominator is the Shopify evidence Jefe's current intelligence needs for understanding, recommendations, investigations and outcome measurement.

## Current Coverage

```text
Current Jefe Shopify Intelligence Coverage

P0 evidence requirements:       31

Accessible via MIRROR:          23
Accessible via ON_DEMAND:        7
Unavailable / blocked:           1

Effective P0 coverage:         96.8%

P1 evidence requirements:        7

Accessible via MIRROR:           2
Accessible via ON_DEMAND:        5
Unavailable / blocked:           0

Effective P1 coverage:        100.0%
```

The count deliberately excludes evidence marked `IGNORE`, because that is not evidence Jefe is choosing to support in V1. Ignored P0/P1 evidence is still recorded with a rationale so it cannot disappear from the architecture.

## Remaining P0 Gaps

- `orders.acquisition_journey` - MIRROR strategy, but currently `NOT_INGESTED`. `ORDER_ATTRIBUTION_INGEST_ENABLED` remains off until Shopify protected-customer-data approval is confirmed. Jefe must treat absence of journey as "not asked", never as direct traffic.
- `marketing.ad_spend` - explicitly `IGNORE` for Shopify V1 because ad spend is not Shopify Admin evidence. It needs an ad connector, not broader Shopify ingestion.

## Tool Taxonomy Decision

The tool layer has two classes.

Retrieval/context tools:

- `shopify_get_order_context`
- `shopify_get_product_metadata`
- `shopify_get_customer_commerce_summary`

Analytical tools:

- `shopify_analyse_sales_mix`
- `shopify_analyse_product_performance`
- `shopify_analyse_discount_usage`
- `shopify_analyse_acquisition_quality`
- `shopify_analyse_returns`
- `shopify_analyse_fulfilment`
- `shopify_analyse_customer_retention`
- `shopify_analyse_action_outcome`

The split is intentional. Retrieval tools answer targeted "show me the context for this entity" questions. Analytical tools answer commerce questions over a bounded window so the model receives structured evidence rather than hundreds of raw Shopify records. "Why did revenue fall?" should start with sales mix, product performance, discounts, acquisition and returns rather than seven object fetches stitched together by the model.

## Representative Investigations

| Investigation | Required evidence | V1 tools |
| --- | --- | --- |
| Why did revenue fall last month? | Order totals, line items, discounts, source/channel, acquisition, refunds, catalog | `shopify_analyse_sales_mix`, `shopify_analyse_product_performance`, `shopify_analyse_discount_usage`, `shopify_analyse_acquisition_quality`, `shopify_analyse_returns` |
| Which products drive repeat purchasing? | Hash-only customer identity, order counts, customer-product relationships, line items | `shopify_analyse_customer_retention`, `shopify_analyse_product_performance` |
| Are discounts incremental or subsidising existing customers? | Discount amount/identity, customer cohorts, acquisition | `shopify_analyse_discount_usage`, `shopify_analyse_customer_retention`, `shopify_analyse_acquisition_quality` |
| Which acquisition channels produce high-quality customers? | Acquisition journey, customer spend/order count, refunds | `shopify_analyse_acquisition_quality`, `shopify_analyse_customer_retention` |
| What is causing returns to rise? | Refunds, refund line items, order lines, product context, return reasons | `shopify_analyse_returns`, `shopify_get_order_context` |
| Which products should the merchant promote? | Product performance, cost, stock, collections/tags/metafields | `shopify_analyse_product_performance`, `shopify_get_product_metadata` |
| Which stock is becoming risky? | Inventory, velocity, cost, price | `shopify_analyse_product_performance` |
| Did a recommendation work? | Action ledger, sales after action, refunds, inventory | `shopify_analyse_action_outcome`, `shopify_analyse_sales_mix` |

## Availability States

- `KNOWN`: Jefe has evidence for the relevant scope.
- `UNKNOWN`: Jefe can ask for evidence, but the result may be empty or shop-dependent.
- `NOT_INGESTED`: Jefe has not asked for or mirrored this evidence yet; absence is not a negative fact.
- `INSUFFICIENT_EVIDENCE`: some evidence exists, but coverage or sample is too thin.
- `UNAVAILABLE`: the evidence cannot be obtained from Shopify in V1, or is intentionally excluded.

These states are part of the commerce analyst packet and prompt contract. They are not only documentation. The model must not turn `UNKNOWN`, `NOT_INGESTED`, `INSUFFICIENT_EVIDENCE` or `UNAVAILABLE` into "false", "zero" or "did not happen".

## Persistence Rule

Shopify intelligence tool calls are transient structured evidence. They are not written to `MerchantMemoryEvidence` just because a query succeeded. Durable evidence is persisted only when the result materially supports a promoted belief, recommendation outcome or other durable memory artifact. Operational query visibility belongs in structured logs, not Merchant Memory evidence.
