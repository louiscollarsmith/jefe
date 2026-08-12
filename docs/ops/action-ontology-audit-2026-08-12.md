# Action Ontology Audit — 2026-08-12

Standing record for the action-ontology lane, opened on Matt's call today: *"action
ontology needs to increase hugely. Price markdown is just not enough. It needs to be
so much more."*

Everything below is verified against `origin/main` @ `8456e9d`. Scope→resource mappings
verified against shopify.dev, not recalled. Nothing here has been built; this is the
audit that precedes building, so the first three things built are the right three.

---

## 1. The state, in numbers

| | Count | |
|---|---|---|
| Derived belief keys | **134** | `shopify-derivations.server.js` |
| Beliefs that detect a *fixable situation* | **~26** | the rest are descriptive/diagnostic |
| Beliefs that **name the records** an action could target | **3** | `dead_stock`, `low_cover_products`, `top_returned_products` |
| Registered action types | **1** | `price_markdown` |
| Beliefs with an action attached | **1** | `products.dead_stock.trailing_90d` |
| Write scopes requested | **4** | `write_products`, `write_orders`, `write_customers`, `write_inventory` |
| Write scopes any code exercises | **1** | `write_products` |

The honest framing is *not* "133 beliefs are missing actions" — most are diagnostics
(AOV, currency mix, dispersion, coverage metrics) where no verb is meaningful. It is:
**roughly 26 beliefs see a fixable problem, and one of them can do anything about it.**

## 2. Belief audit — situation-detecting beliefs with no action

Split by whether the belief already names the records to act on. This distinction is the
whole ballgame: a belief carrying `items[].productId` can drive a resolver today; a
scalar count needs its own targeting query first.

### Tier 1 — targetable (names records, ready to drive a resolver)

| Belief | Carries | Action? |
|---|---|---|
| `products.dead_stock.trailing_90d` | `productId`, `unitsOnHand`, `trappedCapital` | ✅ `price_markdown` |
| `inventory.low_cover_products.trailing_30d` | `productId`, `daysOfCover`, `available`, `dailyVelocity` | ❌ **none** |
| `products.top_returned_products.trailing_180d` | `productId`, `returnedUnits`, `refundValue`, `returnRatePercent` | ❌ **none** |
| `products.product_momentum.trailing_60d` | `topRiser`/`topFaller` only (not a full list) | ❌ **none** |

### Tier 2 — detects a real defect, but scalar (count only, no target list)

Actionable only if the primitive re-queries. **It can** — see §3.

Stock defects · `inventory.negative_inventory_variant_count` / `_share` /
`_unit_magnitude` · `inventory.out_of_stock_variant_count` ·
`catalog.out_of_stock_product_count` · `inventory.at_risk_stockout_count.trailing_30d` ·
`inventory.stale_inventory_level_share`

Catalog defects · `catalog.zero_price_variant_count` / `_share` ·
`catalog.draft_product_count` · `data.duplicate_sku_count` ·
`data.missing_sku_variant_share` · `products.cost_coverage`

Demand · `products.no_sale_active_product_count.trailing_90d` ·
`refunds.refunded_order_rate.all_time` · `business.discount_depth.trailing_90d` ·
`products.gross_margin.trailing_90d` · `business.margin_by_region.trailing_90d`

Customers · `customers.repeat_customer_rate.all_time` ·
`customers.top_customer_revenue_share.all_time` · `business.days_since_last_order`
— **all scalar. There is no per-customer cohort belief at all**, which is why the
`write_customers` candidates are the ones with a real missing link.

### Tier 3 — descriptive (~108)

AOV, order counts, price percentiles, currency, history span, all `data.*` coverage
metrics. These inform recommendations. No verb applies. Not a gap.

### Detected outside the belief layer

`store-hygiene-scan.server.js` already finds five concrete defects — missing
description, missing cost, missing product type, missing SKU, refund clustering — and
deep-links the merchant into Shopify admin to fix each by hand. **It is an action
backlog with the detection already written and the verb deliberately omitted**
(its header says drafting copy is "a separate action-type"). Worth reading as
candidate evidence; it is the closest thing in the repo to a merchant-validated list.

## 3. The coupling is looser than assumed — actions are NOT blocked on new beliefs

