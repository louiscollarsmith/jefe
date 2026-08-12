# Jefe Handover

This is the practical start-here file for a non-technical handover. Use it before asking Claude or another coding agent to change the repo.

## What Jefe Is

Jefe builds and maintains Merchant Memory: a structured understanding of how each merchant's business works.

Merchant Memory stores observed commerce facts, merchant-confirmed facts, model inferences, uncertainties, goals, constraints, operating preferences, corrections and history. The product goal is that the merchant can look at Jefe's understanding and say: "Yes. That's exactly how my business works."

Jefe is not an analytics dashboard or a generic chatbot, and **an LLM never writes directly to Shopify or any external system** — that guardrail is permanent. Shopify data and merchant input build memory; Jefe uses that memory to explain what it has learned, propose a plan, and — through a **typed, previewed, reversible adapter** — take approved actions on the store. The first action (dead-stock clearance) is **built and wired but dark behind a flag** (`CLEARANCE_EXECUTE_ENABLED`); execution goes live per-merchant, per-action-type when the founder flips it.

## Current Product Flow

The active Shopify app flow is:

1. Connect Shopify.
2. Start two independent durable jobs: a small, high-priority Merchant Memory bootstrap and the existing full-history backfill.
3. Answer one Context question while the bootstrap evaluates evidence-backed opportunities.
4. Review one grounded Insight, then approve or track its Recommendation.
5. Enter a one-time APP handoff showing only the real work Jefe is tracking. Later visits open Daily Home normally while the full backfill keeps learning in the background.

The visible first-run sequence is `CONNECT -> CONTEXT -> INSIGHT -> ACTION -> APP`. The bootstrap reads a bounded recent order window, persists referenced catalogue and inventory records first, and derives only bootstrap-safe beliefs. It may do one bounded second pass if an eligible evidence contract needs more support. It never marks a full-backfill domain complete. Initial recommendations are normally tracked for review because the only currently executable adapter is dead-stock clearance, while bootstrap deliberately does not infer dead stock.

Important current boundaries:

- LLMs interpret bounded evidence and produce structured outputs. Application code validates and persists the result.
- Bootstrap generation receives one eligible evidence contract and its cited Merchant Memory beliefs. Unsupported contracts never reach the LLM, citations and numbers remain allowlisted, and every bootstrap result retains its observed window, completeness and caveat.
- Merchant corrections and confirmations outrank model inference.
- The app must not let an LLM directly mutate Shopify, Slack, WhatsApp or any other external system.
- The typed **action/execution layer** is built for the first action (dead-stock clearance / `price_markdown`) — a proposed-row ledger (`action_executions`), the `wireClearanceExecution` approve→execute orchestrator, and the `applyClearance` typed adapter — and it is **LIVE in production** (`CLEARANCE_EXECUTE_ENABLED=true` since 2026-07-31; unsetting it reverts to the dark path — records approval, writes nothing). It is inert for a given store only until that store has costed dead stock + a non-`recommend` dial. The LLM never writes directly; only the deterministic typed adapter does, under the merchant's per-action mode (recommend / approve_execute / autonomous). OAuth scopes were trimmed to the 7 a live V1 uses (all reads + `write_products`); other `write_*` are re-added per-action as each ships. See `context/11_actions_and_autonomy.md` + `docs/ops/clearance-go-live.md`.
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
- `docs/archive/prompts/` holds historical product-level prompt sketches (unreferenced by code — several describe features that were renamed or never built). Runtime prompts and structured schemas live in app code.

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

For local visual iteration, keep `npm run dev` running and use hot reload; do not run the full suite just to inspect each UI or backend edit. Use focused checks while coding when they are useful.

Before every push or merge candidate, run the one gate (and again after any rebase):

```bash
bash scripts/preflight.sh        # prisma generate → typecheck → lint → test → build
```

~8 Claude sessions share this tree — work in a worktree off `origin/main` and push `HEAD:main` directly; a pre-push hook blocks a red push. See `AGENTS.md` → Shared Working Tree and `docs/ops/build-deploy-and-coordination.md`.

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
- `CLEARANCE_EXECUTE_ENABLED` (the first action's go-live flag — **`true` in production since 2026-07-31**; unset reverts to the dark path: records approval, writes nothing)
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
