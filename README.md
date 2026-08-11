# Jefe

Jefe builds and maintains a living understanding of each merchant's business.

The central product object is **Merchant Memory**: a durable, structured, versioned record of how the business works, what is known, what is inferred, what the merchant has confirmed, what remains uncertain, and what should happen next.

The product is not an analytics dashboard, chatbot or generic autonomous agent. Deterministic systems calculate reliable commerce facts; LLMs interpret evidence into memory, questions and recommendations; merchants can inspect and correct the result.

## Authoritative Context

- `HANDOVER.md` - practical current-state handover for Claude and non-technical operators.
- `context/` - current product and architecture context.
- `docs/merchant_memory_data_model.md` - current Merchant Memory data model.
- `prompts/` - active prompts for memory synthesis, revision, questions, recommendations and consistency review.

Historical planning material and reset audits are archived under `docs/archive/`.

## Application

The main app lives in `apps/shopify`.

It currently includes:

- Shopify embedded app shell.
- Shopify OAuth, session storage and install state.
- Shopify product, order, customer identity and inventory backfills.
- Persisted Shopify products, variants, orders, order line items, refunds, customer identities and inventory levels.
- HMAC-verified product, order, refund and inventory webhooks.
- Source event ledger for backfill and webhook dedupe.
- Deterministic Merchant Memory beliefs, evidence, history and refresh runs.
- Store Understanding LLM inference, with lower authority than merchant-confirmed memory.
- Onboarding through Connect, optional Channels, Insights, Goals and Plan.
- A merchant-facing Merchant Memory view after onboarding.
- Dev and Changelog pages.

The standalone waitlist site lives in `apps/marketing`. The synthetic Shopify operator tool lives in `tools/synthetic-shopify`.

## Local Development

```bash
cd apps/shopify
npm install
npm run db:up
npm run setup
npm run dev
```

`npm run dev` starts Shopify's standard local embedded app server. Use `npm run dev:split-worker` when you want the web server and Shopify import worker in separate processes while debugging first-install backfills.

For fast local iteration, leave `npm run dev` running and use hot reload. Do not run the full suite just to visualise each UI or backend change.

Focused checks while coding:

```bash
cd apps/shopify
npm run typecheck
npm run lint
npm test
```

Before a push or merge candidate, run the full gate:

```bash
bash scripts/preflight.sh
```

## Current Execution Focus

Improve the first merchant onboarding path that creates, reviews, corrects and uses durable Merchant Memory. Do not inherit old Daily Brief, analytics, COGS dashboard, Klaviyo Winback or Watchdog assumptions from archived material.
