# Shopify Ingestion

Shopify ingestion remains read-only, but local development installs also request bounded fixture write scopes so the Dev page can create dummy products, inventory, customers and test orders. The default app scope set is `read_products`, `write_products`, `read_orders`, `read_all_orders`, `write_orders`, `read_inventory`, `write_inventory`, `read_locations`, `read_customers` and `write_customers`.

## Admin GraphQL Client

`app/lib/shopify/admin-graphql.server.js` accepts a shop domain, access token and API version. It retries throttled requests, raises structured errors, and logs request metadata without logging tokens. `SHOPIFY_API_VERSION` defaults to `2026-07`.

## Backfill

Install-time backfill is queued after OAuth and processed by the same web service through a lightweight DB-backed job loop. OAuth should only save the session, register webhooks through Shopify app config, mark setup status and queue `shop_backfill_start`.

Products and 365-day orders use Shopify GraphQL bulk operations as the primary import path. Inventory, delta sync, manual debug and bulk failure recovery use the paginated GraphQL path.

The default order window is 365 days when `read_all_orders` is granted. If Shopify does not grant `read_all_orders`, the app falls back to 60 days, marks historical order access as limited, and leaves Klaviyo Winback unavailable until at least 180 days of order history is available.

Manual/dev backfill can still run:

```shell
npm run shopify:backfill -- --shop your-dev-store.myshopify.com
```

The script loads the existing offline Shopify session token for the shop, writes deduped raw source records to `ledger_events`, then upserts canonical products, variants, inventory levels, orders, line items, refunds and order-derived customer identities.

Backfill progress is stored in:

- `shops.setup_status`
- `shops.historical_order_access`
- `shops.available_order_history_days`
- `shop_backfill_statuses`
- `backfill_jobs`
- `customer_identities`

The web service loop processes one queued job at a time. Failed jobs store `last_error` and can be retried from the Dev page.

Bulk operation flow:

- start `bulkOperationRunQuery` for products or orders
- persist the bulk operation ID and Shopify status metadata on `shop_backfill_statuses`
- wake the poll/import job from `bulk_operations/finish`, with polling as fallback
- stream-download the JSONL result URL and parse line by line
- upsert products, variants, orders, line items, refunds and customer identities idempotently
- run paginated fallback if the bulk operation fails or the JSONL import cannot complete
- queue delta sync, derived metrics and finalization only after products, orders and inventory are imported

## Webhooks

Webhook routes verify `X-Shopify-Hmac-Sha256` against the raw request body before parsing JSON. Valid webhooks write a raw ledger event keyed by shop, topic and delivery/event ID. Duplicate deliveries return successfully without creating another ledger row.

Canonical upserts currently run inline for:

- `orders/create`
- `orders/updated`
- `orders/cancelled`
- `refunds/create`
- `products/create`
- `products/update`
- `products/delete`
- `inventory_levels/update`
- `bulk_operations/finish`

Compliance topics and app lifecycle topics are ledgered and handled without customer data expansion.
