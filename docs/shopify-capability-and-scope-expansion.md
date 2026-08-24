# Shopify Capability & Scope Surface — Investigation and Expansion Proposal

**Date:** 2026-08-24
**Method:** Real Shopify Admin GraphQL introspection against the connected dev store (`jefe-local-store.myshopify.com`), real granted-scope lookup for that merchant's stored offline session, and real `MerchantPlanRun` diagnostics pulled from the local database for that same merchant's actual "no actionable opportunity" runs from earlier today. This is a live-data investigation, not a hypothetical one — see §7 for the literal trace.

**What this session changed in the repo, concretely:**
- Fixed a real bug in `apps/shopify/scripts/shopify-api-generate.mjs`: `INTROSPECTION_QUERY`/`TYPE_REF` were declared *after* their own use at module top-level (a `ReferenceError` — the `--shop`/`--token-env` live-introspection path had never actually worked). Moved the declarations above their use site. Pure reorder, no behavior change to the `--introspection=<file>` path.
- Ran the now-working live introspection once against the dev store and saved the result as a new, clearly-separated artifact: `docs/ops/shopify-real-schema-2026-08-24/shopify-admin-api-2026-07.REAL-INTROSPECTION.json` (+ diff report alongside it).
- **Did not** touch the live-wired catalog at `app/lib/shopify/api/catalogs/shopify-admin-api-2026-07.generated.json` — it is unchanged from the checked-in seed. §1 explains why swapping it in as-is would be a safety regression, not a fix.
- **Did not** request, grant, or change any OAuth scope, anywhere. Per the brief, that decision is flagged for founder approval in §5.

---

## 1. Execution safety contract

### What's actually true today (reconciling the apparent contradiction)

The repo's permanent instruction ("every external write goes through a typed primitive with preview, idempotency, blast-radius caps, reversibility, audit") is **still true** — the generic gateway (`app/lib/shopify/api/gateway.server.js`, `executeShopifyOperation()`) is not a bypass of that contract, it's a *generalized implementation* of it. Read in order, on every call:

1. Operation exists in the generated catalog, and the running API version matches (`gateway.server.js:61,76`).
2. Variables validate against the stub's generated argument/input metadata (`:84`).
3. **Live** granted scopes include the operation's required scopes — fetched from Shopify itself on every call (30s cache), never trusted from a local session snapshot (`resolveGatewayAuthorizationScopes`, `:211-230`, deliberately commented: *"local list can be stale... never the source that can deny a call"*).
4. The Action carrying this intent is `accepted`, and its accepted revision matches the current one (`verifyActionAuthorization`, `:267` — `DENIED_ACTION_NOT_ACCEPTED` / `DENIED_ACCEPTED_REVISION_STALE`).
5. `evaluateAcceptedIntent()` (`:427`): blast-radius cap (`DEFAULT_MAX_AFFECTED_RESOURCES = 50`), a destructive-term-outside-intent check (`delete/refund/cancel/void`), a pricing-outside-intent check, an inventory-outside-intent check.
6. Idempotency-key replay/dedup (`:141,330`) — `IDEMPOTENT_REPLAY` short-circuits a duplicate; `NEEDS_RECONCILIATION` forces inspection before retry on an unknown prior result.
7. Every admitted or denied call is recorded in `shopify_operation_calls`, an operation-level ledger.

**So: idempotency, blast-radius capping, and accepted-intent verification are genuinely operation-independent** — they're computed structurally from the request shape (how many resource ids, what the accepted Action's free-text intent says) and apply uniformly to any of the 810 real operations without per-operation code. This is real, and it's good — it's exactly the kind of structural-not-trusted gate the rest of the codebase uses elsewhere (the citation allowlist, the numeric-grounding gate).

**What is *not* operation-independent, and is the actual gap:**