Worth stating plainly because it changes sequencing: **`dead-stock-clearance.server.js`
never reads the `dead_stock` belief.** It queries `variant`, `inventoryLevel` and
`orderLineItem` directly (lines 114/128/132) and computes its own target set.

So a belief plays two roles, and only one is load-bearing:

- **Trigger + narrative (needed):** the LLM sees the belief in memory, decides the
  situation warrants acting, and emits an `actionIntent`. `prompt.server.js:34` already
  advertises `listActionCapabilities()` generically — *add a registry entry and the LLM
  can emit it with no prompt change.*
- **Target resolution (not needed):** the primitive re-queries deterministically.

**Consequence:** this lane is not blocked behind the memory/ontology lane. A scalar
belief like `negative_inventory_variant_count` is enough to trigger; the primitive finds
the variants itself. That said, a *targetable* belief makes the merchant-facing "why"
much stronger, so Tier-1 candidates still rank higher.

## 4. Scope reality — the commercial problem

Granted set (`shopify.app.toml:64`, identical in staging):
`read_products, write_products, read_orders, write_orders, read_all_orders,
read_customers, write_customers, read_inventory, write_inventory, read_locations`

| Scope | Exercised by | Status |
|---|---|---|
| `write_products` | `price_markdown` (live) | ✅ honest |
| `write_inventory` | nothing | ⚠️ **unexercised** |
| `write_customers` | nothing | ⚠️ **unexercised** |
| `write_orders` | nothing | ⚠️ **unexercised** |

Verified against shopify.dev's access-scope reference:

- `read_inventory,write_inventory` → **InventoryLevel, InventoryItem**
- `read_customers,write_customers` → **Customer, Segment, Company, CompanyLocation**
  — *Segment is in here.* That matters; see candidate C.
- `read_orders,write_orders` → Order
- `read_discounts,write_discounts` → Discounts — **NOT granted**
- `read_draft_orders,write_draft_orders` → DraftOrder — **NOT granted**
- `read_inventory_transfers,write_inventory_transfers` → InventoryTransfer — **NOT granted**
- `read_marketing_events,write_marketing_events` → MarketingActivity — **NOT granted**

### Published copy is a live constraint on this lane (chat 6, 2026-08-12)

Chat 6's scope-disclosure pass is **already live** and discloses permissions without
claiming capabilities, so it imposes **no ceiling on what can be built** — with one
exception, and one soft commitment:

- ⛔ **"He never emails your customers" is a live public trust promise** (/early-access
  + front-door). Any action that emails a customer breaks it and must be reconciled with
  Matt *before* it ships. **No candidate in §5 does** — and `customer_segment_maintain`
  is specifically shaped so it can't: Jefe defines rules, Shopify evaluates them.
  *Verified the promise is true today:* the win-back sender resolves its recipient from
  the Shopify `Session` `associated_user` — the **merchant** who uninstalled — and no
  path in `app/lib/email/` reads `CustomerIdentity`.
- **Soft forward-commitment:** the privacy copy now publicly frames the three
  unexercised write scopes as *"features we're rolling out and aren't exercised until
  that feature is live."* That is honest today, and it is a clock. Each shipped action
  lets chat 6 move its scope from *"rolling out"* → *"we do X"*; each one that never
  ships leaves a public promise ageing.

The loop: register an action + name the scope it closes → chat 6 drafts the disclosure
update → Matt approves the publish (one-way door). **This table is the tracking
artifact** — `write_inventory`, `write_customers` and `write_orders` each want one
shipped action to flip to honest.

⚠️ **`write_orders` is the hard one.** Every genuinely valuable order write —
`refundCreate`, `orderCancel`, `orderMarkAsPaid`, order editing — is **irreversible**,
a different risk class under the reversibility rule.

Checked specifically for a reversible order write worth building, because dropping a
scope is hard to undo. There are exactly two, and neither rescues it:

- **`orderUpdate` tags/note** — reversible, trivially safe, thin value on its own.
- **`orderClose` / `orderOpen`** — a genuinely reversible pair, the structural twin of
  `product_status_change`. But Shopify **already auto-closes** orders once every line
  item is fulfilled or cancelled and all transactions complete, so the only orders left
  to close are ones that are *not* actually finished — and auto-closing those hides work
  the merchant still owes. Reversible, and still the wrong thing to automate.

So `write_orders` cannot be made honest by a *reversible* action. Making it honest means
accepting an irreversible primitive; the alternative is dropping the scope. Founder call
(§8, decision 3).

