# Model testing + Quiver data — handover, 2026-08-12

Lane opened 2026-08-12 to (1) build a harness for testing how Jefe's model behaves
on real inputs, and (2) connect Quiver's database as something Jefe can learn from.

Read this before touching `tools/quiver-corpus` or anything currency-related.

---

## 1. The most important finding: presentment vs base currency

**This reversed two other lanes' work and cost three landed commits. Do not
re-derive it, and do not "fix" multi-currency again without reading this.**

### The claim

`Order.currency` in Jefe's canonical commerce records is the **presentment**
currency — what the customer paid in. Every stored money **amount** is
`shopMoney` — the shop's **single base currency**. The label and the amount
describe different things.

### The evidence, in code

| Fact | Where |
| --- | --- |
| Amounts are `shopMoney` | `app/lib/ingestion/shopify/canonical.server.js:174-190` — `currentTotalPriceSet.shopMoney`, `currentSubtotalPriceSet.shopMoney`, etc. |
| `currency` is top-level `currencyCode` | `canonical.server.js:164` — `stringValue(order.currencyCode ?? order.currency)` |
| Presentment money is never fetched | `app/lib/shopify/queries.server.js` — **10** occurrences of `shopMoney`, **0** of `presentmentMoney` |
| The belief layer already knew | `app/lib/merchant-memory/shopify-derivations.server.js` `shopBaseCurrency()` — *"Every stored money amount is Shopify shopMoney… summable across orders regardless of the customer's presentment currency… revenue beliefs must not skip on it."* |

A shop has exactly one base currency and cannot vary it. So the field that varies
is presentment, **by construction**.

### What follows

- **Money totals ARE summable.** An order from a euro customer stores £144 of
  shopMoney and labels it `"EUR"`. £180 + £144 = £324 is a real total.
- **Never bucket money by `order.currency`.** Doing so reports £144 as "EUR 144" —
  attaching a *wrong* currency where there had merely been none.
- **A genuine per-customer-currency money view is impossible today.** It needs
  `presentmentMoney` **amounts**, which are not ingested. That is an ingestion
  change, not an analyst change.
- **`order.currency` is a coverage signal only** — "which currencies do customers
  pay in". `business.multi_currency_order_share.trailing_90d` already captures it
  honestly.

### The three commits it took to get here

| Commit | What it did | Why it was wrong |
| --- | --- | --- |
| pre-existing | Summed and rendered a **bare unlabelled number** | Real bug — no currency on the figure |
| `bfc2b4c` (chat 10) | **Refused** any multi-currency money total | Over-corrected; the amounts were always summable |
| `9241e8d` (this lane) | **Split by presentment currency** | Worse — mislabelled base amounts, and contradicted the belief layer on live output |
| this lane's correction | Sums, labels with base currency | Correct |

Each of us fixed the previous symptom without checking what `order.currency`
actually meant. The comment above `shopBaseCurrency()` was right the whole time.

⚠️ **The measurement that drove the wrong fixes.** I measured "113 of 222 merchants
(51%) are multi-currency" in **Quiver's warehouse**, whose ETL stores presentment
currency. **That figure does not describe Jefe's merchants** and should never be
cited for Jefe. It was used as decisive backing for a contract; it shouldn't have
been.

### ⚠️ A stale error message that reads as behaviour — and started all of this

`shopify-derivations.server.js:737` looks like a multi-currency refusal:

```js
if (!currency.ok) return skipped(definition, "blocked_by_data_quality",
  "Multiple currencies are present without conversion support.", ...)
```

**It is not.** `shopBaseCurrency()` returns `ok: distribution.entries.length >= 1`
(`:2966`) — true whenever there is **at least one** currency. So `!ok` fires only at
**zero** priced records, which the line immediately above already returns on. The
branch is effectively unreachable, and its message is left over from an older
`=== 1` version that was corrected without updating the string.

**Multi-currency shops compute money beliefs normally.** They always did.

I claimed the opposite — "the belief layer correctly refuses, the analyst doesn't" —
after reading that message without checking what `ok` meant, with the function on
screen. That single misreading seeded a refusal contract in the architecture lane
and an "honest withholding" branch in the onboarding design. Both have been
withdrawn. **Fixing the message is worth doing** (route to chat 10): it is a live
trap, not a real refusal.

### ⚠️ Related latent bug, not yet fixed (found by chat 2)

The belief layer **sums base-currency amounts** but **labels them with the dominant
presentment currency** (`shopBaseCurrency()` returns `entries[0].currency`, and
`entries` is built from `order.currency` — presentment). Where dominant presentment
≠ the shop's actual base currency, **the belief reports a correct number with the
wrong currency label.** Same bug class as §1, one layer up. Worth eyeballing in the
first real corpus output.

### Confirming query (Quiver Metabase, database id 5)

