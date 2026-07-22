# Repository Reset Audit

Date: 2026-07-22

## Scope

This audit covers the repository reset and the follow-up correction that restored Shopify commerce evidence as core infrastructure. The retained application is limited to Shopify installation and authentication, Shopify evidence backfills, persisted commerce evidence, evidence webhooks, the minimum infrastructure required to operate those capabilities, and three authenticated UI routes: the main Jefe page, Dev, and Changelog.

The retained evidence layer is:

- products and variants;
- orders and order line items;
- refunds;
- customer identities derived from orders;
- inventory levels;
- source ledger events;
- queue and backfill status.

Merchant Memory, recommendations and actions remain future product work and are not implemented in this reset.

## Applications And Packages

| Component | Classification | Reason |
| --- | --- | --- |
| `apps/shopify` | Keep | Sole app in the repository. Required for Shopify embedded app installation, authentication, evidence backfills, webhook handling and retained UI routes. |
| `apps/shopify/extensions/.gitkeep` | Keep | Empty extension workspace retained because `package.json` declares `extensions/*` as the Shopify workspace package pattern. |
| `packages/` | Remove | No packages directory exists. |
| `apps/shopify/node_modules` | Keep outside source review | Installed dependency directory, not product source. |

## UI Routes

| Route/file | Classification | Reason |
| --- | --- | --- |
| `app/routes/app.tsx` | Simplify | Required authenticated embedded app shell. Old onboarding guards, Daily Brief readiness and legacy navigation are removed. |
| `app/routes/app._index.tsx` | Simplify | Retained main Jefe page. It renders only the Jefe title. |
| `app/routes/app.dev.tsx` | Simplify | Retained development page for inspecting and retrying evidence backfills. |
| `app/routes/app.changelog.tsx` | Keep | Retained changelog page. |
| `app/routes/_index/route.tsx` | Simplify | Public entry redirects shop installs into `/app` and avoids old product marketing claims. |
| `app/routes/auth.$.tsx`, `app/routes/auth.login/*` | Keep | Required for Shopify OAuth/login callback. The callback queues install-time evidence backfill. |
| `app/routes/health.tsx` | Keep | Required operational health check for deployment. |
| Product, order, refund and inventory webhook routes | Keep | Required to keep retained commerce evidence current. |
| App webhook routes: app uninstall/scopes update | Keep | Required for install lifecycle, token/scope state and cleanup. |
| Compliance webhook routes: customers data request/redact, shop redact | Keep | Minimal Shopify app compliance endpoints; they acknowledge verified webhooks without adding product surfaces. |
| Daily Brief, Revenue & Margin, Inventory Guardian, Watchdog, Klaviyo Winback, Manager Settings, onboarding, import progress | Remove | Old product implementation and UI surfaces explicitly out of scope. |
| Bulk operation webhook route | Remove | Previous bulk implementation was coupled to old product and derived-metric paths. Paginated evidence backfill is retained; a future ticket can restore bulk evidence import cleanly. |

## Navigation

| Component | Classification | Reason |
| --- | --- | --- |
| `app/routes/app.tsx` navigation items | Simplify | Retain only Changelog and Dev navigation. The main page is `/app`; old product navigation is removed. |

## Database Schemas And Migrations