- **Reversibility.** The gateway has no concept of it at all — nothing in `gateway.server.js` asks "can this be undone." Reversibility currently only exists as a property of the 4 legacy typed adapters (each hand-computes its own eligibility, e.g. `computeClearanceAutoEligibility`), and as a hand-set field on the 14-operation curated `shopify-capabilities-2026-07.json` manifest. **A newly-discovered mutation has no reversibility classification at all** unless someone adds one by hand. This directly answers the brief's question "how does the runtime know whether an arbitrary mutation is reversible?" — **it doesn't, today, for anything outside the curated 14/16-operation lists.**
- **Blast-radius *model*.** The gateway's cap (`≤50 resources`) is a single global number applied to every operation alike. It correctly stops a 500-product bulk write, but it cannot express "a single `refundCreate` for £3,000 is high-blast-radius even though it touches one resource" — value-based or domain-specific blast radius still requires semantic, per-operation modeling (as the legacy clearance adapter does: `maxDiscountPercent: 60` alongside `maxVariants: 50`).
- **Destructive/benign/high-risk classification.** The gateway's destructive check is a keyword match on the *accepted intent's free text* (does it mention "delete/refund/cancel/void") — it does not classify the *operation itself*. `customerDelete`, `discountAutomaticBulkDelete`, `companyDelete` are exactly as "just another mutation" to the gateway as `productUpdate` is, unless the accepted intent's own wording happens to contain a destructive term the keyword list catches. **This is the single biggest concrete risk of naively wiring in the 810-operation real catalog**: nothing currently stops Luna from investigating and a merchant from accepting an Action whose `feasibleWriteOperations` includes something like `customerCancelDataErasure` or `metaobjectBulkDelete`, if the free-text intent doesn't happen to trip the keyword filter.
- **Required OAuth scope.** Covered in depth in §2 — Shopify's GraphQL schema introspection **does not expose per-operation required scopes at all** (verified: only 14 of 810 operation descriptions even mention the word "scope," and none in a structured, parseable way). The 16-operation seed catalog's `requiredScopes` were hand-populated by whoever curated it. **The freshly-generated 810-operation catalog has `requiredScopes: []` on every single operation** — not because those operations need no scope, but because the generator has no source for that data. If this file were swapped into the live path as-is, `buildOpportunitySurface`'s scope check (`(op.requiredScopes ?? []).length === 0 || ...`) would treat *every* domain as scope-`available`, regardless of what's actually granted — a real safety regression, which is exactly why this session left the live catalog untouched (see the file-handling note at the top of this doc).

### The execution-capability contract (explicit, binding on future catalog expansion)

**A newly-introspected mutation becomes an eligible recommendation candidate only when all of the following are true, curated by a human, not inferred from introspection:**

