# Merchant Memory Action Coverage — Task 2

Date: 2026-08-24. Scope: broaden Merchant Memory's deterministic understanding into
customer and discount/promotion intelligence, so Jefe can recognise when the action
families Task 1 surfaced are actually worth taking. Treats Task 1's capability-discovery
output (`context/13_action_capability_registry.md`, `docs/ops/shopify-action-capabilities.md`,
`docs/ops/action-ontology-audit-2026-08-12.md`) as a read-only external dependency —
nothing in capability discovery, OAuth scopes, or the recommendation runtime was touched.

**Constraint this tranche worked under:** every new belief had to be computable from data
already ingested (already in the Postgres mirror, or an already-selected DB column just
missing from one Prisma `select`). No new Shopify reads, no new scopes. Anything that
genuinely needs a new read/scope is named in §4 as a follow-up, not built here.

**Scope state, verified directly against `shopify.app.toml`/`shopify.app.staging.toml`
(2026-08-24), not against the older, now-stale `context/13_action_capability_registry.md`
narrative:** `write_customers` **is already granted** on the dev merchant
(`scopes = "...read_customers,write_customers,..."`) — it is not a gap. `write_discounts`
is **not** in the granted scope list and is the real missing scope for any discount-write
Action today. Every scope claim below reflects this, not the 2026-08-12 "7-scope trim"
snapshot, which several scopes (`write_customers`, `write_orders`, `write_inventory`,
`write_inventory_transfers`) have since moved past.

This task describes belief work in terms of the **executable Action recommendations**
those beliefs feed under the current product model (diagnose → target → recommend →
execute or, where a scope/adapter is genuinely missing, defer) — not in terms of a
propose-vs-instruct split. Where an Action is blocked, it is named as blocked on a
specific, current gap (a scope, an adapter, or Task 1's own ongoing capability-surface
work), not wrapped in general "Jefe can always propose something" framing.

---

## 1. Action → diagnosis → evidence → belief matrix

Action families below are Task 1's output, filtered to ones where a belief gap was the
actual blocker (per the brief: no speculative ontology expansion for its own sake).

