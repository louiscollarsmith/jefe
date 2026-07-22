# Merchant Memory Foundation

Merchant Memory is Jefe's structured understanding of a merchant's business. Raw Shopify records describe what happened; Merchant Memory records durable beliefs that can change what Jefe recommends, asks, explains or refuses to do.

This first implementation is deterministic only. It does not create recommendations, chat, autonomous actions, House Rules UI or merchant-facing memory pages.

## Schema

`merchant_memory_beliefs` stores the current and historical belief rows. Each belief has a stable semantic `key`, a `category`, structured `value_json`, `value_type`, lifecycle `status`, confidence, observed/evaluated timestamps and precedence.

Current statuses are:

- `inferred`
- `merchant_confirmed`
- `merchant_corrected`
- `superseded`
- `obsolete`

`merchant_memory_evidence` stores provenance separately from beliefs. Evidence references source type, source reference, evidence type, summary, metadata and observed timestamp. It records calculations and aggregate source counts rather than copying raw Shopify payloads or customer PII.

`merchant_memory_belief_history` records lifecycle and value changes so Jefe can explain how understanding changed over time.

`merchant_memory_refresh_runs` records memory build attempts, requested categories, result counts, failures and duration.

## Confidence

Confidence uses a documented `0.0` to `1.0` scale. Direct deterministic counts from stored records use high confidence. Calculations from incomplete source data, missing inventory quantities or mixed currencies use lower confidence. Merchant confirmations and corrections are authoritative and use confidence `1.0`.

Confidence is not random. Each belief stores `confidence_reason` and each evidence item stores the formula and source record counts used for the calculation.

## Precedence

The current precedence model is:

House Rule or authoritative merchant instruction, future only: `100`
Merchant correction: `80`
Merchant confirmation: `60`
Direct platform observation, reserved: `40`
System inference: `20`

Deterministic recalculation does not silently overwrite `merchant_confirmed` or `merchant_corrected` beliefs. When recalculation proposes a value for an authoritative belief, Jefe records a history item with `derived_recalculation_skipped_authoritative_belief`.

## Initial Beliefs

The first derivation pipeline supports reliable beliefs from current Shopify evidence tables:

- `business.store_name`
- `business.primary_currency`
- `catalog.total_product_count`
- `catalog.active_product_count`
- `catalog.total_variant_count`
- `catalog.has_product_variants`
- `catalog.average_product_price`
- `catalog.out_of_stock_product_count`
- `orders.total_order_count`
- `orders.average_order_value.all_time`
- `orders.average_items_per_order.all_time`
- `orders.first_order_at`
- `orders.latest_order_at`
- `customers.known_customer_count`
- `customers.repeat_customer_rate.all_time`
- `refunds.total_refunded_amount.all_time`
- `refunds.refunded_order_rate.all_time`
- `inventory.total_tracked_units`
- `inventory.out_of_stock_variant_count`

Time-sensitive aggregate keys include `all_time` where they use all stored history. Evidence metadata also records `analysisWindow`.

## Formulas

Catalogue:

- Total products: count non-deleted `products`.
- Active products: count products where stored status is `ACTIVE`.
- Total variants: count `variants`.
- Has product variants: total variant count is greater than total product count.
- Average product price: sum stored variant prices divided by priced variant count.
- Out-of-stock products: count active products where every variant with known inventory has summed available inventory less than or equal to zero.

Orders:

- Commerce orders: stored orders with `processed_at` or `total_price`.
- Average order value: sum stored `orders.total_price` divided by priced order count. Refunds are reported separately rather than subtracted.
- Average items per order: sum stored line-item quantities divided by commerce order count.
- First/latest order timestamps: min/max of `processed_at`, falling back to source-created timestamp.

Customers:

- Known customers: count `customer_identities`.
- Repeat customer rate: identities with `order_count > 1` divided by known customer count.

Refunds:

- Total refunded amount: sum stored refund amounts.
- Refunded order rate: distinct refunded orders divided by commerce order count.

Inventory:

- Total tracked units: sum stored `inventory_levels.available` where present.
- Out-of-stock variants: variants whose summed available inventory across locations is less than or equal to zero.

## Backfill Integration

After Shopify evidence domains complete and `backfill_finalize` marks the shop ready, the worker queues `merchant_memory_rebuild`. Memory build status is tracked separately with the `merchant_memory` domain in `shop_backfill_statuses` and with `merchant_memory_refresh_runs`.

A failed memory build does not make the raw Shopify backfill unsuccessful. It remains retryable through the existing `backfill_jobs` retry path.

## Webhook Refresh

Relevant Shopify webhooks enqueue the same `merchant_memory_rebuild` job with requested categories. The `backfill_jobs` uniqueness constraint on shop and job type debounces repeated webhook bursts into one queued memory refresh.

Current webhook mapping:

- Product create/update/delete: catalogue and inventory.
- Order create/update/cancelled: orders, customers, refunds, inventory and sometimes business currency.
- Refund create: refunds, orders and business currency.
- Inventory-level update: inventory and catalogue.

Webhook handlers only enqueue refresh work after raw canonical records are updated; they do not run full memory derivation inline.

## Adding A Belief

Add the deterministic calculation in `app/lib/merchant-memory/shopify-derivations.server.js`, return a structured value, choose a stable key, include a formula and source record counts in evidence metadata, then add tests for empty data and recalculation. Application code should use `app/lib/merchant-memory/service.server.js` rather than writing belief rows directly.

Example path:

Stored `orders.total_price` records of `100.00` and `50.00` become `orders.average_order_value.all_time` with value `{ amount: 75, currency: "GBP", orderCount: 2, window: "all_stored_history" }`. Evidence records the formula, source record counts and calculation timestamp.

## Future Merchant Corrections

The service already exposes `confirmBelief` and `correctBelief` for future internal/API use. A future correction UI should call those service methods so merchant authority is recorded as lifecycle history and evidence, and future deterministic refreshes cannot overwrite the correction silently.

