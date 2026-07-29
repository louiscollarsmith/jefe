# Railway + Neon Staging Deployment

## What staging is

`staging` is the only hosted environment for Jefe right now. It is not production.

The active staged Shopify product is the Merchant Memory onboarding app: Connect, optional Channels, Insights, Goals, Plan and the Merchant Memory view. It is not the old Daily Brief/operator dashboard and it is no longer only the reset-era evidence layer.

Flow:

1. Push or merge to `main`.
2. Railway receives the GitHub webhook.
3. Railway builds `apps/shopify`.
4. Railway runs Prisma migrations against Neon.
5. Railway starts the web service.
6. The Shopify development app, `Jefe Staging`, loads the Railway URL.

No staging branch, production branch, manual promotion, release tags, branch protection or deploy approval is required for this phase.

## Repo inspection

- Framework/runtime: Shopify embedded app using React Router 7, Vite and Node.js.
- App directory: `apps/shopify`.
- Package manager: npm, pinned by `apps/shopify/package-lock.json`.
- Node version: `>=20.19 <22 || >=22.12`.
- Database library: Prisma with PostgreSQL.
- Build command: `npx prisma generate && npm run typecheck && npm run lint && npm test && npm run build`.
- Start command: `npm run start`.
- Migration command: `npm run migrate`.
- Seed command: no database seed script exists. Commerce evidence is imported after app install by the evidence backfill queue, or manually by running `npm run shopify:backfill -- --shop <dev-store>.myshopify.com`.
- Reset command: no scripted reset exists. Reset by creating a fresh Neon branch/database or manually clearing staging test data, then run `npm run migrate`.
- Docker required: no.
- Railway Railpack/Nixpacks viable without Docker: yes, with the Railway service rooted at `apps/shopify` and `apps/shopify/railway.json` as the config file.
- Docker note: `apps/shopify/Dockerfile` generates Prisma Client at build time so `npm run start` can run even when Railway bypasses the `docker-start` setup script.

## Railway

Create or use:

- Project: `Jefe`
- Environment: `staging`
- Service: `web`
- Source: GitHub repo
- Branch: `main`
- Auto deploy: enabled
- Root directory: `apps/shopify`
- Config file path: `/apps/shopify/railway.json`
- Builder: Railpack
- Health check path: `/ready` (readiness — 503 when the DB is unreachable, so a failed deploy isn't promoted). `/health` is liveness (always 200).

Use Railway's generated URL first, for example:

```txt
https://<railway-staging-url>
```

`https://staging.usejefe.com` can be added later as an optional custom domain.

## Neon

Create or use:

- Project: `jefe`
- Database: `staging`
- Role/user: staging app user
- Region: choose the closest available EU/UK region while the initial pilot is UK/EU-oriented.

Store the pooled or standard Neon connection string in Railway as:

```txt
DATABASE_URL=postgresql://...
```

Do not commit the connection string.

## Environment variables

Configure these on the Railway `staging` environment:

```txt
NODE_ENV=production
APP_ENV=staging

SHOPIFY_API_VERSION=2026-07
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=https://<railway-staging-url>
SCOPES=read_products,write_products,read_orders,write_orders,read_all_orders,read_customers,write_customers,read_inventory,write_inventory,read_locations,write_locations
SHOP_CUSTOM_DOMAIN=

DATABASE_URL=
SESSION_SECRET=

ENABLE_DEV_TOOLS=true
ENABLE_SHOPIFY_BACKFILL_LOOP=true
SHOPIFY_BACKFILL_INITIAL_DELAY_MS=5000

LLM_ENABLED=true
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.1-flash-lite
GEMINI_API_KEY=
LLM_TIMEOUT_MS=8000
LLM_MAX_INPUT_TOKENS=6000
LLM_MAX_OUTPUT_TOKENS=900
LLM_MAX_RETRIES=1

CHANNEL_CREDENTIAL_ENCRYPTION_SECRET=
CHANNEL_VERIFICATION_SECRET=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=
SLACK_OAUTH_SCOPES=chat:write,chat:write.public,channels:read,groups:read
```

Notes:

- The app currently reads Shopify scopes from `SCOPES`, not `SHOPIFY_SCOPES`.
- `SESSION_SECRET` **is** read by the app (channel credential-encryption and unsubscribe-link HMAC fallbacks) — keep it set and stable across deploys; rotating it invalidates existing channel credentials and unsubscribe links.
- The app requests evidence-read scopes plus product, customer, order, inventory and location write scopes for future approved action previews and execution.
- The current merchant UI must not directly execute Shopify writes. External writes still require typed adapters, idempotency keys, previews, approval gates and blast-radius caps.
- Slack is the active channel connector. WhatsApp env vars may exist for future work, but WhatsApp is currently marked coming soon in the app UI.

## Shopify app

Create one Partner Dashboard app:

- App name: `Jefe Staging`
- App URL: `https://<railway-staging-url>`
- Redirect URL: `https://<railway-staging-url>/auth/callback`

The repo includes `apps/shopify/shopify.app.staging.toml`. Before deploying Shopify config, replace:

- `client_id = ""` with the Partner Dashboard app client ID.
- `https://<railway-staging-url>` with the Railway URL.

Then from `apps/shopify` run:

```shell
npm run deploy -- --config shopify.app.staging.toml
```

Webhook routes registered in staging config:

```txt
https://<railway-staging-url>/webhooks/app/scopes_update
https://<railway-staging-url>/webhooks/app/uninstalled
https://<railway-staging-url>/webhooks/inventory_levels/update
https://<railway-staging-url>/webhooks/orders/create
https://<railway-staging-url>/webhooks/orders/updated
https://<railway-staging-url>/webhooks/orders/cancelled
https://<railway-staging-url>/webhooks/products/create
https://<railway-staging-url>/webhooks/products/update
https://<railway-staging-url>/webhooks/products/delete
https://<railway-staging-url>/webhooks/refunds/create
```

Compliance webhook route files also exist and should be configured in the Partner Dashboard if Shopify does not derive them from CLI config:

```txt
https://<railway-staging-url>/webhooks/customers/data_request
https://<railway-staging-url>/webhooks/customers/redact
https://<railway-staging-url>/webhooks/shop/redact
```

## Migrations

Railway runs the pre-deploy command from `apps/shopify/railway.json`:

```shell
npm run migrate
```

That maps to:

```shell
prisma migrate deploy
```

Use this against Neon staging only. Do not run migrations against any production database from this environment.

## Seed and reset

There is no general `db:seed` or `db:reset` script yet.

For staging evidence data:

1. Install `Jefe Staging` on the Shopify development store.
2. Confirm `ENABLE_SHOPIFY_BACKFILL_LOOP=true`.
3. Open the authenticated app Dev page.
4. Queue or process evidence backfill from the Dev page if needed.
5. Run `npm run shopify:backfill -- --shop <dev-store>.myshopify.com` if a CLI evidence backfill is needed.

For reset:

1. Create a fresh Neon staging branch/database or manually clear staging dummy data.
2. Update `DATABASE_URL` in Railway if the connection string changed.
3. Trigger a Railway redeploy so `npm run migrate` runs.
4. Reinstall or reopen the Shopify dev app and run evidence backfill if needed.

Follow-up: add explicit `db:seed` and `db:reset` scripts once staging fixtures are stable.

## Health check and smoke test

Railway's healthcheck path is `/ready` (readiness). `/health` is the liveness endpoint (always 200) used for the manual smoke test below:

```txt
GET /health
```

Expected JSON:

```json
{
  "ok": true,
  "environment": "staging"
}
```

Smoke test after deploy:

1. Open `https://<railway-staging-url>/health`.
2. Confirm the JSON response is healthy.
3. Open the Shopify dev store.
4. Open the embedded `Jefe Staging` app.
5. Confirm the app authenticates and loads the latest navigation.
6. Walk through onboarding on a development store: Connect, optional Channels, Insights, Goals, Plan, then Merchant Memory.

## Matt workflow

1. Matt asks Claude, Conductor or another coding agent to make a change.
2. Code is committed to a branch or directly to `main`.
3. Code is pushed or merged to `main`.
4. Railway auto-deploys the `web` service in `staging`.
5. Matt opens the Shopify dev store.
6. Matt refreshes `Jefe Staging`.
7. The latest version is live.

Matt should not need to run Shopify locally, know Railway internals, run migrations manually, know secret values or manually promote releases.

## Debugging failed deploys

Check in this order:

1. Railway build logs for failed install, Prisma generate, typecheck, lint, test or build output.
2. Railway deploy logs for failed `npm run migrate` or `npm run start`.
3. Neon dashboard for connection errors, suspended compute, wrong database or exhausted connection limits.
4. Railway variables for missing `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` or `SCOPES`.
5. Shopify Partner Dashboard for App URL, redirect URL and webhook URL mismatches.
6. `/health` for basic service reachability.

## Rollback

Rollback is simple while there are no real clients:

1. Revert the bad commit.
2. Push or merge the revert to `main`.
3. Railway auto-deploys the reverted code to `staging`.

If a migration caused the issue, write a forward-fix migration rather than manually editing historical migration files.

## Safety defaults

Staging should contain development-store evidence data only and should not be connected to production merchant data.

LLM prompts must use bounded summaries, not production customer data. Do not commit secrets or paste real merchant/customer data into AI tools.

Historical reset audits and the old Daily Brief/operator roadmap live under `docs/archive/` and are not current deployment instructions.
