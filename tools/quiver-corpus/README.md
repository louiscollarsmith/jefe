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

The mapping layer is built, tested, and **verified against the live warehouse**
(Metabase database id 5, 2026-08-12): the column list matches exactly, and a real
production order was mapped end-to-end.

| Piece | State |
| --- | --- |
| `src/quiver-schema.mjs` — the Redshift contract | built, verified live |
| `src/map.mjs` — Quiver rows → canonical records | built, 20 tests, verified on a real row |
| `src/safety.mjs` — write guards | built |
| Metabase/Redshift reader | not built — access now available |
| Loader (canonical rows → corpus database) | not built — design acked by architecture 2026-08-12 |
| Run + capture across merchants | not built |

## What is in there (measured 2026-08-12)

**247 merchants, 21.6M orders**, from 2021-01-01 and current to yesterday.

| platform | merchants | orders |
| --- | ---: | ---: |
| shopify | 239 | 21,189,908 |
| bigcommerce | 4 | 419,962 |
| magento | 4 | 1,574 |

Merchants by trailing-12-month order volume — the corpus should be **sampled**, not
imported whole, and the middle bands look most like Jefe's actual target:

| band | merchants | orders (12m) |
| --- | ---: | ---: |
| 100k+ | 13 | 2,918,969 |
| 20k–100k | 30 | 1,282,824 |
| 5k–20k | 45 | 536,986 |
| 500–5k | 69 | 142,640 |
| under 500 | 77 | 11,877 |

⚠️ **Multi-currency is real.** GBP, EUR, USD, AED, AUD and CAD all appear, and an
order can be entirely non-GBP. Never assume GBP — `selectCurrency` picks one currency
per order and reads only its rows, because summing across them would invent a number
that is not money in any currency.

## Data quality — flag, don't silently drop

Measured over 4,880,522 GBP orders in the trailing 12 months:

| check | count |
| --- | ---: |
| discount greater than subtotal | **43,873 (0.9%)** |
| discount over £100k (worst: £212,755,177) | 3 |
| subtotal over £100k (plausibly real B2B) | 15 |
| negative subtotal · missing subtotal | 0 · 0 |

Not systemic, but a 0.9% tail of nonsense discounts would skew any "average discount"
belief and those three rows would wreck a mean outright. `orderAnomalies()` flags
them and stamps the codes onto the row; the loader decides whether to quarantine.
**Flagging rather than dropping is deliberate** — "Jefe ignored 0.9% of your orders"
is a fact a reviewer needs to see, and a silent filter makes the corpus look cleaner
than the merchant's real data actually is.

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

## Scope — what the simulation covers

Architecture ruling, 2026-08-12. The simulation runs:

> loaded canonical data → derivations → beliefs → **action proposals**

⛔ **Corpus shops must NOT be routed through the Shopify-API-dependent paths** — the
backfill ingestion worker and the action-execution adapters. Both assume a Shopify
session and offline token that a corpus shop does not have: they would throw, and a
simulated execution is not a thing we want to be able to produce. The derivations
themselves are platform-agnostic (they read canonical records by
`merchantId`/`shopId`), which is why everything up to a proposal runs unchanged.

## Safety model

**Primary isolation is a SEPARATE DATABASE** (architecture ruling, 2026-08-12).
The corpus lives entirely in `QUIVER_CORPUS_DATABASE_URL`; the app's `DATABASE_URL`
never contains corpus rows. A simulation run points Jefe's derivation code at the
corpus database, and Ops is pointed at it per-environment as an explicit inspection
mode.

The alternative — corpus rows sharing the app database, isolated by a platform
filter — was rejected: filter-based isolation only holds while *every*
merchant-facing query remembers to carry the filter, and one forgotten filter puts
simulated data into a real merchant's computation. Separate databases make the
leakage surface zero rather than small.

The remaining guards are belt-and-braces on top of that, all fail-closed:

1. **`ALLOW_QUIVER_CORPUS_IMPORT=true`** must be set, and **`QUIVER_CORPUS_DATABASE_URL`**
   must name the target explicitly. This tool **never falls back to `DATABASE_URL`** —
   most shells here have it exported and pointing at the app's own database, so an
   implicit fallback would make a forgotten variable resolve to the worst target.
   Managed hosts (Neon, Railway, AWS) are refused unless explicitly acknowledged.
2. **Corpus shops use `platform: "quiver_sim"`** and a `*.corpus.invalid` domain
   (RFC 2606 — can never resolve). Secondary, not primary: it means that even inside
   the corpus database a corpus shop is unreachable from tenant resolution, which
   uses `{ platform: "shopify", shopDomain }`. No session and no token, so **the
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