1. **Scope is known and correct**, sourced from Shopify's public API reference (not guessed, not left empty) — required, because introspection cannot supply it (§2).
2. **Reversibility is explicitly classified** — `reversible | irreversible | irreversible-with-confirmation`. Default-deny: an operation with no reversibility classification is not executable, full stop, regardless of scope.
3. **A blast-radius model is assigned** — either "generic count cap applies" (safe default for simple field updates) or a domain-specific model (value-based, like clearance's discount-percent cap) for anything touching money, customer data, or deletion.
4. **A risk tier is assigned**: `benign` (safe-to-approve-first), `sensitive` (requires explicit confirmation even under `autonomous`), or `never-dynamic` (excluded from the dynamic runtime entirely, regardless of scope or evidence — see the operation-family list below).
5. Only once 1–4 are satisfied does an operation enter the same eligibility surface `productVariantsBulkUpdate`/`productUpdate` occupy today.

**Operation families that should never be dynamically executable merely because Shopify exposes them** (recommend hard-excluding these from any future auto-classification pass, regardless of how "safe-looking" their name is):
- Anything under `*Delete`/`*BulkDelete` on merchant-identity or financial objects (`customerDelete`, `companyDelete`, `metaobjectBulkDelete`, `discountAutomaticBulkDelete`).
- `customerCancelDataErasure` / anything touching Shopify's GDPR erasure flow — this is a compliance-sensitive, merchant-initiated-only action.
- `appUninstall`, `appRevokeAccessScopes`, `bulkOperationRunMutation` (arbitrary bulk mutation execution — a mutation that runs other mutations is structurally incompatible with a per-operation safety contract).
- Payment/financial primitives beyond what's already modeled (`customerPaymentMethod*`, `subscriptionBilling*`) — these touch real money movement beyond a simple price/discount change and need dedicated review, not blanket catalog inclusion.
- `themeFilesUpsert` / any theme-code mutation — already correctly flagged `NO-PATH` in `context/13_action_capability_registry.md`; Shopify requires a special exemption for a normal public app to use this at all.

This is a *policy*, not code shipped this session — implementing the curation/gating mechanism is the first item in §8's build sequence, and no scope or catalog change should be treated as "safe now" until it exists.

---

## 2. Seeded vs. real schema comparison

| | Seed (checked-in, live) | Real (introspected this session) |
|---|---|---|
| Operations | 16 | **810** |
| Queries | 3 | 287 |
| Mutations | 13 | **523** |
| Domains (by the current `inferDomain()` classifier) | 7 | **8** (7 named + a 467-operation `general` catch-all) |
| `generatedFrom` | `"seeded_introspection"` (never real) | `"admin_graphql_introspection"`, real, this session, `2026-08-24` |
| `requiredScopes` populated? | Yes, hand-curated, for all 16 | **No — empty array on all 810** (introspection cannot supply this; see §1) |

Real domain breakdown (`inferDomain()` — a crude keyword classifier, only recognizes `collections`/`inventory`/`discounts`/`orders`/`customers`/`metafields`/`products`; everything else falls into `general`):

| Domain | Total ops | Mutations |
|---|---|---|
| `general` (unclassified) | 467 | 283 |
| `orders` | 82 | 61 |
| `inventory` | 65 | 48 |
| `discounts` | 59 | 40 |
| `products` | 57 | 38 |
| `customers` | 45 | 32 |
| `collections` | 23 | 13 |
| `metafields` | 12 | 8 |

**This confirms and sharpens the prior investigation's finding**: the real Shopify Admin API surface is enormous and genuinely covers fulfillment, draft orders, order edits, refunds/returns, discounts (automatic + code), metaobjects, storefront content (pages/blogs/articles/menus), Markets, publishing/channels, subscriptions, gift cards, and B2B companies — none of which the 16-operation seed models. But it also surfaces a **second problem the seed catalog never had to face**: `inferDomain()`'s 7 hardcoded buckets are themselves too coarse for the real surface — 58% of all real operations (467/810) fall into an undifferentiated `general` bucket that would show up in `buildOpportunitySurface` as one family mixing fulfillment, storefront, markets, subscriptions, gift cards, and B2B together. A merchant-relevant domain taxonomy needs to be built deliberately (§3), not inherited from the current keyword classifier.

Representative operation counts pulled directly from the real catalog for domains the brief specifically asked about (not yet bucketed by `inferDomain`, hence not in the table above — sampled by name prefix):

| Domain (manual sample) | Mutations found |
|---|---|
| Fulfillment (`fulfillment*`) | 31 |
| Draft orders (`draftOrder*`) | 12 |
| Order edits (`orderEdit*`) | 12 |
| Refunds/returns (`refund*`, `return*`, `reverseFulfillmentOrder*`) | 12 |
| Discounts (`discount*`) | 30 |
| Metaobjects (`metaobject*`) | 8 |
| Storefront/content (`onlineStore*`, `page*`, `blog*`, `article*`, `urlRedirect*`, `menu*`, `comment*`) | 25 |
| Markets (`market*`) | 21 |
| Publishing/channels (`channel*`, `publication*`, `productPublish/Unpublish`) | 9 |
| Customers/segments (`customer*`, `segment*`) | 33 |
| Subscriptions | 33 |
| Gift cards | 8 |
| B2B/companies | 31 |

Full artifacts (not committed to the live path — see the note at the top of this doc):
- `docs/ops/shopify-real-schema-2026-08-24/shopify-admin-api-2026-07.REAL-INTROSPECTION.json` — the full 810-operation catalog, real schema.
- `docs/ops/shopify-real-schema-2026-08-24/shopify-admin-api-2026-07-generation-diff-report.md` — the generator's own added/removed/changed report vs. the seed.
- `/tmp/shopify-admin-api-2026-07.SEED.json` — the original seed, preserved (session-local; also unchanged and still live at its canonical repo path).

---

## 3. Merchant-relevant action matrix

Not every one of 810 operations is worth modeling — this is a curated pass over the highest-merchant-value operations per domain, using the real catalog's own descriptions plus general Shopify API knowledge for scope (introspection cannot supply scope — see §1/§2; scopes below are from Shopify's public documentation, not machine-verified this session, and must be confirmed before any is relied on for a scope-expansion decision).

