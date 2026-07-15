# Jefe Shopify App

Embedded Shopify App Bridge app for Jefe.

This app is the home base for Daily Verdict, Inventory Guardian, Watchdog, Klaviyo Winback, Feedback, House Rules, evidence, previews, and approvals.

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

Use `DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"` for local development. The Shopify CLI will ask you to log in, connect an app, create a tunnel, and install the app on a development store. Press `P` in the CLI session to open the embedded app.

Local `.env` defaults:

```shell
DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"
SHOPIFY_API_VERSION="2026-07"
SCOPES=read_products,read_orders,read_all_orders,read_inventory,read_locations,read_customers
ENABLE_DUMMY_STORE_LOADER=true
```

## Dummy Store Data

For Ticket 003 ingestion/backfill testing, local development can load Shopify dummy data from the app home page. The MVP app config is read-only, so only use this temporary local scope override on a development store when you need the fixture writer:

```shell
SCOPES=read_locations,read_products,write_products,read_inventory,write_inventory,read_orders,write_orders
```

The loader uses the authenticated Shopify Admin token to create fixture products, variants, inventory levels, test orders and one refund. After a successful run it writes an app-installation metafield marker in Shopify, so the button is disabled for that store.

If the app shows every dummy-loader scope as missing after install, check `shopify.app.toml` first. The Shopify CLI install flow reads app scopes from that config, so `.env` alone is not enough. After changing scopes, reinstall the app or run the Shopify CLI scope update flow for the store.

Scope reasons:

- `write_products`: create/update dummy products and variants.
- `write_inventory`: set dummy inventory quantities.
- `write_orders`: create test orders and the refund fixture.
- `read_locations`: place inventory at the store's primary location.
- `read_products`, `read_inventory`, `read_orders`: support Ticket 003 ingestion/backfill reads.

Order and refund fixture creation also requires protected customer data access for the app in the Shopify Partner Dashboard. For development stores, select protected customer data for this app before loading dummy data; a full review submission is not required for apps installed only on development stores.

## Shopify Ingestion

After OAuth, Jefe queues an install-time Shopify backfill instead of blocking the callback. The same web service processes jobs from Postgres in a lightweight background loop. Products and historical orders use Shopify bulk operations first; paginated GraphQL remains the fallback for failed bulk operations, delta sync and manual debug.

Default MVP scopes:

```shell
SCOPES=read_products,read_orders,read_all_orders,read_inventory,read_locations,read_customers
```

`read_all_orders` unlocks the intended 365-day order import. If it is not granted, Jefe imports the recent 60-day window, marks setup as limited, and keeps Klaviyo Winback unavailable until enough order history is present.

After installing the app on a development store, run a local backfill with:

```shell
npm run shopify:backfill -- --shop your-dev-store.myshopify.com
```

Backfill uses the existing offline Shopify session token, writes raw source records to `ledger_events`, and upserts canonical commerce rows for products, variants, inventory levels, orders, line items, refunds and order-derived customer identities.

Webhook endpoints verify Shopify HMAC signatures before parsing payloads, dedupe by Shopify delivery/event ID where available, write raw payloads to `ledger_events`, and process canonical upserts inline.

## Onboarding

Open `/app/onboarding` inside the embedded Shopify app to complete the founder-assisted setup flow. The flow captures 3/6/12 month goals, structured House Rules and manual COGS inputs for ingested Shopify variants.

COGS can be saved as missing, estimated or confirmed. Missing COGS does not block onboarding; the shop stores a COGS completion percentage and confidence level so later verdicts can show lower-confidence margin ranges when cost data is incomplete.

## Verification

```shell
npm run typecheck
npm run lint
npm test
npm run build
```

## Scope

Implemented:

- Shopify embedded app shell
- Authenticated `/app` route
- Placeholder `Today's Verdict` page
- Placeholder cards for Daily Verdict, Inventory Guardian, Watchdog, Klaviyo Winback, Feedback Engine, and House Rules + Goals
- Postgres-backed Prisma schema for Shopify sessions, tenant data, House Rules, goals, ledger events, commerce state, actions, executions, feedback, attribution, connectors, and cost metering
- Founder-assisted onboarding for goals, House Rules, COGS inputs and completion state
- Dev-only Shopify dummy store data loader for Ticket 003 seed data
- Shopify ingestion for products, variants, inventory levels, orders, line items and refunds
- Install-time Shopify backfill queue with 365-day/60-day order access handling
- HMAC-verified Shopify webhook ingestion with ledger dedupe

Not implemented yet:

- AI recommendations
- Klaviyo integration
- Billing
- Production deployment
