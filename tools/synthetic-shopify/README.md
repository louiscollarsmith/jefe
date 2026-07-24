# Synthetic Shopify Seeder

This package generates a deterministic fictional Shopify wine store for Jefe backfill and Merchant Memory belief testing. It is intentionally outside `apps/shopify` because it is an operator tool, not product runtime code.

Brand model: `Elsewhere Wine Co.`, a fictional independent UK wine retailer. Do not use real merchant data, customer data, product names, winery names, descriptions, photos or branding.

## Commands

From the repository root:

```bash
npm --prefix tools/synthetic-shopify run synthetic-shopify -- plan
npm --prefix tools/synthetic-shopify run synthetic-shopify -- seed
npm --prefix tools/synthetic-shopify run synthetic-shopify -- resume
npm --prefix tools/synthetic-shopify run synthetic-shopify -- validate
npm --prefix tools/synthetic-shopify run synthetic-shopify -- coverage
npm --prefix tools/synthetic-shopify run synthetic-shopify -- cleanup
npm --prefix tools/synthetic-shopify run synthetic-shopify -- wipe
```

Example:

```bash
npm --prefix tools/synthetic-shopify run synthetic-shopify -- seed \
  --shop jefe-wine-test.myshopify.com \
  --profile realistic \
  --seed 1042026 \
  --as-of 2026-07-23T12:00:00+01:00 \
  --dry-run
```

Supported flags:

```text
--shop
--profile
--seed
--as-of
--config
--dry-run
--resume-run
--allow-nonempty-store
--credential-source env|db|auto
```

## Safety Gates

Live writes refuse to run unless all of these are true:

- `ALLOW_SYNTHETIC_SHOPIFY_SEED=true`
- `--shop` is listed in `SYNTHETIC_SHOPIFY_ALLOWED_SHOPS`
- `SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN` is present, or the tool can read a local offline Shopify session from the app database
- Destination inspection succeeds
- Existing synthetic records are mapped back into the run manifest before new writes continue. `--allow-nonempty-store` is still reserved for disposable stores when unrelated data may be present.

All generated records use reserved synthetic identities such as `synthetic.customer.0001@example.com`. Phone numbers are omitted.

## Credentials

Explicit token:

```bash
ALLOW_SYNTHETIC_SHOPIFY_SEED=true \
SYNTHETIC_SHOPIFY_ALLOWED_SHOPS=jefe-wine-test.myshopify.com \
SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_... \
npm --prefix tools/synthetic-shopify run synthetic-shopify -- seed --shop jefe-wine-test.myshopify.com --dry-run
```

Default local app database lookup:

```bash
ALLOW_SYNTHETIC_SHOPIFY_SEED=true \
SYNTHETIC_SHOPIFY_ALLOWED_SHOPS=jefe-wine-test.myshopify.com \
npm --prefix tools/synthetic-shopify run synthetic-shopify -- seed \
  --shop jefe-wine-test.myshopify.com \
  --dry-run
```

`db` is the default. It loads `apps/shopify/.env`, uses `DATABASE_URL`, then reads the local Prisma `Session` table for an offline session where `shop` matches `--shop` and `isOnline=false`.

Use `--credential-source env` when you want to bypass the local DB and pass `SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN` directly. Use `--credential-source auto` when you want env-token-first, DB-second behavior.

The DB fallback only works after the local Shopify app has been installed/opened for that shop and `apps/shopify/node_modules/@prisma/client` exists. If the stored offline session has expired, reopen or reinstall the local app for that shop so OAuth stores a fresh session.

## Output

Runs are persisted under:

```text
tools/synthetic-shopify/output/<shop>/<run_id>/
```

Each run writes:

- `source-dataset.json`
- `manifest.json`
- `validation-report.json` when `validate` is run
- `belief-coverage.json` when `coverage` is run
- `shopify-count-validation.json`, `commercial-reconciliation.json` and `belief-coverage.json` after live imports

The manifest is the resume boundary and stores source-to-Shopify ID mappings.

## Profiles

- `smoke`: 250 non-test orders, 180 customers, 365 days.
- `realistic`: 1,250 non-test orders, 780 customers, 730 days, 24 active products, 3 archived products, 2 draft products.
- `load`: 3,000 non-test orders, 1,850 customers, 730 days.

The same `--seed` and `--as-of` reproduce the same source dataset.

## Live Import Status

The generator, planner, manifest/resume bookkeeping, validation, belief-coverage report and live Shopify import phases are implemented and tested.

Live Shopify writes are fail-closed and can create products, collections, variants, locations, inventory levels, customers, historical orders and refunds against the Admin GraphQL 2026-07 API. Inventory and refund mutations use Shopify idempotency keys, order creation is paced/retried for Shopify attempt limits, and failed mutation responses are printed with GraphQL `errors` or mutation `userErrors`.

## Wiping a Disposable Store

`wipe` previews by default:

```bash
ALLOW_SYNTHETIC_SHOPIFY_SEED=true \
SYNTHETIC_SHOPIFY_ALLOWED_SHOPS=jefe-local-store.myshopify.com \
npm --prefix tools/synthetic-shopify run synthetic-shopify -- wipe \
  --shop jefe-local-store.myshopify.com
```

Live wipe requires `--yes`:

```bash
ALLOW_SYNTHETIC_SHOPIFY_SEED=true \
SYNTHETIC_SHOPIFY_ALLOWED_SHOPS=jefe-local-store.myshopify.com \
npm --prefix tools/synthetic-shopify run synthetic-shopify -- wipe \
  --shop jefe-local-store.myshopify.com \
  --include-orders \
  --yes
```

Required Shopify scopes for product/customer wipe:

```text
read_products,write_products,read_customers,write_customers
```

If the store has non-test orders, order deletion also requires `read_orders,write_orders` and `--include-orders`. Shopify only allows deleting specific order types; other orders must be cancelled instead.

## Capability Boundaries

See [src/scenarios/capability-report.md](src/scenarios/capability-report.md). Shopify-impossible anomalies should be represented in repository fixtures for derivation tests, not by corrupting Shopify data.
