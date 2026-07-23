# Jefe Shopify App

Embedded Shopify app foundation for Jefe.

The app currently keeps only:

- Shopify installation and authentication;
- install-time Shopify evidence backfills for products, orders, customer identities and inventory;
- persisted Shopify products, variants, orders, order line items, refunds, customer identities and inventory levels;
- product, order, refund and inventory webhook synchronisation;
- the main Jefe page, Dev page and Changelog page.

## Setup

Run commands from this directory:

```shell
cd apps/shopify
npm install
npm run db:up
npm run setup
npm run config:link
npm run dev
```

Use `DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"` for local development. The Shopify CLI will ask you to log in, connect an app, create a tunnel and install the app on a development store. Press `P` in the CLI session to open the embedded app.

Local `.env` defaults:

```shell
DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"
SHOPIFY_API_VERSION="2026-07"
SCOPES=read_products,read_orders,read_all_orders,read_inventory,read_locations
ENABLE_DEV_TOOLS=true
ENABLE_SHOPIFY_BACKFILL_LOOP=true
SHOPIFY_BACKFILL_INITIAL_DELAY_MS=5000
```

## Shopify Evidence Backfill

After OAuth, Jefe queues an evidence backfill instead of blocking the callback. The web service processes queued jobs from Postgres in a lightweight background loop; `SHOPIFY_BACKFILL_INITIAL_DELAY_MS` gives install and first page-load requests a short grace window before the first automatic job starts.

The retained Shopify scope set is:

```shell
SCOPES=read_products,read_orders,read_all_orders,read_inventory,read_locations
```

After installing the app on a development store, run a local evidence backfill with:

```shell
npm run shopify:backfill -- --shop your-dev-store.myshopify.com
```

Backfill uses the existing offline Shopify session token, writes source events to `ledger_events`, and upserts product, variant, order, line item, refund, customer identity and inventory rows.

Webhook endpoints verify Shopify HMAC signatures before parsing payloads, dedupe by Shopify delivery/event ID where available, write source events to `ledger_events`, and process evidence upserts or delete markers inline.

## Verification

```shell
npm run typecheck
npm run lint
npm test
npm run build
```
