# Shopify Ingestion

Shopify ingestion is read-only. The app requests `read_products`, `read_inventory` and `read_orders`; no Shopify write scopes are used by this ticket.

## Admin GraphQL Client

`app/lib/shopify/admin-graphql.server.js` accepts a shop domain, access token and API version. It retries throttled requests, raises structured errors, and logs request metadata without logging tokens. `SHOPIFY_API_VERSION` defaults to `2026-07`.

## Backfill

Run:

```shell
npm run shopify:backfill -- --shop your-dev-store.myshopify.com
```

The script loads the existing offline Shopify session token for the shop, writes deduped raw source records to `ledger_events`, then upserts canonical products, variants, inventory levels, orders, line items and refunds.

## Webhooks

Webhook routes verify `X-Shopify-Hmac-Sha256` against the raw request body before parsing JSON. Valid webhooks write a raw ledger event keyed by shop, topic and delivery/event ID. Duplicate deliveries return successfully without creating another ledger row.

Canonical upserts currently run inline for:

- `orders/create`
- `orders/updated`
- `refunds/create`
- `products/update`
- `inventory_levels/update`

Compliance topics and app lifecycle topics are ledgered and handled without customer data expansion.