| Domain | Shopify mutation | Merchant value | R/W | Scope (documented, not introspected) | Jefe safety support | Recommendation value | Current status |
|---|---|---|---|---|---|---|---|
| Products | `productUpdate`, `productVariantsBulkUpdate` | high — status, content, pricing | W | `write_products` | full (typed adapters + gateway) | proven — live today | `SAFE_EXECUTABLE_NOW` |
| Inventory | `inventoryItemUpdate` (cost, SKU, tracked) | **high** — unlocks margin/COGS-aware recommendations for every future pricing decision | W | `write_inventory` (**already granted** to the dev merchant — see §4) | none yet | **high — directly unblocks a real candidate Luna already generated today** (§7) | `NEEDS_RUNTIME_SUPPORT` (catalog + safety metadata only — no scope needed) |
| Inventory | `inventoryAdjustQuantities` | medium — stock corrections | W | `write_inventory` (granted) | none yet | conditional — needs an authoritative quantity source Jefe doesn't have (§6) | `NEEDS_SAFETY_SEMANTICS` + `EVIDENCE_MISSING` |
| Collections | `collectionCreate`, `collectionAddProducts` | medium | W | `write_products` (granted) | in catalog, generic gateway | proven | `SAFE_EXECUTABLE_NOW` |
| Metafields | `metafieldsSet` | **high, if targeted correctly** — e.g. Shopify's native `shopify--discovery--product_recommendation` metafield implements real cross-sell without a theme change | W | `write_products` (granted) | generic gateway only — no semantic knowledge of *which* metafield namespace does what | high, blocked purely on missing semantic mapping | `NEEDS_RUNTIME_SUPPORT` |
| Discounts | `discountCodeBasicCreate`, `discountAutomaticBasicCreate` | high — direct revenue lever | W | `write_discounts` (**not declared, not granted — genuinely absent**) | none | high | `EXECUTABLE_IF_SCOPE_GRANTED` |
| Orders | `refundCreate` | medium — irreversible, high-risk by nature | W | `write_orders` (granted) | none — no reversibility/risk classification exists for it today | low priority for auto/approve; always-confirm candidate at best | `HIGH_RISK_APPROVAL_ONLY` |
| Fulfillment | `fulfillmentCreate`, `fulfillmentOrderHold`, `fulfillmentOrderCancel` | high for operationally-engaged merchants | W | `write_merchant_managed_fulfillment_orders` (not declared) | none | high, once scoped | `NEEDS_SCOPE_AND_ADAPTER` → `SCOPE_MISSING` today |
| Draft orders | `draftOrderCreate`, `draftOrderInvoiceSend` | medium-high — phone/manual sales, invoicing | W | `write_draft_orders` (not declared) | none | medium | `SCOPE_MISSING` |
| Order edits | `orderEditBegin`/`orderEditAddVariant`/`orderEditCommit` | medium — post-purchase upsell, correction | W | `write_order_edits` (not declared, distinct from `write_orders` — easy to mis-map) | none | medium, high complexity (multi-step session) | `SCOPE_MISSING` + `NEEDS_RUNTIME_SUPPORT` |
| Returns | `returnCreate`, `returnProcess`, `returnRefund` | medium — returns/refund automation | W | `write_returns` (not declared, distinct from `write_orders`) | none | medium | `SCOPE_MISSING` |
| Storefront/content | `pageCreate`, `blogCreate`/`articleCreate`, `menuUpdate` | low-medium — content/nav changes are high-blast-radius to a storefront and hard to ground in commerce evidence | W | `write_content` / `write_online_store_pages` / `write_online_store_navigation` (not declared) | none | low — thin evidence base too (see companion report, §5) | `NOT_SUITABLE_FOR_JEFE` (for now — revisit once evidence exists) |
| Markets | `marketCreate`, `marketCurrencySettingsUpdate` | low for most merchants, high for multi-region ones | W | Markets-specific scopes (not declared) | none | low — niche, high blast radius (currency/pricing-by-region) | `NOT_SUITABLE_FOR_JEFE` initially |
| Publishing/channels | `productPublish`/`productUnpublish`, `publicationUpdate` | medium — sales-channel visibility control | W | `write_publications` (not declared) | none | medium | `SCOPE_MISSING` |
| Customers | `customerUpdate` (tags, notes), `customerEmailMarketingConsentUpdate` | medium — segmentation/consent hygiene | W | `write_customers` (**already granted**) | none yet | medium, blocked purely on missing adapter/runtime work, not scope | `NEEDS_RUNTIME_SUPPORT` |
| Customers (destructive) | `customerDelete`, `customerMerge`, `customerCancelDataErasure` | — | W | `write_customers` (granted) | **must never become dynamically executable** (§1) | n/a | `NOT_SUITABLE_FOR_JEFE` — permanent exclusion, not a backlog item |
| Gift cards | `giftCardCreate`, `giftCardCredit` | low-medium, niche | W | `write_gift_cards` (not declared) | none | low | `SCOPE_MISSING` |
| B2B | `companyCreate`, `companyContactCreate` | low for most current merchants (B2B not a stated segment) | W | `write_companies` (not declared) | none | low — no evidence Jefe's current merchant base needs this | `NOT_SUITABLE_FOR_JEFE` for now |
| Native marketing send | `marketingActivityCreate` | — | W | `write_marketing_events` | n/a — API only *attributes*, does not send | n/a | `SHOPIFY_LIMITATION` (confirmed, documented already) |