| Action family (current state) | Diagnosed problem | Required evidence | Existing belief | New belief this tranche | Data source |
| --- | --- | --- | --- | --- | --- |
| `price_set` / `set_compare_at_price` / `bulk_price_update` — executable, `write_products` held, reversible (clearance's sibling) | A price move is justified beyond dead stock — a promo, a repricing, a targeted markdown | Discount dependency; whether existing discounts move behaviour; which SKUs already absorb discount | `business.discount_depth`, `business.discount_code_mix` | `business.discount_order_value_effect`, `business.discount_concentration` | `Order.totalDiscount/totalPrice`, `OrderLineItem.discount` (already ingested, newly selected) |
| `product_status_change` / `add_tags` / `collection_add_products` — executable, `write_products` held, reversible | Which customer cohort a merchandising/winback push should target | Who is high-value and current vs high-value and gone quiet; who was just acquired and hasn't repeated yet | `customers.cohort_mix` (one-time/returning/loyal + lapsed) | `customers.rfm_segment_mix` (RFM-style champions/at_risk split), `customers.new_customer_early_repeat_rate` | `CustomerIdentity.orderCount/totalSpend/firstSeenOrderAt/lastOrderAt`, `Order.customerExternalId` |
| `discount_code_create` / discount deactivate — **blocked**: `write_discounts` is not granted (verified in `shopify.app.toml`) | Is a new/continued discount worth running at all; is an existing one working or just leaking margin; is it disproportionately reaching repeat customers rather than winning new ones | Discount usage rate/depth (have); WHICH offer (have); does a discount change basket size (missing); is it concentrated on a few SKUs (missing); is it over-indexed toward repeat buyers (missing) | `business.discount_depth`, `business.discount_code_mix` | `business.discount_order_value_effect`, `business.discount_concentration`, `business.discount_customer_mix` | Same as above |
| `customer_segment_maintain` (native Shopify Segments: lapsed/high-value/at-risk/first-time) — **`write_customers` is granted**; recommendation-readiness depends on the adapter existing, which is Task 1's build surface, not verified here | Which named segment to create/maintain, and whether it is worth the merchant's attention | A "lapsed" number alone can't tell a big spender from someone who bought a £5 sample twice | `customers.cohort_mix` (lapsed share, undifferentiated by value) | `customers.rfm_segment_mix` (adds the monetary axis: champions vs at_risk) | Same as above |
| Operator-comms winback (Jefe's own Slack/WhatsApp stack — not a Shopify write) | Who to message and how urgently | Size and revenue-at-stake of the at-risk cohort; whether new customers are already coming back on their own | `customers.cohort_mix` | `customers.rfm_segment_mix`, `customers.new_customer_early_repeat_rate` | Same as above |
| Storefront/content, fulfilment, Markets/international, returns, publishing | — | — | **Deferred, not ruled out** — pending Task 1's expanded (~810-capability) surface, which this task treats as an external, in-progress dependency. Markets is already better covered than the task brief assumed: `business.revenue_by_region`, `business.margin_by_region`, `business.online_revenue_share` already exist from `Order.shippingCountry`, already ingested, zero new reads. The rest (storefront/content, fulfilment, returns, publishing) has no belief support yet; this tranche does not build any, because Task 1's current output does not yet give a verified, live action family to target for them — a gap to revisit once that surface lands, not a domain judged not worth belief work. | |

---

## 2. Audit: implemented + candidate registry coverage (before this tranche)

Canonical registry: `apps/shopify/app/lib/merchant-memory/deterministic-belief-registry.server.js`
(a declarative array; calculation logic lives in `shopify-derivations.server.js`, keyed by
belief `key` in a `switch`). 144 beliefs before this tranche, by category:

| Category | Count | Character |
| --- | --- | --- |
| business | 37 | Currency/shape, cadence/seasonality, region/channel splits, discount depth/mix, tool stack, recommendation/clearance outcomes |
| orders | 28 | AOV, order counts, basket size, value percentiles |
| catalog | 23 | Product/variant counts, pricing distribution, variant shape |
| data | 19 | Internal ingestion-quality diagnostics — not merchant-facing |
| inventory | 16 | Stock levels, stockout risk, negative inventory |
| products | 13 | Bestsellers, dead stock, returns, margin, momentum |
| customers | 6 | See below |
| refunds | 2 | Refund rate, total refunded amount |

**Correction to a stale assumption going in:** the registry's `registryStatus` field
(`"Existing"` vs `"New candidate"`) is a leftover planning label from the tranche rollout,
**not** an implementation-status flag — 118 of 144 "New candidate" beliefs, including
every customer and discount belief that existed before this work, have live `case`
handlers and are already computed and published. The real "candidate backlog" the task
brief refers to — RFM, cohort retention, lapsed-repeat-customer share, discount
usage/depth/concentration — turned out to be **partly already built under different
names**, not a separate unimplemented list:

| Candidate named in the task brief | Status found | Where |
| --- | --- | --- |
| Customer cohort retention | Partially covered (static, all-time) | `customers.cohort_mix.all_stored_history` — one-time/returning/loyal split |
| Lapsed-repeat-customer share | **Already implemented** as a field inside cohort_mix | `lapsedSharePercent`/`lapsedRevenueAtStake`, store-relative (2× the store's own median repeat gap), gated behind ≥5 repeat customers |
| RFM at-risk share | **Not implemented** — no RFM/champion/at-risk vocabulary anywhere in the repo before this tranche | Built this tranche: `customers.rfm_segment_mix` (RFM-style, store-relative — see note below) |
| RFM champion share | **Not implemented** | Built this tranche: `customers.rfm_segment_mix` (RFM-style, store-relative) |
| RFM loyal share | Partially covered under different naming (`returning`/`loyal` by order count, not by monetary value) | `customers.cohort_mix`; this tranche adds the monetary axis |
| Discount usage/depth | **Already implemented** | `business.discount_depth.trailing_90d` |
| Discount concentration | **Not implemented** — `OrderLineItem.discount`/`discountAllocations` genuinely unused before this tranche | Built this tranche: `business.discount_concentration` |
| Discounted vs undiscounted performance | **Not implemented** | Built this tranche: `business.discount_order_value_effect` |
| "Active but ineffective" promos | **Not implemented** directly; `discount_order_value_effect` is the evidence a merchant/Jefe would use to judge this | Built this tranche |
| Discount dependency by customer cohort | **Not implemented** | Built this tranche: `business.discount_customer_mix` |

**Naming precision:** `customers.rfm_segment_mix` is **RFM-style, store-relative
segmentation**, not literal independently-scored RFM. It does not compute separate 1–5
recency, frequency and monetary scores and combine them into an RFM cube. Frequency is a
binary repeat/non-repeat filter (`orderCount >= 2`); monetary is a binary top-quartile-vs-
rest split among repeaters; recency is a binary overdue/current flag against the store's
own median repeat gap (shared with `customers.cohort_mix`). This is stated explicitly in
the belief's registry `caveat` and code comments, and is why this doc consistently says
"RFM-style" rather than "RFM" alone.

Also found, not previously known: **3 of the 6 pre-existing customer beliefs had no
plain-English statement formatter** (`repeat_revenue_share`, `average_lifetime_spend`,
`known_customer_count` derived and published but rendered nothing on the Memory surface),
and **5 pre-existing beliefs had no curated `BELIEF_RETRIEVAL_TERMS`** for chat retrieval
(`repeat_customer_rate`, `repeat_revenue_share`, `average_lifetime_spend`,
`top_customer_revenue_share`, `discount_depth` — relying on raw key-token matching, which
the registry's own comments flag as the wrong strategy for merchant vocabulary like
"discount"). Both gaps are fixed in this tranche (§6) as cheap, directly-in-scope quality
fixes, not new beliefs.

`MerchantMemoryCandidate` (the Prisma model) is **not** this candidate backlog — it is the
persistence table for LLM-extracted proposals from merchant chat messages (passive
learning), an entirely separate mechanism. Nothing in this tranche uses or changes it.

---

## 3. Missing-data analysis

For every new belief, the source classification (per the task's four buckets):

| Belief | Classification | Detail |
| --- | --- | --- |
| `customers.rfm_segment_mix.all_time` | **Already available** | `CustomerIdentity.orderCount/totalSpend/firstSeenOrderAt/lastOrderAt` — already selected (`CUSTOMER_IDENTITY_SELECT`) |
| `customers.new_customer_early_repeat_rate.trailing_180d` | **Already available** | `Order.customerExternalId` + order dates — already selected for every other belief in the file |
| `business.discount_order_value_effect.trailing_90d` | **Already available** | `Order.totalDiscount/totalPrice` + `context.quantitiesByOrder` (already computed) |
| `business.discount_concentration.trailing_90d` | **Additional field** | `OrderLineItem.discount` exists in the DB (ingested since discount identity landed 2026-08-13) but was not in the `orderLineItem.findMany` `select` used by belief derivation — added this tranche (one line, no migration, no new Shopify read) |
| `business.discount_customer_mix.trailing_90d` | **Already available** | Reuses the exact `Order.customerExternalId` ↔ `CustomerIdentity.shopifyCustomerId` join `data.customer_identity_order_coverage` already measures |

**Nothing in this tranche required a new Shopify object/query or a new OAuth read scope.**
That was a hard boundary for this pass, not a coincidence of what happened to be easy —
several genuinely higher-fidelity versions were rejected specifically because they would
have crossed it (see §4).

---

## 4. Required new reads/scopes (deferred, not built)

Two scope axes, kept separate per the task brief.

**Write scopes required to execute:**

- `write_customers` — **already granted** on the dev merchant (verified in
  `shopify.app.toml`/`shopify.app.staging.toml`, 2026-08-24). `customer_segment_maintain`
  is not blocked on scope. Whether an executing adapter exists for it is Task 1's build
  surface — not verified by this task, and not assumed either way.
- `write_discounts` — **not granted**. This is the one real, verified scope gap this
  tranche's work depends on downstream: `discount_code_create` and any discount-deactivate
  Action stay blocked until it is added. The belief work here (`discount_order_value_effect`,
  `discount_concentration`, `discount_customer_mix`) is what makes that Action
  well-targeted and safely scoped the moment the scope and adapter exist — it does not
  itself unblock execution.

**Read scopes/ingestion that would unlock a materially better version of a belief built
this tranche, deferred because they cross the no-new-reads boundary:**

- A true multi-point cohort-retention **curve** (month-0/1/2/3 retention %, not just the
  single "did they repeat within 90 days" leading indicator built this tranche) is possible
  with data already held, but is materially more code/complexity for a first cut — a
  reasonable next-tranche candidate, still zero new scope.
- Discount-cohort targeting (e.g. "which RFM-style segment is most discount-dependent")
  crosses `customers.rfm_segment_mix` with `business.discount_customer_mix`; both are now
  built and this cross is a follow-up read-only composition, not a new ingestion.
- Shopify **native customer segments/tags** (`customers.native_segments`,
  `products.tags` — both `ON_DEMAND`/`UNKNOWN` per `intelligence-coverage.server.js`) would
  let a discount-concentration or RFM-style belief speak in the merchant's own segment
  language instead of Jefe's derived buckets — needs a new on-demand read, deferred.
- Storefront/content, fulfilment, Markets/international, returns, publishing: no belief
  built, no read requested this tranche — **deferred pending Task 1's expanded
  (~810-capability) surface**, treated here as an external, in-progress dependency, not as
  domains ruled out on the merits. Once that surface names a verified, live action family
  in one of these domains, the same action→diagnosis→evidence→belief method in §1 applies
  to it.

---

## 5. Prioritised belief tranche (selection)

Scored by recommendation leverage × frequency × confidence × actionability ÷
implementation/data complexity, per the task's formula. The 5 built beliefs cleared the
bar; several considered ideas did not and were dropped rather than built for symmetry:

**Built (5):**
1. `customers.rfm_segment_mix.all_time` — high leverage (directly targets winback/segment
   actions), low complexity (reuses cohort_mix's tested rhythm logic).
2. `business.discount_concentration.trailing_90d` — high leverage (distinguishes
   clearance-vs-code decisions), low complexity (one new select field + a top-N ranking,
   the same shape as `products.top_returned_products`).
3. `business.discount_order_value_effect.trailing_90d` — high leverage (the "is this
   discount working" question directly), low complexity.
4. `business.discount_customer_mix.trailing_90d` — medium-high leverage (over-discounting
   detection), low complexity (reuses an existing join).
5. `customers.new_customer_early_repeat_rate.trailing_180d` — medium leverage (a leading
   indicator, not a decision by itself), low complexity.

**Considered, not built (deliberately, not from running out of time):**
- A full cohort-retention curve — real value, meaningfully more complexity for a first
  pass; a good candidate for the next tranche, not this one.
- Product-level "which products do VIP customers buy" (would inform collection curation) —
  no concrete action family in Task 1's BUILDABLE set currently consumes it; would be
  manufacturing a belief ahead of a proven use, against the brief's explicit instruction.
- Storefront/content, fulfilment, Markets, returns, publishing beliefs — deferred pending
  Task 1's expanded capability surface (§4), not ruled out. Markets specifically turned out
  to already have reasonable coverage (`revenue_by_region`/`margin_by_region`), so there
  was no real gap to fill there today.
- Balancing belief counts across categories for symmetry — not done, deliberately; the
  brief is explicit that equal representation is not the goal.

---

## 6. Implemented tranche (what actually shipped)

All 5 in `apps/shopify/app/lib/merchant-memory/deterministic-belief-registry.server.js`
+ `shopify-derivations.server.js` (calculation) + `belief-statement.server.js` (plain-English
rendering). Every belief: has an explicit `minimumData` gate and `confidenceRule`/
`confidenceTemplate`; returns a structural `INSUFFICIENT_DATA`/`NOT_APPLICABLE` outcome
(never a guessed zero) below its threshold; states its `dependencies`/`refreshCadence`
explicitly; is `llmExposure: "Core or category retrieval"` so it reaches the recommendation
context on the same terms as every other core belief (no recommendation-runtime code
changed — this is registry metadata the existing runtime already reads); is
merchant-visible by the registry's default audience rule.

- **`customers.rfm_segment_mix.all_time`** — RFM-style, store-relative segmentation (see
  §2 naming note: not independently-scored R/F/M dimensions). Repeat customers
  (orderCount ≥ 2) crossed on top-spend-quartile vs not, and overdue vs current against the
  store's own median repeat gap (the exact rhythm `customers.cohort_mix` already
  establishes — factored into a shared `repeatGapRhythm()` helper so the two beliefs can
  never disagree about who's overdue). Segments: `champions`, `at_risk`, `loyal`, `fading`;
  one-time buyers reported as a count. Gated on ≥10 known customers and ≥5 repeat customers
  with an established rhythm.

- **`customers.new_customer_early_repeat_rate.trailing_180d`** — of customers whose first
  stored order falls **90 to 180 days ago** (not "the trailing 180 days" — see below), the
  share whose second order followed within 90 days. Built from raw order dates (not the
  `CustomerIdentity` first/last aggregate, which cannot say when a customer's *second*
  order landed) — no new ingestion, just a different read of data already loaded for every
  other belief in the file. **Right-censoring fix (post-review):** the first version
  counted every customer first seen in the trailing 180 days, including ones acquired in
  the last few days who have not yet had the 90-day follow window elapse — counting them as
  "hasn't repeated" would silently bias the rate downward purely from recency. The
  acquisition window is now restricted to 90–180 days ago (a customer's first order must be
  old enough that their full 90-day follow window has already closed), and customers still
  inside that window are excluded from both the numerator and denominator rather than
  scored as a non-repeat. Regression-tested: `tests/customer-discount-intelligence-tranche.test.mjs`
  asserts that adding recently-acquired (right-censored) customers changes neither the
  count, the repeat count, nor the share, and that a cohort made up entirely of censored
  customers is withheld as insufficient data rather than silently publishing a rate built
  from an empty fully-observed sample.

- **`business.discount_order_value_effect.trailing_90d`** — discounted vs undiscounted
  priced orders in-window, compared on average order value and average items per order,
  with a lift percentage. Explicitly stated as correlational, not causal (task requirement:
  "do not turn correlation into causal truth" — both the registry `caveat` and the
  statement formatter say so).

- **`business.discount_concentration.trailing_90d`** — `OrderLineItem.discount` summed per
  product over the window, ranked, with the top-5 products' share of total window discount
  spend. Required adding `discount: true` to the line-item Prisma `select` (already-ingested
  column, zero new Shopify reads).

- **`business.discount_customer_mix.trailing_90d`** — repeat customers' share of discounted
  orders vs their share of all orders in-window; an over-index ratio flags when discounts
  are over-represented among repeat customers relative to their overall order share.
  **Wording fix (post-review):** the first version's caveat and statement said discounts
  were reaching people "who would have bought anyway" — a counterfactual claim about what a
  customer would have done without the discount, which order data cannot support. The
  registry `caveat`, the derivation's code comment, and the statement formatter now all
  state only the observed distribution (over/under-representation), never the
  counterfactual.

**Quality-bar fixes bundled in (not new beliefs, closing gaps §2 found):**
- Statement formatters added for 3 previously-unformatted existing beliefs:
  `customers.known_customer_count`, `customers.repeat_revenue_share.all_time`,
  `customers.average_lifetime_spend.all_time`.
- `BELIEF_RETRIEVAL_TERMS` added for the 5 new beliefs and for 5 existing beliefs that had
  none: `repeat_customer_rate`, `repeat_revenue_share`, `average_lifetime_spend`,
  `top_customer_revenue_share`, `discount_depth`.

---

## 7. Tests and coverage

`apps/shopify/tests/customer-discount-intelligence-tranche.test.mjs` (11 tests):
constructed-fixture derivation tests with hand-verified expected values for each of the 5
new beliefs, boundary/insufficient-data tests (RFM rhythm gate, early-repeat sample gate,
discount-effect dual-sample gate), statement-formatter assertions including a "stays
silent below the threshold" case for `discount_customer_mix`, and two right-censoring
regression tests added post-review for `new_customer_early_repeat_rate`: adding
recently-acquired (still-within-follow-window) customers must not move the published
numbers at all, and a cohort made up entirely of such customers must be withheld as
insufficient data rather than publish a rate computed from zero fully-observed customers.

`apps/shopify/tests/merchant-memory.test.mjs`: updated the 4 registry-size invariants
(144 → 149) that the new entries shifted; the pre-existing `cohort_mix` behavioural tests
were re-run unchanged after the `repeatGapRhythm()` extraction to confirm the refactor is
behaviour-preserving.

Full existing suite re-run and green after these changes:
`merchant-memory.test.mjs`, `belief-statement-tranche.test.mjs`,
`belief-statement-new-beliefs.test.mjs`, `business-shape-beliefs.test.mjs`,
`multi-currency-money-beliefs.test.mjs`, `belief-audience.test.mjs`,
`belief-retrieval-vocabulary.test.mjs`, `recommendation-belief-exposure.test.mjs`.
Typecheck and lint clean on every touched file (pre-existing, unrelated errors exist on
this branch in `app/lib/shopify/agentic-runtime/*` and `shopify-backfill-worker.server.js` —
confirmed via `git diff --stat` that this tranche touches none of those files; left
untouched per the instruction not to modify the recommendation runtime).

---

## 8. Before/after recommendation-visible domain distribution

Deterministic belief registry, by category:

| Category | Before | After | Δ |
| --- | --- | --- | --- |
| customers | 6 | 8 | +2 |
| business | 37 | 40 | +3 |
| catalog | 23 | 23 | — |
| orders | 28 | 28 | — |
| data | 19 | 19 | — |
| inventory | 16 | 16 | — |
| products | 13 | 13 | — |
| refunds | 2 | 2 | — |
| **Total** | **144** | **149** | **+5** |

Core-exposed beliefs (`llmExposure` includes "core" — the set the recommendation runtime's
existing `llmExposure` semantics already surface to Luna; no runtime code changed, this is
the registry-driven count going up because the registry did):

| Category | Before | After |
| --- | --- | --- |
| customers | 6 | 8 |
| business | 27 | 30 |
| catalog | 23 | 23 |
| orders | 28 | 28 |
| products | 13 | 13 |
| inventory | 2 | 2 |
| **Total** | **99** | **104** |

This is a domain-coverage change, not a manufactured-diversity one: customers moved from
"how many come back" (one static split) to "who specifically is worth protecting, and is
the newest cohort's retention improving" (two beliefs, one static one leading); discounts
moved from "how much, and which offer" (two beliefs) to also covering "is it working,
where is it concentrated, and who is it landing on" (three more). Products, orders,
catalog and inventory are unchanged — nothing was added there to balance counts, and
nothing existing was thinned to make the new domains look proportionally larger.

---

## Central question, answered

Customer and discount understanding now cover targeting (who — RFM-style segments), timing
(when — early-repeat leading indicator, correctly excluding customers who haven't had time
to repeat yet, and discount effect over time), and safety/confidence (concentration and
customer-mix guard against a discount or segment Action being recommended on a false
premise, stated as observations rather than causal or counterfactual claims). Storefront/
content, fulfilment, Markets, returns and publishing were deliberately left alone this
tranche — not because they don't justify belief work, but because Task 1's expanded
(~810-capability) surface is still landing and this task treats it as an external
dependency rather than guessing ahead of it. Markets already had more coverage than the
task brief assumed going in.

The one verified, current execution gap this tranche's beliefs feed into is
`write_discounts` — not granted, confirmed directly in `shopify.app.toml`. `write_customers`
is already granted, so `customer_segment_maintain` is scope-unblocked today; whether its
adapter exists to make the Action recommendation executable is Task 1's build surface, not
something this task verified or should assume either way.