```sql
SELECT o.merchant_id, COUNT(DISTINCT p.currency_code) AS presentment_currencies
FROM orders o JOIN order_prices p ON p.order_id = o.id
WHERE p.type = 'SUBTOTAL' AND o.order_created_at >= DATEADD(month, -12, GETDATE())
GROUP BY o.merchant_id ORDER BY 2 DESC LIMIT 10;
```

Quiver stores presentment; Jefe stores base. **That is exactly why the corpus
mapper is currently wrong — see §4.**

---

## 2. Quiver data: access and shape

**Access is via the Metabase MCP** (connected by Matt, 2026-08-12). Redshift is
**database id 5**. Tables: `orders`, `order_prices`, `order_line_items`,
`merchant_order_stats`, `merchant_order_end_cursors`.

⛔ **Do not ask for a database credential.** Founder ruling: Claude runs the
queries through the MCP and writes rows to disk; the tool loads from those files.
A corpus is a snapshot, not a live feed.

⛔ **Do not use the credential committed at
`/Users/mb/quiver/lambdas/shared/redshift_database.py:16`** — it is a **production
Redshift `admin` password hardcoded in committed source**, also in
`etl-task/src/data-source.ts`. Flagged to Matt; **still needs rotating**.

**Schema provenance:** read Quiver's own TypeORM entities
(`/Users/mb/quiver/etl-task/src/entities/`), not guesswork. Verified against live
Redshift 2026-08-12 — columns match exactly.

**Scale (measured 2026-08-12):** 247 merchants, 21.6M orders, 2021-01-01 to
current. shopify 239 / 21.19M · bigcommerce 4 / 420k · magento 4 / 1,574.

**Quirks that silently produce wrong results:**
1. `orders.id` is a `uuidv4()` minted at ETL time — changes every re-import. The
   stable key is `orders.order_id`. Keying on `id` duplicates entire histories.
2. `order_prices.amount` is **integer pence**. Types: TOTAL / SUBTOTAL / SHIPPING /
   DISCOUNT / REFUND. **No TAX.**
3. `orders.customer_journey` is `JSON.stringify(<entire platform order>)` — ~2,100
   chars/order, and re-contains address/email/phone regardless of any PII decision.

**Data quality** (4,880,522 GBP orders, trailing 12m): **43,873 (0.9%) have a
DISCOUNT larger than their SUBTOTAL**; 3 exceed £100k (worst £212,755,177); 15
subtotals exceed £100k legitimately (B2B). Measured GBP-only — **do not assume
0.9% is the global rate.**

**Not in Quiver at all:** inventory/stock, product catalog (products exist only
where sold), unit cost, per-line-item prices, tax. So **dead-stock beliefs and the
clearance action cannot be simulated from this data.**

---

## 3. Corpus isolation design (built, on main)

`tools/quiver-corpus` — mapping layer + loader, 29 tests, no database required.

**Primary isolation is a separate database** (architecture ruling, 2026-08-12).
Corpus rows never enter the app's database, so there is no "which belief came from
where" problem to untangle. Filter-based isolation in a shared database was
rejected: it holds only while every merchant-facing query remembers the filter.

Guards, all fail-closed:

1. **`resolveCorpusDatabase()`** — requires `ALLOW_QUIVER_CORPUS_IMPORT=true` and
   an explicit `QUIVER_CORPUS_DATABASE_URL`. ⚠️ **It deliberately never falls back
   to `DATABASE_URL`** — most shells here have that exported at the app's own
   database, so an implicit fallback would make a forgotten variable resolve to the
   worst possible target. Managed hosts (Neon/Railway/AWS) refused unless
   acknowledged.
2. **`platform: "quiver_sim"`** + a `*.corpus.invalid` domain (RFC 2606, can never
   resolve). Tenant resolution uses `{ platform: "shopify", shopDomain }`
   (`shopify-backfill-status.server.js:54`), so a corpus shop is unreachable from
   every merchant-facing path — no session, no offline token, therefore **the
   action layer physically cannot write to a store from one**.
3. **`assertCorpusShop()`** — asserted once in `loadCorpusRows`, which is the only
   exported write entry and is tested directly.

⚠️ **On that third guard, honestly:** an earlier version also re-asserted inside
every write batch, with a comment calling it "the difference between enforced and
conventional". **Mutation testing showed it was dead** — deleting it left every
test green, because the only isolation test went through `ensureCorpusShop`, which
throws earlier. It was decoration. Removed rather than kept for comfort. **A write
path that does not come through `loadCorpusRows` is not covered and needs its own
assertion and its own test.**

**Scope (architecture ruling):** loaded data → derivations → beliefs → action
**proposals**. ⛔ Never route corpus shops through the Shopify backfill worker or
the execution adapters — both assume a session and token a corpus shop lacks.

---

## 4. Corpus currency handling — FIXED, and the reason matters

