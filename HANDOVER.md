# Jefe Handover

This is the practical start-here file for a non-technical handover. Use it before asking Claude or another coding agent to change the repo.

## What Jefe Is

Jefe builds and maintains Merchant Memory: a structured understanding of how each merchant's business works.

Merchant Memory stores observed commerce facts, merchant-confirmed facts, model inferences, uncertainties, goals, constraints, operating preferences, corrections and history. The product goal is that the merchant can look at Jefe's understanding and say: "Yes. That's exactly how my business works."

Jefe is not currently an analytics dashboard, a generic chatbot, or an autonomous agent that writes directly to Shopify or other systems. Shopify data and merchant input build memory; Jefe then uses that memory to explain what it has learned and propose a first plan.

## Current Product Flow

The active Shopify app flow is:

1. Connect Shopify.
2. Build Shopify evidence and first Merchant Memory in the background.
3. Optionally connect a channel. Slack is active; WhatsApp is visible as coming soon.
4. Review initial Insights generated from Merchant Memory.
5. Review and refine generated Goals.
6. Review and accept one generated Plan.
7. Open the Merchant Memory view: "What Jefe knows about your business."

Important current boundaries:

- LLMs interpret bounded evidence and produce structured outputs. Application code validates and persists the result.
- Merchant corrections and confirmations outrank model inference.
- The app must not let an LLM directly mutate Shopify, Slack, WhatsApp or any other external system.
- Shopify write scopes are configured for future approved action work, but the current merchant UI should not directly execute Shopify writes.
- Full post-onboarding Merchant Memory chat is not a shipped UI yet. Some service code exists because Goals uses the memory conversation infrastructure.
- React Router v8 future-flag warnings can appear during build. They are maintenance warnings, not current blockers.

## Repo Map

- `apps/shopify` is the main embedded Shopify app. It contains Shopify OAuth, session storage, evidence ingestion, webhooks, Merchant Memory, Channels, Insights, Goals, Plan, Dev, Changelog and deployment config.
- `apps/marketing` is a separate waitlist site for `mynamejefe.com`. It is an active separate service, not part of the embedded Shopify app.
- `tools/synthetic-shopify` generates and optionally imports deterministic fictional Shopify data for testing Jefe. It must only be used with disposable allowlisted stores.
- `context/` is the canonical product and architecture context. Start with `context/00_north_star.md`.
- `apps/shopify/docs/` documents current Shopify app subsystems.
- `docs/ops/` documents operational workflows such as staging deployment and changelog rules.
- `docs/archive/` contains historical material. Do not treat archived old-product direction or reset audits as current product instructions unless the founder explicitly reactivates them.
- `prompts/` contains product-level prompt references. Runtime prompts and structured schemas also live in app code.

## Local Development

For the Shopify app:

```bash
cd apps/shopify
npm install
npm run db:up
npm run setup
npm run config:link
npm run dev
```

Use `npm run dev:split-worker` when debugging the app server and Shopify import worker separately.

Useful checks:

```bash
cd apps/shopify
npm run typecheck
npm run lint
npm test
npm run build
```

For the synthetic Shopify tool:

```bash
cd tools/synthetic-shopify
npm test
```

Some Shopify persistence tests skip unless `DATABASE_URL` points at a local Postgres database.

## Environment Groups

Shopify app runtime:

- `DATABASE_URL`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES`
- `SESSION_SECRET`
- `ENABLE_DEV_TOOLS`
- `ENABLE_SHOPIFY_BACKFILL_LOOP`
- `SHOPIFY_BACKFILL_INITIAL_DELAY_MS`

LLM runtime:

- `LLM_ENABLED`
- `LLM_PROVIDER`
- `LLM_MODEL`
- `GEMINI_API_KEY`
- `LLM_TIMEOUT_MS`
- `LLM_MAX_INPUT_TOKENS`
- `LLM_MAX_OUTPUT_TOKENS`
- `LLM_MAX_RETRIES`

Channels:

- `CHANNEL_CREDENTIAL_ENCRYPTION_SECRET`
- `CHANNEL_VERIFICATION_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_REDIRECT_URI`
- `SLACK_OAUTH_SCOPES`
- Meta WhatsApp variables are present for future WhatsApp work, but WhatsApp is currently marked coming soon in the UI.

Synthetic Shopify:

- `ALLOW_SYNTHETIC_SHOPIFY_SEED`
- `SYNTHETIC_SHOPIFY_ALLOWED_SHOPS`
- `SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN` when not using the local app DB session.

Never commit real secret values.

## Staging And Deployment

The current staging workflow is documented in `docs/ops/deployment_staging_railway_neon.md`.

The Shopify app deploys from `apps/shopify` using Railway, Prisma and React Router. Railway should run Prisma migrations before starting the service. Use `/health` as the service health check.

The marketing app deploys separately from `apps/marketing`.

## What Claude Should Preserve

When asking Claude to change code, tell it to preserve:

- Merchant Memory as the central product object.
- Shopify ingestion, canonical commerce records, source ledger events, evidence and provenance.
- Merchant correction precedence over model inference.
- LLM provider boundaries and structured validation.
- Channel credential encryption and verification safeguards.
- Shopify embedded UI built with Polaris components.
- Prisma migration history unless a founder explicitly approves a database reset.
- The marketing app and synthetic Shopify tool unless the task is specifically about them.

Claude should not:

- Broaden product scope without founder approval.
- Access production secrets or production merchant/customer data.
- Remove migration history to make the repo look cleaner.
- Reintroduce old Daily Brief, Klaviyo Winback, COGS dashboard, Watchdog or prior operator-roadmap concepts from `docs/archive/previous_product_direction/`.
- Let any LLM directly write to Shopify, Slack, WhatsApp or another external system.
- Present inferred memory as fact.
