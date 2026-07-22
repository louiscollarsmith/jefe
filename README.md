# Jefe

Jefe builds and maintains a living understanding of each merchant's business.

The central product object is **Merchant Memory**: a durable, structured, versioned record of how the business works, what is known, what is inferred, what the merchant has confirmed, what remains uncertain, and what should happen next.

The product is not an analytics dashboard, chatbot or generic autonomous agent. Deterministic systems calculate reliable commerce facts; LLMs interpret evidence into memory, questions and recommendations; merchants can inspect and correct the result.

## Authoritative Context

- `context/` - current product and architecture context.
- `docs/repository_reorientation_audit.md` - audit of the previous implementation and what to retain/adapt.
- `docs/merchant_memory_data_model.md` - target Merchant Memory data model.
- `docs/first_merchant_execution_plan.md` - shortest credible path for merchant one and Percival readiness.
- `prompts/` - active prompts for memory synthesis, revision, questions, recommendations and consistency review.

Historical planning material from the previous product direction is archived under `docs/archive/previous_product_direction/`.

## Application

The main app lives in `apps/shopify`.

It currently includes useful foundations for the new model:

- Shopify embedded app shell.
- Shopify OAuth, backfill, webhooks and HMAC verification.
- Canonical commerce records and source event ledger.
- COGS, House Rules, goals, Daily Brief, Watchdog, Inventory Guardian, Klaviyo draft and action-safety infrastructure.
- Additive Merchant Memory persistence foundation.

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

Optimise for one complete Merchant Memory loop:

1. Connect Shopify.
2. Import enough data.
3. Generate deterministic evidence.
4. Produce initial Merchant Memory.
5. Let the merchant confirm and correct it.
6. Save a revised version.
7. Generate one useful recommendation from confirmed memory.