⚠️ **Quiver and Jefe store money the opposite way round.**

| | amount | label | consequence |
| --- | --- | --- | --- |
| **Jefe** | `shopMoney` (shop base currency) | presentment | amounts ARE summable; the label misleads |
| **Quiver** | `presentmentMoney` | matching presentment code | label is honest; amounts are NOT summable |

Quiver evidence: `/Users/mb/quiver/etl-task/src/etl/importOrders.ts:312-341` —
every price is `...Set.presentmentMoney.amount` with the matching `currencyCode`.

So Quiver rows cannot be poured into Jefe's canonical tables as-is. Jefe's belief
and calculation layers sum `totalPrice` across orders assuming one currency;
feeding them AED + GBP + EUR produces a confident, meaningless revenue figure —
the exact failure a test harness must never have. **Relabelling alone would not
have fixed it; the amounts themselves are in different denominations.**

**The fix, now in `map.mjs` + `load.mjs`:** the loader picks the merchant's
**dominant presentment currency** as the corpus shop's single currency — the
closest honest analogue of a shop's base currency — and orders in any other
currency are skipped and **counted** as `foreign_currency_order`. Every load
reports `baseCurrency` and `currencyCoverage`, so "we loaded this store" can never
be mistaken for "we loaded all of it".

**Once FX rates exist** (founder said yes, 2026-08-12 — see §5) the skipped orders
can be converted and coverage widened. That is the main thing FX unlocks here.

⚠️ **House of Spells (Quiver merchant 988) is NOT a valid multi-currency acceptance
test** — its "20 currencies" are presentment codes. Under the corrected
understanding a real Jefe merchant has one base currency, so there is no
production analogue of a 20-currency store.

## 5. What Matt has ruled

- **Purpose: evaluation corpus / simulation.** His words: replay real Quiver
  merchants through Jefe "as a simulation… very similar to how the LLM would be fed
  information from a Shopify store". Cross-merchant benchmark priors and
  per-merchant memory ingestion are both sanctioned but secondary. **This is
  answered — it is not an open question.**
- **PII: not a constraint.** *"Quiver owns this data and as Jefe is part of Quiver
  we can use this data in any way we want to."* ⚠️ **`AGENTS.md` has NOT been
  updated** to record this; its standing rule still says do not expose production
  customer data to AI tools. If the corpus ever runs with personal fields on,
  update `AGENTS.md` or a future session will read the rule and revert the work.
  Personal columns are currently **off by default** because the harness has no use
  for them, not as a policy gate.
- **Currency: base currency is the default lens**, per-market breakdowns are a
  feature, never a bare unlabelled sum. (Superseded in mechanism by §1 — the
  *intent* stands, the presentment-bucketing implementation does not.)
- **FX: unresolved product question.** There is **no FX/rate data anywhere in the
  tree**. Under §1 this no longer blocks revenue totals, but a genuine
  per-customer-currency view still needs it. Matt was asked; not yet answered.

---

## 6. Unfinished

| Work | State |
| --- | --- |
| Fix the mapper's currency semantics (§4) | **Do this first** |
| Pull the two corpus merchants and run the loader | Not started. Fresh Fish Shop (967) is still a good single-currency pick |
| Re-measure the 222 merchants against corrected behaviour | Not started. ⚠️ A labelled **base-currency total** is the pass now — not a refusal, and not a per-currency split |
| **Full-vs-5k-sample belief diff** for chat 2 (onboarding) | Not started, and **chat 2 is blocked on it**. They had recorded sample-first as "validated" on my volume data; I corrected that to "necessary approach, per-finding sample-safety UNTESTED". Long-tail findings (slow-movers by units) are the ones a sample plausibly misses |
| Extract shared `currencyDistribution` | Chat 10 gated it: the shared module must be the **same source** feeding `business.primary_currency` **and** the analyst, or it is the same divergence bug in a new coat. Now a tidy-up, not urgent |
| First-Insights sets for chat 2 | Owed, both branches |

---

## 7. Process lessons worth keeping

- **Read the hook's output before assuming main is busy.** I attributed three push
  failures to ref-lock contention; it was a lint error in my own code, hidden by a
  `>/dev/null` in my retry loop. The gate was right all three times.
- **To tell "my branch is broken" from "main is broken", check out main's own copy
  of the failing file in isolation and re-run.** That turned "my push is failing"
  into "main is red", which is a different problem with a different owner.
- **Mutation-test guards.** Both a security guard and a data-quality check in this
  lane passed their tests while being provably dead. Delete the assertion; if the
  suite stays green, the test was theatre.
- **`npm ci` in your own worktree.** Do not symlink `node_modules` to the main
  checkout — another session can empty it mid-run, `npx` then pulls Prisma 7, and
  you get schema "errors" that are really a missing install. ⛔ Do not "fix" the
  schema to satisfy them.
