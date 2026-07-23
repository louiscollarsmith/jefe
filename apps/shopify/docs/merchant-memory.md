# Merchant Memory Foundation

Merchant Memory is Jefe's structured understanding of a merchant's business. Raw Shopify records describe what happened; Merchant Memory records durable beliefs that can change what Jefe recommends, asks, explains or refuses to do.

The Shopify-derived implementation is deterministic only. It does not create recommendations, chat, autonomous actions, House Rules UI or merchant-facing memory pages.

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

`merchant_memory_refresh_runs` records memory build attempts, requested categories, result counts, failures, duration and deterministic derivation attempts. Each registry row finishes as `CALCULATED`, `INSUFFICIENT_DATA`, `NOT_APPLICABLE` or `BLOCKED_BY_MISSING_SOURCE`; only `CALCULATED` attempts publish active beliefs.

## Confidence

Confidence uses calibrated published bands: `0.98`, `0.95`, `0.90`, `0.85`, `0.80`, `0.70` and `0.60`. Confidence answers how likely the belief is to represent reality accurately. Sample size, freshness and completeness remain visible as quality inputs and evidence metadata rather than being treated as the belief itself.

Confidence is not random. Deterministic beliefs use named templates in `app/lib/merchant-memory/confidence-templates.server.js`, with per-belief template selection in `app/lib/merchant-memory/deterministic-confidence-registry.server.js`.

Current template families are:

- `direct_observation_v1`
- `source_fallback_v1`
- `coverage_based_v1`
- `sample_size_v1`
- `ratio_sample_coverage_v1`
- `currency_coverage_v1`
- `freshness_coverage_v1`
- `historical_coverage_v1`
- `time_series_v1`
- `anomaly_integrity_v1`
- `composite_min_v1`

Templates are deterministic, versioned and centrally recalibratable. They clamp scores to the supported range, handle missing inputs safely and return merchant-safe reasons. `composite_min_v1` confidence uses the conservative minimum component score. Evidence metadata stores `confidenceProvenance` with the template name, template version, parameters, component scores where present, raw internal score and final calibrated score. Quality flags such as `partial_history`, `low_sample` or `stale_inventory` are stored separately in evidence metadata and derivation-attempt summaries.

Do not add one confidence template per belief. Add a new template only when a new reusable confidence family exists; otherwise add belief-specific thresholds as parameters in the central confidence registry.

## Precedence

The current precedence model is:

House Rule or authoritative merchant instruction, future only: `100`
Merchant correction: `80`
Merchant confirmation: `60`
Direct platform observation, reserved: `40`
System inference: `20`

Deterministic recalculation does not silently overwrite `merchant_confirmed` or `merchant_corrected` beliefs. When recalculation proposes a value for an authoritative belief, Jefe records a history item with `derived_recalculation_skipped_authoritative_belief`.

## Derivation Versioning

Deterministic belief versions use the persisted convention `<belief-key>@vN`, for example `orders.average_order_value.all_time@v1`. The belief key supplies identity; the suffix identifies the material derivation contract.

A derivation version must be bumped when the meaning or method of a belief changes materially:

- Formula changes.
- Included or excluded source records change.
- Analysis-window semantics change.
- Currency handling changes.
- Refund treatment changes.
- Value shape changes.
- Business meaning changes.
- Confidence methodology changes materially.
- Source-of-truth selection changes.

A version bump is not required when more Shopify data arrives, the same formula produces a new value, a scheduled refresh runs, timestamps update, a source record changes normally or a bug-free recomputation occurs using the same derivation contract.

When a derived belief version changes, Jefe evaluates the new derivation, creates the new inferred row, marks the previous derived row `superseded`, sets `supersededAt` and links lineage as `newBelief.supersedesBeliefId = oldBelief.id`. This happens in one transaction so failures do not leave two active derived rows. Same-version recalculation updates the existing active derived row and records history when the value changes.

Merchant-authoritative beliefs are protected. A version bump must not supersede or overwrite `merchant_confirmed`, `merchant_corrected`, House Rules or higher-precedence merchant instructions. The new derived value may be recorded as skipped/supporting/conflicting evidence in future flows, but active merchant authority remains intact.

## Deterministic Registry

Shopify derivations are driven by `app/lib/merchant-memory/deterministic-belief-registry.server.js`. The first expanded registry materialises the selected `0A`, `0B` and `1A` tranches from the deterministic belief registry: the reviewed original 19 beliefs, data-quality guardrails and inexpensive current-state or rolling-window Shopify beliefs.

Each registered definition preserves the stable key, category, value type, calculation text, source dependencies, minimum-data rule, confidence rule, caveat, materialisation rule and LLM exposure. `internal_guardrail` beliefs are persisted only as data-quality signals and should not be presented as ordinary merchant knowledge.

