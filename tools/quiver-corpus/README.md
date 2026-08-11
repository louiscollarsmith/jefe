# Quiver corpus — real merchants as simulated Jefe stores

Maps merchants from **Quiver's Redshift warehouse** into Jefe's canonical commerce
records, so the real Jefe pipeline can be run against real businesses and what it
concludes can be inspected.

The point is to test the model on real inputs. A Quiver merchant becomes a simulated
Jefe shop; from there **nothing is special** — deterministic beliefs, evidence,
insights, goals, plan and action chat all run unchanged, because the corpus writes to
the same canonical tables Shopify ingestion writes to. There is no parallel pipeline
to keep in sync, and no bespoke parser: one typed mapping at the edge, the same class
of thing as `shopify-ingestion`.

Inspect the results in **`apps/ops`** — it already renders Merchant Memory, insights,
goals, plan, action chat, action ledger and LLM cost per merchant. Point it at the
corpus database.

## Status

**The mapping layer is built and tested. The data pull is not connected yet** — it is
waiting on Metabase MCP access (founder is setting this up, 2026-08-12). Everything in
`src/` was written against Quiver's own ETL entity definitions rather than sampled
live data, so connecting the pull should be a config change rather than a rewrite.

| Piece | State |
| --- | --- |
| `src/quiver-schema.mjs` — the Redshift contract | built |
| `src/map.mjs` — Quiver rows → canonical records | built, 18 tests |
| `src/safety.mjs` — write guards | built |
| Metabase/Redshift reader | **blocked on access** |
| Loader (canonical rows → corpus database) | not built |
| Run + capture across merchants | not built |

## Schema provenance

Every column this tool reads was taken from Quiver's own TypeORM entities, not from
guesswork or a live sample:

- `/Users/mb/quiver/etl-task/src/entities/{Order,OrderLineItem,OrderPrice,MerchantOrderStats}.ts`
- `/Users/mb/quiver/lambdas/shared/redshift_database.py` (query shapes)

⚠️ **This is a copy of a contract we do not own.** `etl-task` is a separate repo on its
own cadence. A column that changes there surfaces here as a wrong number, not an
error. Re-verify against those files before trusting a surprising result.

## What Quiver can and cannot tell us

Carried through: order timing, value (total/subtotal/shipping/discount/refund),
currency, channel, delivery geography (city, postcode prefix, country), whether Quiver
delivered it, tags, payment gateway, SKUs and units sold, and a stable pseudonymous
customer reference so repeat-purchase behaviour survives.

**Not available at all** — `QUIVER_COVERAGE_GAPS` in `src/quiver-schema.mjs`, stamped
onto every corpus shop so the limitation travels with the data:

- **No inventory or stock** → dead-stock beliefs and the clearance action cannot fire.
- **No product catalog** → products exist only where they were sold; a SKU that never
  sold is invisible.
- **No unit cost** → revenue only, never true margin.
- **No per-line prices** → units sold per product works; revenue per product does not.
- **No tax**, and **refunds are order-level totals** rather than per-line detail.

A belief that needs any of these must not be derived from a corpus shop. An insight
built on absent data reads exactly like one built on evidence — that is the specific
risk this list exists to manage.

## Safety model

Three independent guards, all fail-closed:

1. **`ALLOW_QUIVER_CORPUS_IMPORT=true`** must be set, and **`QUIVER_CORPUS_DATABASE_URL`**
   must name the target explicitly. This tool **never falls back to `DATABASE_URL`** —
   most shells here have it exported and pointing at the app's own database, so an
   implicit fallback would make a forgotten variable resolve to the worst target.
   Managed hosts (Neon, Railway, AWS) are refused unless explicitly acknowledged.
2. **Corpus shops use `platform: "quiver_sim"`** and a `*.corpus.invalid` domain
   (RFC 2606 — can never resolve). The app resolves tenants with
   `{ platform: "shopify", shopDomain }`, so a corpus shop is unreachable from every
   merchant-facing path. It has no Shopify session and no token, which means **the
   action layer physically cannot write to anyone's store from a corpus shop.**
3. **Customer emails are hashed** with a required ≥16-char salt, matching the app's
   existing `CustomerIdentity.emailHash` posture.

### On personal data

The founder ruled on 2026-08-12 that Quiver owns this data and Jefe may use it, so
this is **not** a prohibition. Personal columns are simply **off by default** because
the harness has no use for them — the belief layer reads order timing, value, channel
and SKU velocity, none of which need a customer's name or address. Pass
`includePersonalFields: true` to carry them.

`orders.customer_journey` is excluded **unconditionally**: it is
`JSON.stringify(<entire platform order>)`, so it is unbounded in size and re-contains
the address, email and phone regardless of that flag.

⚠️ If the corpus is ever run with personal fields on, `AGENTS.md` should record the
ruling — its standing rule reads "do not expose production customer data to AI tools",
and a future session will otherwise read that and revert this.

## Run the tests

```bash
cd tools/quiver-corpus && npm test
```

No database and no credentials required — the mapping layer is pure functions, which
is what allowed it to be built and verified before access existed.