## 5. Candidate actions, ranked

Ranked on merchant value × evidence × scope justification. ⚠️ **Ranked without merchant
discourse.** Chat 6 confirmed (2026-08-12) they don't hold it — **Matt is the source**
(he's in the support group) and hasn't passed it on. Chat 6 will forward it verbatim
when it lands, merchant phrasing raw rather than summarised, and flag whatever maps to
`write_orders`/`write_customers`/`write_inventory`. **This ranking is revisited then**;
candidate B is the position most likely to move.

| # | Action | Scope | Trigger | Reversible | Missing links |
|---|---|---|---|---|---|
| **A** | `product_status_change` — archive stock that clearance didn't move | `write_products` *(already exercised)* | `dead_stock` ✅ targetable | ✅ ACTIVE↔ARCHIVED | registry entry · resolver · wire layer · outcome. **Adapter + client + tests already built** |
| **B** | `inventory_correction` — reset negative stock to 0 | **`write_inventory`** ← closes a scope | `negative_inventory_*` (scalar; primitive re-queries) | ✅ CAS restore | belief targeting · adapter · client · registry · resolver · wire · outcome |
| **C** | `customer_segment_maintain` — create/maintain native Shopify Segments (lapsed high-value, at-risk, first-time) | **`write_customers`** ← closes a scope | **none — no per-customer cohort belief exists** | ✅ `segmentUpdate`/delete | **a belief first** · adapter · client · registry · resolver · wire · outcome |
| **D** | `compare_at_price_set` — strike-through pricing alongside a markdown | `write_products` | rides on `dead_stock` | ✅ | small; makes the live action actually convert |
| **E** | `product_content_fill` — set missing product type | `write_products` | hygiene scan ✅ | ✅ | productType safe; **description is LLM-generated merchant-visible copy = different risk class** |
| **F** | `product_tag_change` — tag clearance/bestseller/low-cover for the merchant's other tools | `write_products` | many | ✅ | low value alone, high composability |
| **G** | `order_tag_change` | **`write_orders`** | none | ✅ | only reversible order write; thin value |
| **H** | `discount_code_create` | **`write_discounts` — NOT GRANTED** | — | ✅ | **new scope = one-way door + live review risk** |
| **I** | `refund_create` / `order_cancel` | `write_orders` | — | ❌ **NO** | irreversible — different risk class, founder call |

**Why B over C despite C's bigger scope payoff:** `inventorySetQuantities` natively
provides `compareQuantity`/`changeFromQuantity` (compare-and-swap) and an `@idempotent`
key — required as of API 2026-04. Those map **1:1** onto the adapter contract the
clearance primitive already implements (compare-and-set, idempotent per-target ledger
writes). It is the most faithful possible second write primitive. `Segment` is the
higher prize but needs a belief that does not exist, in a lane that is booked.

**Not candidates:** any action that emails a customer — chat 6 has published *"He never
emails your customers"* as a live trust promise (§4); reorder/purchase-order (Shopify has no PO write under the granted
scopes — `low_cover_products` is the best-prepared belief in the repo and its natural
verb isn't a Shopify write at all, so it belongs in the brief, not the action layer);
`customer_marketing_consent` (consent must come from the customer, never from us);
`inventory_item_cost_set` (Jefe doesn't know the cost — that's merchant data).

## 6. ⚠️ The spine is single-action in ten places — read before registering anything

A registry entry is not sufficient to add an action, and the gaps are not evenly
harmless. In `action-resolution.server.js` unless noted:

1. `:261` — `RESOLVERS` returns a price-shaped tuple; `proposeActionFromIntent`
   destructures `markdownPercent`.
2. `:272` — `computeClearanceAutoEligibility` called unconditionally, though
   `computeProductStatusAutoEligibility` already sits beside it.
3. `:308` — `caps: DEFAULT_CLEARANCE_CAPS` persisted unconditionally.
4. `:300` — `actionKind` from a hardcoded `dead_stock` ternary.
5. `:218` — `toSuggestedAction` hardcodes `actionType: "price_markdown"`.
6. `:371` — `getActiveSuggestedAction` renders a **hardcoded dead-stock headline**
   regardless of `row.actionType`. A second action type would render on the home as a
   clearance.
7. `:383` — `executable: isClearanceExecuteEnabled()`. **A second action type would be
   gated on the wrong flag — one that is `true` in production.**
8. `:754` — `reviseAction` passes `writeEnabled: isClearanceExecuteEnabled()`.
9. `:563` — `getScopeGatedOpportunity` hardcoded to `price_markdown`.
10. `clearance-outcome.server.js:111` — measurement filters
    `actionType: "price_markdown"` and assumes `preview.changes[].variantId/toPrice`.

### The one that matters most

**`wireClearanceExecution` does not dispatch on `row.actionType` at all.** It loads the
row, checks `preview.changes` is non-empty (a product-status preview also has
`.changes`), gates on `isClearanceExecuteEnabled()`, builds a *clearance* client, and
calls `applyClearance` with whatever preview the row holds.

Traced what would actually happen if a foreign preview reached it:

- `enforceBlastRadiusCap` reads `preview.variantCount`; `undefined > 25` is `false`, so
  **the blast-radius cap silently passes** on any preview lacking that field.
- `computeClearanceAutoEligibility` gives `reversible: false`, so the mode degrades to
  `approve` — autonomous execution is blocked.
- Execution then throws at the ledger write (`targetRef: undefined` on a non-nullable
  column), **before** any Shopify call.

So no wrong store write occurs — but it is stopped by a Prisma NOT NULL constraint and a
falsy comparison, not by design. **The only thing actually preventing a second action
type from entering this path is that `RESOLVERS` has no entry for it**, so
`proposeActionFromIntent` returns `unsupported` and no row is ever created. The safety
property lives in the resolver map, not the registry — which means *registering* an
action type and *resolving* it must never be separated by more than one commit.

**Recommendation:** the spine generalisation (actionType dispatch in the wire layer +
a cap check that fails closed on a missing field) lands **before or with** the first
new registration, not after. Routed to chat 10 as contract owner.

### Newly load-bearing: the engine computes *why* it couldn't act, then discards it

Matt ruled today (relayed via the roster lane) that **eligibility is a RUNTIME decision,
not a settings-time one**: a merchant on `autonomous` gets Jefe doing what it safely can
and **raising what it can't, with actionable steps, in the chat** — not a greyed dial or
an eligibility grid in Settings.

That makes an existing throwaway load-bearing. The propose path computes three distinct
"why not autonomous" signals and keeps only the first:

| Signal | Produced by | Fate |
|---|---|---|
| `["not_reversible", "over_blast_radius_cap", "below_confidence_threshold"]` | `computeClearanceAutoEligibility().reasons` | ✅ persisted in `eligibility` Json |
| `"autonomous_not_eligible_degraded"` | `resolveAutonomyMode().reason` | ❌ **discarded** |
| `["over_auto_max_trapped_capital", …]` + `"exceeds_autonomy_policy"` | `applyAutonomyPolicy().policyViolations` | ❌ **discarded** |

`proposeActionFromIntent` returns `autonomy` to `maybeEmitPlanAction`, which logs only
`status` and `runId`. Two of the three signals evaporate at the moment they are computed.

Under the old settings-time model this was harmless plumbing — the dial carried the
story. Under the runtime model **this is exactly the payload the raise needs**, and
two-thirds of it is thrown away. Cheap to fix (persist `autonomy.reason` +
`policyViolations` alongside the already-persisted `eligibility`), and it should land
with the spine generalisation rather than after, since §6.2 means `eligibility` is
currently computed by the *clearance* function whatever the action type.

⚠️ **Contract mismatch to ratify (chat 10):** the roster will offer **two** modes
(`approve` / `autonomous`) per live type. The engine stores **three** — `ACTION_MODES =
["recommend", "approve_execute", "autonomous"]`, with `resolveAutonomyMode` branching on
`recommend` and `DEFAULT_ACTION_MODE = "approve_execute"`. If nothing ever writes
`recommend`, that branch goes dead and the 3-mode model documented across the schema
comment, the adapter and `context/11_actions_and_autonomy.md` is stale. Either
`recommend` is deliberately retired, or it stays reachable somewhere. Not this lane's
call — flagged.

## 7. Recommended first two

**1 · `product_status_change` — the freebie, and the forcing function.**
Adapter, Shopify client and both test files already exist and are unregistered — chat 10
already flagged it "doubly inert". Zero new scope, zero new consent, reuses the generic
ledger with no migration. Its real value isn't the feature; it is that being the second
primitive forces every hardcode in §6 into the open and converts the spine from
one-action to N-action for the cost of one small action. Nothing else buys that as
cheaply. Pairs naturally with the live clearance: *mark it down; if it still hasn't
moved in N days, archive it.*

**2 · `inventory_correction` — the first honest write scope.**
Closes `write_inventory`. Negative stock is unambiguously a defect (it blocks sales and
is almost always a sync error, not a decision), the fix is one number, the merchant sees
the benefit immediately, and Shopify's own mutation hands us compare-and-swap plus an
idempotency key — the adapter contract, natively. Needs a targeting query for the
variants (the belief is scalar), which §3 establishes is a normal primitive
responsibility, not a memory-lane dependency.

**Third, not second: `customer_segment_maintain`.** Highest scope payoff and it makes
Jefe's segmentation usable in the merchant's existing email tool without Jefe ever
contacting a customer or holding a plaintext address — which fits, because
`CustomerIdentity` only stores `emailHash`/`maskedEmail`, so Jefe *cannot* build a
recipient list even if it wanted to. It defines rules; Shopify evaluates them. Blocked
on a per-customer cohort belief that does not exist.

## 8. Founder decisions needed (one-way doors)

1. **Register `product_status_change`?** Becomes a contract the roster, ledger,
   measurement and autonomy dial all key on. No new scope. *Recommended: yes.*
2. **Build `inventory_correction` against `write_inventory`?** No *new* scope — it
   exercises one already requested — but it is the first time Jefe writes something
   other than a price. *Recommended: yes.*
3. **`write_orders`: keep it or drop it?** ⭐ **The live one — two lanes now converge.**
   No reversible order write carries real value (§4, checked exhaustively). Keeping it
   means either accepting an irreversible primitive later, or leaving the scope
   unexercised while the listing is in review *and* while the privacy copy publicly
   calls it a feature being rolled out.
   **Chat 6 recommends dropping it** unless there is a must-have order-write feature
   Matt intends to build with an irreversible primitive — it is the top unexercised
   review-risk scope and the one their copy is most exposed on.
   **This lane concurs, in that conditional form.** Nothing in §5 needs it: candidates G
   (`order_tag_change`) and I (`refund_create`/`order_cancel`) are the only two, and both
   fall away — G on value, I on reversibility. Dropping `write_orders` costs the
   candidate list nothing. The decision is therefore *"does Matt want an irreversible
   order primitive on the roadmap?"* — if no, the scope has no purpose.
4. **`write_discounts`?** Discount codes are plausibly the single most-requested
   merchant action, and the scope is not currently requested. Adding it is a consent +
   review change. *Deferred pending chat 6's merchant discourse.*

Flags stay off. Nothing goes live without a separate explicit call.

## 9. Coordination

- **chat 10 (architecture II)** — owns `ACTION_REGISTRY`'s shape and the per-primitive
  `measure`/`verdict` contract. Asked: the outcome-contract shape; whether they own the
  resolver-interface extraction ("from two real ones" — this is the second one); whether
  a belief is the only legitimate trigger. Also flagged §6's wire-layer finding.
- **chat 6 (growth)** — replied 2026-08-12. Doesn't hold the discourse (Matt does);
  will forward verbatim. Disclosure is live and imposes no capability ceiling, but
  carries one hard promise and one soft commitment — both recorded in §4. Standing loop:
  each registration names the scope it closes, chat 6 drafts the copy, Matt approves the
  publish.
- **Settings/autonomy roster** — replied 2026-08-12 relaying Matt's runtime-eligibility
  ruling, which retires their earlier reversibility/eligibility-flag ask and moots the
  caps question. Their consumer contract is now firm: `listActionTypes()` +
  design copy keyed by `actionType`, two modes per live type, no eligibility matrix, a
  new live type = a new row automatically. Consequences for this lane recorded in §6.
  **Generalising `getScopeGatedOpportunity` is needed regardless of their open nav
  question** — under the runtime model a missing scope is something Jefe raises in chat,
  not a greyed settings row, so it is this lane's work either way.
- **Memory/ontology lane** — deliberately not contacted; belief questions routed to
  chat 10 per the brief. §3 means this lane is not blocked on them.
- **Not touched:** `app/routes/app._index.tsx`, `app/components/daily-home.tsx`.
