# Shopify Ingestion

Shopify ingestion is read-only. The MVP app requests `read_products`, `read_orders`, `read_all_orders`, `read_inventory`, `read_locations` and `read_customers`; no Shopify write scopes are used by this ticket.

## Admin GraphQL Client

`app/lib/shopify/admin-graphql.server.js` accepts a shop domain, access token and API version. It retries throttled requests, raises structured errors, and logs request metadata without logging tokens. `SHOPIFY_API_VERSION` defaults to `2026-07`.

## Backfill

Install-time backfill is queued after OAuth and processed by the same web service through a lightweight DB-backed job loop. OAuth should only save the session, register webhooks through Shopify app config, mark setup status and queue `shop_backfill_start`.

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
