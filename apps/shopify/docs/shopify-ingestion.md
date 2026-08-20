# Shopify Evidence Ingestion

Shopify ingestion provides the source evidence used by Merchant Memory. It currently imports products, variants, orders, order line items, refunds, customer identities derived from orders and inventory levels.

The configured Shopify scope set is:

```text
read_products,write_products,read_orders,write_orders,read_all_orders,read_customers,write_customers,read_inventory,write_inventory,write_inventory_transfers,read_locations
```

Write scopes are configured for future approved action work and synthetic/disposable-store tooling. The current merchant UI must not directly execute Shopify writes.

## Admin GraphQL Client

`app/lib/shopify/admin-graphql.server.js` accepts a shop domain, access token and API version. It retries throttled requests, raises structured errors, and logs request metadata without logging tokens. `SHOPIFY_API_VERSION` defaults to `2026-07`.

## Evidence Backfill

Install-time evidence backfill is queued after OAuth and processed by the same web service through a lightweight DB-backed job loop. OAuth saves the Shopify session, records the shop tenant/install state, and queues `shop_backfill_start`.

The worker then:

- marks evidence domains as queued or running;
- reads Shopify products, orders and inventory items through paginated Admin GraphQL;
- writes deduped source events to `ledger_events`;
- upserts `products`, `variants`, `orders`, `order_line_items`, `refunds`, `customer_identities` and `inventory_levels`;
- marks product, order, customer, refund and inventory domains complete;
- finalises the shop as `ready` when evidence import completed;
- queues Merchant Memory rebuild as independent retryable work;
- processes Merchant Insights, Goals and Plan jobs when those onboarding steps request them.

Manual/dev backfill can run:

```shell
npm run shopify:backfill -- --shop your-dev-store.myshopify.com
```

The script loads the existing offline Shopify session token for the shop and runs the same evidence upsert path.

Backfill progress is stored in:

- `shops.setup_status`
- `shops.backfill_started_at`
- `shops.backfill_completed_at`
- `shop_backfill_statuses`
- `backfill_jobs`
- `merchant_memory_refresh_runs`

Merchant Memory build progress is tracked under the `merchant_memory` backfill-status domain. A failed memory build does not change the completed raw Shopify evidence backfill result.

Bulk operation ingestion is not currently retained. A future scaling ticket should restore bulk evidence import without old COGS, dashboard or recommendation assumptions.

## Webhooks

Webhook routes verify `X-Shopify-Hmac-Sha256` against the raw request body before parsing JSON. Most valid webhooks write a raw ledger event keyed by shop, topic and delivery/event ID; duplicate deliveries return successfully without creating another ledger row. The mandatory GDPR/compliance topics are the deliberate exception — they are handled before any ledger write (see below).

Canonical evidence sync runs inline for:

- `products/create`
- `products/update`
- `products/delete`
- `orders/create`
- `orders/updated`
- `orders/cancelled`
- `refunds/create`
- `inventory_levels/update`

After canonical evidence sync, relevant product, order, refund and inventory webhooks enqueue a debounced Merchant Memory refresh for affected categories. Memory derivation does not run inline in the webhook request.

App lifecycle topics update retained install state:

- `app/scopes_update`
- `app/uninstalled`

The three mandatory GDPR/compliance topics — `customers/redact`, `customers/data_request`, `shop/redact` — are handled up front in `app/lib/ingestion/shopify/compliance.server.js`, **before** tenant resolution and **before** any ledger write. The target tenant is resolved read-only from the HMAC-verified shop domain (never from body fields), so a redaction arriving after uninstall cannot recreate or reactivate a shop. The request body — which itself carries the customer PII being erased — is never persisted verbatim: `customers/redact` deletes the customer's identity row(s) and scrubs email/name/address/phone/IP from that shop's affected order and ledger `raw_payload`s (matched by sha256 email hash + Shopify customer id, strictly shop-scoped); `shop/redact` performs a full shop-scoped teardown including existing ledger rows; `customers/data_request` records a deliberately sanitised export (masked email + aggregates + non-sensitive order fields). This replaced the earlier no-op handling that merely acknowledged the topics and had already written the raw request body to the ledger.