**Ranked by merchant usefulness among what's realistically buildable next** (not privileging non-product operations artificially, per the brief — ranked purely on value × effort):

1. `inventoryItemUpdate` (cost capture) — zero new scope, unblocks a real waiting recommendation today.
2. `discountCodeBasicCreate`/`discountAutomaticBasicCreate` — highest revenue-lever value, needs one new scope.
3. `metafieldsSet` targeted at known Shopify-native metafield namespaces (cross-sell, SEO) — zero new scope, needs semantic runtime work.
4. `customerUpdate` (tags/consent only, not merge/delete) — zero new scope, needs adapter + a much stronger customer evidence base (companion report §5) to be worth building before it's useful.
5. `fulfillmentCreate`/`fulfillmentOrderHold` — high value for operationally-engaged merchants, needs new scope.
6. Draft orders / order edits / returns — real value, but each needs a new scope *and* meaningfully more runtime complexity (multi-step sessions), so lower in the sequence despite decent value.

---

## 4. Declared / granted / required scope matrix

**A. Declared** — `apps/shopify/shopify.app.toml:75`:
```
read_products, write_products, read_orders, write_orders, read_all_orders,
read_customers, write_customers, read_inventory, write_inventory,
write_inventory_transfers, read_locations
```
11 scopes.