| Model/group | Classification | Reason |
| --- | --- | --- |
| `Session` | Keep | Shopify session storage required by `PrismaSessionStorage`, authentication and offline Admin API access. |
| `Merchant` | Simplify | Required merchant identity for retained shop/evidence records; old product-direction fields are removed. |
| `Shop` | Simplify | Required Shopify shop identity plus install/backfill state, including historical order access metadata. Old onboarding and COGS fields are removed. |
| `ConnectorAccount` | Simplify | Minimal Shopify installation record tying a shop to granted scopes and session token reference. |
| `LedgerEvent` | Simplify | Required for webhook/backfill idempotency and source event audit. Relations to old provenance and Merchant Memory models are removed. |
| `Product`, `Variant` | Simplify | Required Shopify product evidence. Analytical and COGS fields are removed. |
| `Order`, `OrderLineItem`, `Refund` | Keep | Required Shopify order evidence for future Merchant Memory. |
| `CustomerIdentity` | Keep | Required order-derived customer evidence. This is not a customer-facing product surface. |
| `InventoryLevel` | Keep | Required Shopify inventory evidence where already implemented. |
| `ShopBackfillStatus`, `BackfillJob` | Simplify | Required to queue, retry, inspect and complete evidence backfills. Domains/job types are narrowed to evidence lifecycle work. |
| Goals, House Rules, onboarding state, COGS inputs | Remove | Old setup/product concepts; COGS product is explicitly out of scope. |
| Daily Brief, action safety, executions, feedback, provenance, holdouts, attribution, cost metering, Klaviyo credentials/artifacts | Remove | Old recommendation/action/delivery implementation. |
| Merchant Memory foundation models | Remove | This reset prepares the evidence layer for future Merchant Memory work but does not implement Merchant Memory. |
| Existing migrations | Keep as history | Existing migrations remain historical migration chain. The reset migration drops old database structures and narrows retained tables/columns. |

## Shopify Authentication And Installation

| Component | Classification | Reason |
| --- | --- | --- |
| `app/shopify.server.ts` | Keep | Configures Shopify app, API version, scopes, OAuth, session storage, webhook registration and starts the evidence backfill loop. |
| `app/services/shopify-app-url.server.js` | Keep | Resolves configured app URL for local/staging/production deployment. |
| `app/lib/ingestion/shopify/tenant.server.js` | Simplify | Required to create/reactivate merchant/shop/install records and mark uninstall inactive. |
| `app/services/shopify-scopes.server.js` | Keep | Scope helper remains useful for retained dev/backfill checks. |
| `shopify.app.toml`, `shopify.app.staging.toml`, `.env.example` | Simplify | Required Shopify app config. Scopes and webhook subscriptions now cover read-only evidence capabilities only. |

## Evidence Backfill

| Component | Classification | Reason |
| --- | --- | --- |
| `app/lib/ingestion/shopify/backfill.server.js` | Simplify | Retained paginated Shopify evidence import for products, orders, refunds, customer identities and inventory levels. COGS and old derived metric paths are removed. |
| `app/services/shopify-backfill-status.server.js` | Simplify | Retained status/job queue helpers for evidence domains. |
| `app/services/shopify-backfill-worker.server.js` | Simplify | Retained background worker loop for install start, products, orders, inventory, delta sync, finalisation, stale job recovery and retry. |
| `scripts/shopify-backfill.mjs` | Keep | Useful local/manual evidence backfill entrypoint. |
| `app/lib/ingestion/shopify/bulk.server.js` | Remove | Previous implementation was coupled to old product and COGS work. Paginated evidence backfill is sufficient for this reset. |
| Product, order and inventory GraphQL queries | Keep | Required for evidence backfill and progress estimates. |

## Evidence Persistence

| Component | Classification | Reason |
| --- | --- | --- |
| `app/lib/ingestion/shopify/canonical.server.js` | Simplify | Retains canonical upserts for products, variants, orders, line items, refunds, customer identities and inventory levels. COGS paths are removed. |
| `app/lib/ingestion/shopify/normalize.server.js` | Keep | Shared safe parsing, money, currency, date, GID and connection helpers used by evidence persistence. |
| Raw source payload storage | Keep | Used for webhook/source audit and safe reprocessing. |

## Evidence Webhooks

