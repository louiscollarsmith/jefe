# Jefe

Jefe builds and maintains a living understanding of each merchant's business.

The central product object is **Merchant Memory**: a durable, structured, versioned record of how the business works, what is known, what is inferred, what the merchant has confirmed, what remains uncertain, and what should happen next.

The product is not an analytics dashboard, chatbot or generic autonomous agent. Deterministic systems calculate reliable commerce facts; LLMs interpret evidence into memory, questions and recommendations; merchants can inspect and correct the result.

## Authoritative Context

- `context/` - current product and architecture context.
- `docs/repository_reset_audit.md` - audit for the blank-canvas repository reset.
- `docs/merchant_memory_data_model.md` - target Merchant Memory data model.
- `prompts/` - active prompts for memory synthesis, revision, questions, recommendations and consistency review.

Historical planning material from the previous product direction is archived under `docs/archive/previous_product_direction/`.

## Application

The main app lives in `apps/shopify`.

It currently includes the blank-canvas Shopify evidence layer:

- Shopify embedded app shell.
- Shopify OAuth, session storage and install state.
- Shopify product, order, customer identity and inventory backfills.
- Persisted Shopify products, variants, orders, order line items, refunds, customer identities and inventory levels.
- HMAC-verified product, order, refund and inventory webhooks.
- Source event ledger for backfill and webhook dedupe.

## Local Development

```bash
cd apps/shopify
npm install
npm run db:up
npm run setup
npm run dev
```

Useful checks:

```bash
cd apps/shopify
npm run typecheck
npm run lint
npm test
```

## Current Execution Focus

Current repository state is intentionally minimal. The next product work should build Merchant Memory on top of Shopify commerce evidence without inheriting old Daily Brief, analytics, COGS, Klaviyo or action-safety assumptions.