Definitions that cannot be safely calculated do not create zero-valued active beliefs. They are recorded in the refresh-run result as suppressed derivation attempts with `publish: false`, observed source counts, required sources, quality flags and one of `INSUFFICIENT_DATA`, `NOT_APPLICABLE` or `BLOCKED_BY_MISSING_SOURCE`.

Time-sensitive aggregate keys use `all_stored_history` unless complete lifetime history is proven by all-order access, completed backfill and reconciliation. Evidence metadata records the exact analysis window, shop timezone, formula identifier, source record counts, coverage metrics, sample sizes, currency handling and registry tranche.

## Calculation Primitives

Shared calculation semantics live in `app/lib/merchant-memory/calculation-primitives.server.js`. Use these helpers for repeated null handling, ratio denominator behavior, currency/money rounding, averages, medians, percentiles, grouped sums and freshness intervals. Source selection and business-specific filtering remain in the domain derivation code.

Ratio helpers return `null` for zero denominators unless a caller explicitly requests zero or an exception. Money is rounded to two decimal places. Percentiles use linear interpolation. Date windows are half-open where practical, and shop timezone is used for merchant calendar day/week boundaries.

## Evidence Builders

Evidence construction uses `app/lib/merchant-memory/evidence-builders.server.js`. Current evidence templates include:

- `shopify_current_state_count`
- `shopify_windowed_order_aggregate`
- `shopify_customer_aggregate`
- `shopify_inventory_snapshot`
- `shopify_refund_aggregate`
- `shopify_currency_aggregate`
- `derived_ratio`
- `derived_trend`
- `data_quality_check`

Every deterministic evidence item records the source type, evidence type, specific summary, formula identifier, formula summary, derivation version, analysis window, source record counts, calculated timestamp, coverage metadata and confidence provenance. Evidence must remain specific enough to explain the belief without including customer names, emails, phone numbers, addresses or other PII.

## Formulas

Catalogue:

- Total products: count non-deleted `products`.
- Active products: count products where stored status is `ACTIVE`.
- Total variants: count `variants`.
- Has product variants: active product-level test for any active product with more than one active variant.
- Average product price: sum stored current active variant prices divided by priced active variant count.
- Out-of-stock products: count active products where every inventory-known variant has summed available inventory less than or equal to zero.

Orders:

- Commerce orders: stored orders with `processed_at` or `total_price`.
- Average order value: sum stored `orders.total_price` divided by priced order count. The canonical order-value policy treats `orders.total_price` as including tax and shipping where Shopify includes them, net of discounts reflected in Shopify current total price, and excludes refunds until successful refund transaction coverage is available.
- Average items per order: sum stored line-item quantities divided by commerce order count.
- First/latest order timestamps: min/max of `processed_at`, falling back to source-created timestamp.

Customers:

- Known customers: count `customer_identities`.
- Repeat customer rate: identities with `order_count > 1` divided by known customer count when the minimum customer sample is met. Customer evidence remains aggregate and does not include customer PII.

Refunds:

- Total refunded amount: sum successful refund transaction amounts in shop currency only when transaction amount coverage is complete. A refund row or nullable top-level refund amount is not treated as proof that money moved.
- Refunded order rate: distinct refunded orders divided by commerce order count.

Inventory:

- Positive available units: sum positive available inventory by active tracked variant.
- Duplicate inventory unit totals are suppressed as derivation attempts rather than publishing the same fact under two active belief keys.
- Negative inventory: tracked separately as variant count, share and absolute unit magnitude so negative stock does not cancel positive stock.
- Out-of-stock variants: active tracked variants whose summed available inventory across locations is less than or equal to zero.

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

Add the registry definition in `app/lib/merchant-memory/deterministic-belief-registry.server.js`, then add the deterministic calculation in `app/lib/merchant-memory/shopify-derivations.server.js`. The calculation must return a derived outcome only when applicability and minimum data are met; otherwise it should return a skipped outcome for refresh-run diagnostics. Application code should use `app/lib/merchant-memory/service.server.js` rather than writing belief rows directly.

Before changing an existing deterministic belief:

1. Check whether the formula or business meaning changes.
2. If yes, bump `derivationVersion`.
3. Update the machine-readable formula identifier.
4. Update tests and fixtures.
5. Confirm supersession behavior.
6. Confirm merchant-authoritative precedence.
7. Document migration or rollout implications.
8. Run parity tests for unaffected beliefs.

Example path:

Stored `orders.total_price` records of `100.00` and `50.00` become `orders.average_order_value.all_time` with value `{ amount: 75, currency: "GBP", orderCount: 2, window: "all_stored_history" }`. Evidence records the formula, source record counts and calculation timestamp.

## Future Merchant Corrections

The service already exposes `confirmBelief` and `correctBelief` for future internal/API use. A future correction UI should call those service methods so merchant authority is recorded as lifecycle history and evidence, and future deterministic refreshes cannot overwrite the correction silently.
