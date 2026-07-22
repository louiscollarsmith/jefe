# Shopify Evidence Ingestion

Shopify ingestion is currently limited to the evidence layer needed for future Merchant Memory work: products, orders, order line items, refunds, customer identities derived from orders, and inventory levels. The retained app scope set is `read_products,read_orders,read_all_orders,read_inventory,read_locations`.

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
- finalises the shop as `ready` when evidence import completed.

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

The web service loop processes one queued job at a time. Failed jobs store `last_error` and can be retried from the Dev page.

Bulk operation ingestion is intentionally not retained in this reset because the previous implementation was coupled to old product and derived-metric paths. A future scaling ticket should restore bulk evidence import without COGS, dashboards or recommendation assumptions.

## Webhooks

Webhook routes verify `X-Shopify-Hmac-Sha256` against the raw request body before parsing JSON. Valid webhooks write a raw ledger event keyed by shop, topic and delivery/event ID. Duplicate deliveries return successfully without creating another ledger row.

Canonical evidence sync runs inline for:

- `products/create`
- `products/update`
- `products/delete`
- `orders/create`
- `orders/updated`
- `orders/cancelled`
- `refunds/create`
- `inventory_levels/update`

App lifecycle topics update retained install state:

- `app/scopes_update`
- `app/uninstalled`

Compliance topics are verified, ledgered and acknowledged without adding customer data features.