| Component | Classification | Reason |
| --- | --- | --- |
| `app/lib/ingestion/shopify/webhooks.server.js` | Simplify | Retains HMAC verification, dedupe, app uninstall/scopes update, compliance acknowledgement and evidence webhook handling. |
| `app/lib/shopify/webhook-hmac.server.js` | Keep | Required for Shopify webhook signature verification. |
| Product webhook route files | Keep | Required product synchronisation endpoints. |
| Order, refund and inventory level webhook route files | Keep | Required evidence synchronisation endpoints. |
| Inventory item and bulk operation webhook route files | Remove | Inventory item updates were COGS-oriented; bulk operation finish handling belonged to the old coupled importer. |

## Shared Operational Infrastructure

| Component | Classification | Reason |
| --- | --- | --- |
| `app/db.server.ts` | Keep | Prisma database connection. |
| `app/root.tsx`, `entry.server.tsx`, `vite.config.ts`, `tsconfig.json`, Dockerfile | Keep | Required React Router/Shopify app runtime and deployment. |
| `app/services/deployment-health.server.js` | Keep | Required by `/health`. |
| `app/services/changelog.server.js` | Keep | Required by retained Changelog route. |
| `apps/shopify/docs/shopify-ingestion.md`, `apps/shopify/docs/schema.md`, `apps/shopify/README.md` | Simplify | Documentation describes only retained evidence-layer foundation. |

## Removed Product Functionality

| Component | Classification | Reason |
| --- | --- | --- |
| Daily Brief, Daily Verdict, Inventory Guardian, Watchdog, Klaviyo Winback services/routes/tests/fixtures/styles | Remove | Explicit old product implementation. |
| Action safety, approvals, executions, feedback, attribution, holdouts, external artifacts | Remove | Action/recommendation infrastructure is not required by the evidence layer. |
| Merchant Memory services/tests/schema docs | Remove | Merchant Memory is future work built on evidence, not part of this reset. |
| Prompts/archive | Keep as archive only | Historical docs under archive remain non-authoritative unless reactivated. |

## Tests And Fixtures

| Component | Classification | Reason |
| --- | --- | --- |
| `tests/shopify-ingestion.test.mjs` | Simplify | Retain tests for GraphQL client, HMAC, tenant reinstall, evidence webhook dedupe, evidence backfill and job retry. |
| `tests/schema.test.mjs` | Simplify | Retain schema coverage for merchant/shop/install/ledger/evidence/backfill tables. |
| `tests/changelog.test.mjs`, `tests/deployment-health.test.mjs` | Keep/Simplify | Retained route/service tests; update scope expectations. |
| Old product tests and fixtures | Remove | They exercise removed UI, recommendation, COGS, onboarding, Klaviyo and Merchant Memory functionality. |

## Environment Variables

| Variable/group | Classification | Reason |
| --- | --- | --- |
| `DATABASE_URL`, `NODE_ENV`, `APP_ENV`, `SHOPIFY_API_VERSION`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `SHOP_CUSTOM_DOMAIN`, `SESSION_SECRET`, `ENABLE_SHOPIFY_BACKFILL_LOOP`, `ENABLE_DEV_TOOLS` | Keep/Simplify | Required runtime, Shopify auth/config, evidence backfill loop and retained dev route. |
| Klaviyo, dummy store loader, live write, Daily Brief email variables | Remove | Old feature configuration. |

## Deployment Configuration

| Component | Classification | Reason |
| --- | --- | --- |
| Dockerfile, Shopify app TOMLs, app URL resolver, health route | Keep/Simplify | Required to deploy and operate retained Shopify app. |
| Deployment docs mentioning old scopes/features | Simplify | Should match retained evidence-layer foundation. |

## Documentation And Prompts

| Component | Classification | Reason |
| --- | --- | --- |
| `AGENTS.md`, `CLAUDE.md`, `context/` | Keep | Authoritative current product direction. |
| `docs/archive/previous_product_direction/` | Keep as archive | Historical only; not retained runtime product. |
| Product plans/docs for old Daily Brief/operator roadmap | Remove or archive | Not authoritative and not part of blank-canvas runtime. |
| Current Merchant Memory context docs | Keep | Product direction, not runtime implementation. |