**C. Granted** — the actual dev merchant's stored offline session (`Session` table, `jefe-local-store.myshopify.com`, queried directly this session, not assumed from docs or the toml):
```
read_all_orders, read_customers, read_inventory, read_inventory_transfers,
read_locations, read_orders, read_products, write_customers, write_inventory,
write_inventory_transfers, write_orders, write_products
```
12 scopes — matches the declared set plus `read_inventory_transfers` (an implied companion read scope Shopify grants alongside the write version). **This directly resolves the documentation discrepancy the companion investigation flagged**: for this real merchant, `write_customers`, `write_inventory`, `write_inventory_transfers`, and `write_orders` are **all already granted** — the "7-scope launch trim, only `write_products` held" description in `HANDOVER.md`/`context/13_action_capability_registry.md` is **stale** and should be corrected; `shopify.app.toml` (and this merchant's actual grant) reflects the current, broader reality.

**B/Required**, against C:

| Scope | Declared (toml) | Granted (dev merchant) | Needed by a high-value action identified in §3 |
|---|---|---|---|
| `read_products` | yes | yes | yes — everything |
| `write_products` | yes | yes | yes — products, collections, metafields |
| `read_orders`, `read_all_orders` | yes | yes | yes — order-derived evidence |
| `write_orders` | yes | yes | yes — `refundCreate` (high-risk, low priority) |
| `read_customers` | yes | yes | yes — customer evidence |
| `write_customers` | yes | yes | **yes — already unblocked, just needs runtime work, not scope** |
| `read_inventory` | yes | yes | yes |
| `write_inventory` | yes | yes | **yes — already unblocked, `inventoryItemUpdate` cost capture, no new consent needed** |
| `write_inventory_transfers` | yes | yes | yes — restock (legacy adapter exists, flagged off) |
| `read_locations` | yes | yes | yes |
| `write_discounts` | **no** | **no** | yes — highest-value missing scope |
| `write_merchant_managed_fulfillment_orders` | no | no | yes — fulfillment |
| `write_draft_orders` | no | no | yes — draft orders |
| `write_order_edits` | no | no | yes — order edits |
| `write_returns` | no | no | yes — returns |
| `write_publications` | no | no | medium — channel/publishing |
| `write_content` / `write_online_store_pages` / `write_online_store_navigation` | no | no | low priority for now (§3, §5) |

**The headline correction to carry forward**: the earlier "product-heavy because we only hold `write_products`" framing was **not accurate for this merchant**. Five write scopes are already granted, covering products, customers, inventory, inventory transfers, and orders. The dominant blocker is not scope — it's that the live catalog (16 operations) doesn't contain the operations those scopes would already unlock (`inventoryItemUpdate`, most of `customerUpdate`'s useful fields), and that no safety metadata exists for anything beyond the 4 already-adapted mutations. **Scope expansion (§5) matters mainly for `discounts` and `fulfillment`** — everything else on the near-term high-value list is a catalog + safety-metadata + runtime problem, not a permissions problem.

---

## 5. Minimal scope expansion proposal — **for founder approval, not applied**

Ranked per the brief's six criteria. No scope has been requested or changed.

```
Tier 1 — write_discounts
Unlocks: discountCodeBasicCreate, discountAutomaticBasicCreate/Bxgy/FreeShipping — genuine
  revenue-lever actions (targeted promos, automatic free shipping thresholds) with no
  existing near-equivalent in the current write_products-scoped surface.
Evidence available: business.discount_depth.trailing_90d and business.discount_code_mix.trailing_90d
  already exist as deterministic beliefs (order-derived proxies) — thin but present; a real
  discounts-domain belief set (§6 of the companion report) would strengthen this quickly.
Risk: discount codes are reversible (deactivate/delete), bounded blast radius (one code/rule at
  a time), and merchant-approval-gated by default — a good first non-product scope to request.
Sensitivity: low-to-medium — merchants are used to granting discount-management access to apps.

Tier 2 — write_merchant_managed_fulfillment_orders
Unlocks: fulfillmentOrderHold/Cancel/AcceptFulfillmentRequest — operationally valuable for
  merchants who fulfil in-house, addresses real friction (stuck/delayed orders).
Evidence available: order/fulfillment-lag evidence is NOT currently modeled in Merchant Memory
  (companion report §5 confirms zero fulfillment-domain beliefs) — would need new deterministic
  belief work before this scope's value is realizable, not just the scope itself.
Risk: fulfillment-order operations are largely reversible (hold/cancel/release) but touch
  customer-promised delivery — needs its own risk-tier review, not a blanket "safe."
Sensitivity: medium.

Tier 3 — write_returns
Unlocks: returnCreate/returnProcess/returnRefund — automating return workflows.
Evidence available: refunds.* beliefs exist (2 keys) but are thin; a returns-specific evidence
  base does not exist yet.
Risk: touches money movement (returnRefund) — treat as HIGH_RISK_APPROVAL_ONLY even once scoped.
Sensitivity: medium-high (money + customer-facing).

Do not request (for now)
write_content / write_online_store_pages / write_online_store_navigation
Reason: no supporting Merchant Memory evidence domain exists at all (companion report confirms
  zero storefront/content beliefs), and content/navigation changes are high-blast-radius to a
  merchant's public storefront with no natural per-resource cap the way a product or discount
  change has. Build the evidence and a narrower risk model first; this is a "someday," not a
  near-term ask.

Markets-related scopes
Reason: niche (multi-region merchants only), high blast radius (currency/duties/pricing-by-region
  changes), and Merchant Memory has no Markets-domain evidence — only a shippingCountry-derived
  proxy. Lowest priority of everything surfaced in this investigation.

write_draft_orders, write_order_edits, write_publications, write_gift_cards, write_companies
Reason: real value exists (§3) but each requires meaningfully more runtime complexity
  (multi-step sessions for order edits; invoicing flows for draft orders) than the Tier 1-3
  single-mutation cases — sequence these after the safety-contract and catalog work (§8) lands,
  not alongside this first scope ask.
```

**Recommendation: request only `write_discounts` in the first follow-up scope change**, once the execution-safety contract (§1) has a curation mechanism in place for it — everything else on this list should wait for either more supporting evidence (fulfillment, returns) or more runtime maturity (draft orders, order edits) before asking a merchant for another permission.

---

## 6. Capability gaps independent of scope

Using the taxonomy from the brief, applied to real candidates from §7's actual failed run (not hypothetical):

| Candidate (real, from today's run) | Classification | Why |
|---|---|---|
| `capture-variant-costs` / `capture-product-costs` | `CATALOG_MISSING` today (would become `RUNTIME_MISSING` once §8 step 1 lands) | `inventoryItemUpdate` exists in the real schema, and `write_inventory` is **already granted** — the only thing missing is that the live catalog doesn't contain the operation and no safety/adapter work has bound it. Zero scope work needed. |
| `repair-inventory-freshness` | `EVIDENCE_MISSING` + partial `API_LIMITATION` | Luna correctly concluded Shopify has no reconciliation/resync mutation, and even if `inventoryAdjustQuantities` were bound, Jefe has no authoritative source of "what the real count actually is" to compute deltas from. Adding the operation to the catalog would not fix this candidate — it needs a new evidence source (e.g. merchant-confirmed physical count), which is exactly the brief's warning that "adding a capability cannot solve missing Merchant Memory evidence." |
| `restore-customer-identity-capture` | `API_LIMITATION` (checkout/account capture is not a standard Admin API write) leaning `NOT_SUITABLE_FOR_JEFE` | No customer-account, checkout-capture, or consent mutation exists that implements "get more checkout guests to leave an identifiable email" — this is a checkout/theme-configuration concern, not an Admin API mutation Jefe should be reaching for. |
| `increase-cross-product-basket-penetration` | `RUNTIME_MISSING` | Shopify's native `shopify--discovery--product_recommendation` metafield (writable via `metafieldsSet`, already scope-available) could implement this — but the runtime has no semantic knowledge that this specific metafield namespace/key is what "cross-sell surfacing" means. This is a real, buildable win with zero new scope, but needs deliberate semantic mapping, not blind mutation discovery. |
| `reactivate-sales-cadence` | `API_LIMITATION` (Shopify has no recurring/scheduled-promotion primitive) | Correctly reasoned by Luna: the available discount/collection mutations are one-shot, not recurring; this is arguably better served by Jefe's own comms stack (Slack/email nudges) than a Shopify write at all. |
| `investigate-declining-product-demand` | Weak-diagnosis / `EVIDENCE_MISSING` | The candidate's own investigation found the historical-sales evidence didn't cleanly confirm a *current*-period $0-revenue claim — this is a diagnosis-quality issue upstream of capability, not a capability gap at all. |

**Pattern**: of six real candidates from one real exhausted run, exactly **one** is a pure, already-scope-available catalog/runtime gap (`capture-variant-costs` — the highest-leverage single fix available), **two** are genuine `API_LIMITATION`/evidence gaps no scope or catalog change fixes, **one** is a `RUNTIME_MISSING` semantic-mapping gap (also zero new scope), and **one** is an evidence-quality issue unrelated to capability at all. This is strong, direct confirmation of the brief's core caution: *adding a scope cannot solve a missing capability implementation, and adding a capability cannot solve missing evidence* — both kinds of gap are present, simultaneously, in the same real run, and need different fixes.

---

## 7. Actual failed recommendation trace

Pulled directly from `MerchantPlanRun` for the real local dev merchant (`merchantId: 1c435ded-0fa5-4216-959f-93488575bab7`, `shopId: c02236e8-1f98-4203-90d4-d17ac876d52d`), three consecutive real runs from earlier today:

```
Run acfd6339 (16:54, sourceMode=agentic) → completed
Run e3acfd35 (17:08, sourceMode=home)    → completed, RECOMMEND_ACTION
  → "Review and temporarily move Basalt Tide Arinto to draft"
  → diagnosedProblem: active product, positive inventory, no sales in trailing 90 days
  → mechanism: draft status removes it from the active selling surface without deleting it
  → feasibleWriteOperations: ["productUpdate"]
  → capability chain: candidate → catalog HAS productUpdate → write_products GRANTED →
    typed adapter/gateway available → RECOMMENDED

Run 1f51c60e (17:20, sourceMode=home)    → NO_ACTIONABLE_OPPORTUNITY
  candidates (5, first pass only — rescue not reached or produced 0):
  - capture-product-costs               → BLOCKED_BY_EVIDENCE (no safe write for cost; catalog gap)
  - restore-customer-identity-capture   → NON_EXECUTABLE (no matching mutation exists; API limitation)
  - re-engage-after-demand-gaps         → NON_EXECUTABLE
  - increase-cross-product-discovery    → NON_EXECUTABLE (runtime/semantic gap, not catalog)
  - refresh-inventory-data-before-stock-decisions → BLOCKED_BY_EVIDENCE (no reconciliation source)

Run e424abc8 (17:38, sourceMode=home)    → NO_ACTIONABLE_OPPORTUNITY
  candidates (6, + rescue pass with 0 novel candidates):
  - capture-variant-costs                       → NON_EXECUTABLE — catalog gap, write_inventory
                                                    already granted (§6)
  - repair-inventory-freshness                  → BLOCKED_BY_EVIDENCE — no recount source (§6)
  - restore-customer-identity-capture           → NON_EXECUTABLE — API limitation (§6)
  - increase-cross-product-basket-penetration   → NON_EXECUTABLE — runtime/semantic gap (§6)
  - reactivate-sales-cadence                    → NON_EXECUTABLE — API limitation; also correctly
                                                    respected an explicit merchant belief
                                                    prohibiting new collections
  - investigate-declining-product-demand        → NON_EXECUTABLE — weak diagnosis (§6)
  discoveryLog: [{rescue:false, candidateCount:6, ...57.7k input tokens},
                 {rescue:true, candidateCount:0, ...58.8k input tokens}]
  → "Investigated 6 candidate(s) across discovery and rescue passes; none verified against
     current Shopify state."
```

**Direct connection to the capability gaps found in §2–§6**: every single non-`productUpdate` candidate across both exhausted runs failed for a reason this investigation now has a name and a fix (or an honest "not fixable by Jefe") for — not because Luna reasoned poorly, not because Merchant Memory lacked relevant evidence for the diagnosis step, and not because of scope in most cases. The one recommendation that *did* survive (`e3acfd35`) used the one operation family (`productUpdate`) that has full catalog + scope + adapter support today. This is the exhaustion mechanism from the companion investigation, now demonstrated on a real merchant's real runs rather than argued from architecture alone.

---

## 8. Proposed implementation sequence

1. **Build the curation/safety-classification mechanism from §1's contract** — a place to record, per catalog operation: scope (sourced from Shopify's docs, not introspection), reversibility, blast-radius model, risk tier. This gates everything else; nothing from the real catalog becomes executable before this exists.
2. **Curate `inventoryItemUpdate` (cost field only) through that mechanism and bind it as an executable operation.** Zero new scope. Directly unblocks the `capture-variant-costs`/`capture-product-costs` candidate Luna has now independently proposed three times against the real dev merchant. Highest-confidence, lowest-risk, highest-immediate-payoff item in this entire report.
3. **Curate the `metafieldsSet` → known Shopify-native metafield namespaces mapping** (starting with the product-recommendation namespace for cross-sell). Zero new scope, unblocks `increase-cross-product-basket-penetration`-shaped candidates.
4. **Fix `inferDomain()`'s classification** (currently 58% of the real 810-operation catalog falls into an undifferentiated `general` bucket) into a merchant-relevant taxonomy matching §3's domains, so `buildOpportunitySurface` produces coherent, individually-dispositionable families instead of one giant mixed bucket.
5. **Bring the founder-approval scope request for `write_discounts`** (§5, Tier 1) — the only near-term scope ask this investigation recommends acting on soon.
6. **Correct the stale "7-scope launch trim" claim** in `HANDOVER.md`/`context/13_action_capability_registry.md` — this investigation found the real granted set is broader (§4); the docs should reflect what's actually true rather than what was true at an earlier point in the build.
7. Everything else in §3/§5 (fulfillment, draft orders, order edits, returns) — sequence after 1–4 land and prove out, each preceded by its own evidence-and-risk review, not bundled in.

**Explicitly out of scope for this task, per the brief**: no OAuth scope was requested or changed; no manual/instruction-only recommendation path was implemented (that remains a recommendation from the companion report, not started here); no newly-discovered mutation was made executable.

---

## Success criteria — status

- [x] Real Shopify introspection replaces guesswork — 810 real operations, live against the dev store, this session.
- [x] We know which Shopify domains Jefe could meaningfully act in (§3).
- [x] We know which operations satisfy Jefe's execution safety contract — none from the real catalog yet; the contract itself is now explicit (§1), and exactly one operation (`inventoryItemUpdate`) is identified as ready to curate first.
- [x] Arbitrary introspected mutations are NOT automatically treated as safe writes — the live catalog was deliberately left unchanged this session precisely to avoid this; §1 names the specific operation families that must never become dynamically executable.
- [x] Exact scopes currently declared — §4A, verified against `shopify.app.toml` directly.
- [x] Exact scopes actually granted to the dev merchant — §4C, queried directly from the live `Session` table, not assumed.
- [x] Exact scopes required by each high-value new action family — §4B/§3, with the caveat that scope-per-operation is sourced from Shopify's public docs, not introspection (§1/§2 explain why introspection cannot supply this).
- [x] A minimal, ranked scope-expansion proposal — §5.
- [x] No OAuth scope has been broadened — confirmed; nothing was requested, changed, or applied.
- [x] We can explain the current recommendation exhaustion using the actual merchant run — §7, three real runs, direct capability-gap attribution for every failed candidate.
- [ ] "The recommendation runtime can consume arbitrary legitimate capability domains rather than a seeded product-heavy subset" — **not yet true**; this report identifies exactly what's needed (§8) but implementing the curation mechanism and re-wiring the live catalog was correctly out of scope for an investigation task that also says "do not simply expose every mutation as executable."
