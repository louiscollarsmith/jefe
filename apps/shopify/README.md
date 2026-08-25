# Jefe Shopify App

Embedded Shopify app for building, reviewing and using Merchant Memory.

The active app includes:

- Shopify installation, OAuth and session storage.
- Install-time and webhook-driven Shopify evidence ingestion for products, variants, orders, line items, refunds, customer identities and inventory levels.
- A source event ledger for idempotency, provenance and audit.
- Deterministic Merchant Memory beliefs, evidence, history and refresh runs.
- Store Understanding LLM inferences with lower authority than merchant-confirmed memory.
- Onboarding through Connect, optional Channels, Insights, Goals and Plan.
- Merchant Memory, Dev and Changelog pages.
- Slack channel onboarding. WhatsApp is present behind a coming-soon UI state.

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

Local PostgreSQL uses the PostgreSQL 16 pgvector image. If the named disposable
container was created before this change, recreate it once (this deletes local
development data only):

```shell
docker stop jefe-shopify-postgres
docker rm -v jefe-shopify-postgres
npm run db:up
npm run setup
```

Use `DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"` for local development. The Shopify CLI will ask you to log in, connect an app, create a tunnel and install the app on a development store. Press `P` in the CLI session to open the embedded app.

Use `npm run dev:split-worker` when you want the web server and Shopify import worker in separate processes while debugging first-install backfills or memory jobs.

## Local Environment

Common local `.env` values:

```shell
DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"
SHOPIFY_API_VERSION="2026-07"
SCOPES=read_products,write_products,read_orders,write_orders,read_all_orders,read_customers,write_customers,read_customer_events,write_pixels,read_customer_merge,write_customer_merge,read_inventory,write_inventory,write_inventory_transfers,read_inventory_transfers,read_inventory_shipments,write_inventory_shipments,read_inventory_shipments_received_items,write_inventory_shipments_received_items,read_locations,write_locations,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_third_party_fulfillment_orders,read_fulfillments,write_fulfillments,read_shipping,write_shipping,read_draft_orders,write_draft_orders,read_order_edits,write_order_edits,read_returns,write_returns,read_discounts,write_discounts,read_price_rules,write_price_rules,read_payment_terms,write_payment_terms,read_gift_cards,write_gift_cards,read_content,write_content,read_online_store_pages,read_online_store_navigation,write_online_store_navigation,read_translations,write_translations,read_locales,write_locales,read_markets,write_markets,read_marketing_events,write_marketing_events,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,read_files,write_files,read_reports,write_reports,read_privacy_settings,write_privacy_settings,read_legal_policies,read_store_credit_accounts,read_store_credit_account_transactions,write_store_credit_account_transactions
ENABLE_DEV_TOOLS=true
ENABLE_SHOPIFY_BACKFILL_LOOP=true
SHOPIFY_BACKFILL_INITIAL_DELAY_MS=5000
LLM_ENABLED=true
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.6-luna
LLM_CHAT_PROVIDER=openai
LLM_CHAT_MODEL=gpt-5.6-luna
OPENAI_API_KEY=your_openai_api_key_here
MERCHANT_CONTEXT_V2_ENABLED=true
MERCHANT_PASSIVE_MEMORY_ENABLED=true
EPISODIC_EMBEDDING_ENABLED=true
EPISODIC_EMBEDDING_MODEL=gemini-embedding-2
EPISODIC_EMBEDDING_TIMEOUT_MS=5000
```

Channel env vars are listed in `.env.example` and in the root `HANDOVER.md`.

## Active Onboarding Flow

1. Connect: ensure Shopify tenant records exist, queue evidence backfill when needed, show learning progress and first memory readiness.
2. Channels: optional Slack connection and Slack destination selection. WhatsApp is currently shown as coming soon.
3. Insights: generate and review up to five Merchant Memory-backed findings. Merchants can confirm or correct them.
4. Goals: generate 3-, 6- and 12-month goals, accept merchant coaching messages and read uploaded planning documents.
5. Plan: generate one first move from memory, insights and goals. Accepting the Plan completes onboarding.
6. Merchant Memory view: show what Jefe knows about the business with status labels and evidence summaries.

## Shopify Evidence Backfill

After OAuth, Jefe queues an evidence backfill instead of blocking the callback. The web service processes queued jobs from Postgres in a lightweight background loop.

Backfill writes source events to `ledger_events`, upserts canonical Shopify records, marks evidence domains complete and then queues Merchant Memory work. Merchant Memory, Insights, Goals and Plan jobs are retryable through the same `backfill_jobs` queue.

Run a local evidence backfill with:

```shell
npm run shopify:backfill -- --shop your-dev-store.myshopify.com
```

Webhook endpoints verify Shopify HMAC signatures before parsing payloads, dedupe by Shopify delivery/event ID where available, write source events to `ledger_events`, process evidence upserts or delete markers inline, and enqueue debounced Merchant Memory refreshes for affected categories.

## Safety Boundaries

- LLMs must never write directly to Shopify or third-party systems.
- Merchant corrections supersede model inference.
- Shopify write scopes are configured for future approved action work, but the current merchant UI must not directly execute Shopify writes.
- Do not reintroduce old Daily Brief, COGS dashboard, Klaviyo Winback or Watchdog surfaces from archived material.

## Verification

```shell
npm run typecheck
npm run lint
npm test
npm run build
```

Some persistence tests skip unless `DATABASE_URL` is configured and the local database is available.
