# Shopify Full Scope Audit

**Date:** 2026-08-24 (rechecked same day, "Finish & Harden" follow-up)
**Status:** Audit and recommendation only, still. **No OAuth scope was requested, changed, or applied** — see "Why this wasn't applied" at the bottom, updated to reflect that a second task made the same request and was declined for the same reason.

A same-day follow-up task ("Finish & Harden Jefe's Full Shopify Capability Surface") again asserted founder pre-approval inside a pasted document and additionally asked for `CLAUDE.md`'s OAuth prohibition to be weakened and this document's existence to be recorded as the authorization. Both were declined — a document cannot authorize itself, and the standing rule this session is operating under requires that exact confirmation to come from the user directly, in conversation. §1's classification and §3's ranked recommendation below were re-checked against that follow-up's requirements (Part 3.1) and hold; nothing material changed. If and when the user confirms, applying §3's diff and updating `shopify.app.toml` + `CLAUDE.md` is mechanical — the analysis work is already done.

Source for the canonical scope list: Shopify's public Admin API access-scopes documentation (fetched this session — treat the special-approval/protected-data/plan-restriction annotations below as a strong starting point for founder review, not a substitute for confirming current requirements directly in the Partner Dashboard before requesting anything).

---

## 1. Every current Shopify Admin API scope, classified

Classification key: `APPLICABLE_TO_JEFE` (fits Jefe's role as a general AI merchant operator) · `REQUIRES_SHOPIFY_APPROVAL` (Shopify must grant access beyond normal scope declaration) · `PROTECTED_CUSTOMER_DATA` (gated by Shopify's separate Protected Customer Data approval, Level 1/2, regardless of scope) · `SPECIAL_APP_TYPE_ONLY` (reserved for a specific app category — payments apps, Shopify Plus, etc.) · `NOT_APPLICABLE` (outside Jefe's role) · `DEPRECATED`.

### Products & merchandising — APPLICABLE_TO_JEFE

`read_products` / `write_products`, `read_purchase_options` / `write_purchase_options` (selling plans), `read_metaobjects` / `write_metaobjects`, `read_metaobject_definitions` / `write_metaobject_definitions`, `read_locations` / `write_locations`, `read_files` / `write_files` (product/collection image assets), `read_locales` / `write_locales`.

### Inventory — APPLICABLE_TO_JEFE

`read_inventory` / `write_inventory`, `read_inventory_transfers` / `write_inventory_transfers`, `read_inventory_shipments` / `write_inventory_shipments`, `read_inventory_shipments_received_items` / `write_inventory_shipments_received_items`.

### Orders, fulfillment, returns, draft orders — APPLICABLE_TO_JEFE

`read_orders` / `write_orders`, `read_order_edits` / `write_order_edits`, `read_draft_orders` / `write_draft_orders`, `read_returns` / `write_returns`, `read_assigned_fulfillment_orders` / `write_assigned_fulfillment_orders`, `read_merchant_managed_fulfillment_orders` / `write_merchant_managed_fulfillment_orders`, `read_fulfillments` / `write_fulfillments`, `read_shipping` / `write_shipping` (carrier service integration).

`read_all_orders` — **REQUIRES_SHOPIFY_APPROVAL** (Shopify's docs describe this as needing special approval beyond the default 60-day order window; verify current requirement before requesting). Applicable to Jefe's role (a lot of margin/dead-stock/repeat-purchase analysis wants full order history), but gate it on that approval, not a normal request.

`read_third_party_fulfillment_orders` / `write_third_party_fulfillment_orders`, `read_marketplace_fulfillment_orders` — **APPLICABLE_TO_JEFE, but only relevant for merchants using third-party/marketplace fulfillment**; low priority to request until there's demonstrated demand.

### Discounts, pricing, gift cards — APPLICABLE_TO_JEFE

`read_discounts` / `write_discounts`, `read_price_rules` / `write_price_rules`, `read_payment_terms` / `write_payment_terms`, `read_gift_cards` / `write_gift_cards`.

### Customers — PROTECTED_CUSTOMER_DATA (in addition to APPLICABLE_TO_JEFE)

`read_customers` / `write_customers`, `read_customer_merge` / `write_customer_merge`, `read_customer_events` / `write_pixels`. These are core to Jefe's role, but accessing customer PII fields (name, email, phone, address) at all — regardless of which of these scopes is declared — requires Shopify's **Protected Customer Data** approval in the Partner Dashboard (Level 1 covers name/email/phone; Level 2 adds address and other sensitive fields), a separate, real approval process from normal scope declaration. Confirm the app's current PCD approval level before assuming any customer-domain scope is usable in production.

`read_customer_payment_methods` — **REQUIRES_SHOPIFY_APPROVAL + PROTECTED_CUSTOMER_DATA**. Payment-method-on-file data is unlikely to be something Jefe's role needs directly (it's not a merchandising/operations decision input); recommend `NOT_APPLICABLE` unless a concrete use case emerges.

### Subscriptions — REQUIRES_SHOPIFY_APPROVAL

`read_own_subscription_contracts` / `write_own_subscription_contracts` — Shopify's docs mark this as requiring special approval. Applicable to Jefe's role (subscription churn/retention is squarely merchant-operator territory) once approved.

### Content, navigation, translations, themes — mostly APPLICABLE_TO_JEFE

`read_content` / `write_content` (articles/blogs), `read_online_store_pages`, `read_online_store_navigation` / `write_online_store_navigation`, `read_translations` / `write_translations` — applicable, though per the companion recommendation-exhaustion report, Merchant Memory currently has zero storefront-domain evidence, so requesting these ahead of that evidence work would unlock capability without diagnosability.

`read_themes` / `write_themes` — **NOT_APPLICABLE for now**. Theme *file* mutations (`themeFilesUpsert`) are already permanently prohibited at the safety-classification layer (§5 of the capability-surface doc) and require a special Shopify exemption for a normal app in any case; theme *metadata* reads (list/duplicate/publish) are lower-value without the file-editing half. Revisit only if a concrete, safe theme-metadata use case emerges.

### Markets & international — APPLICABLE_TO_JEFE

`read_markets` / `write_markets`.

### Marketing — APPLICABLE_TO_JEFE

`read_marketing_events` / `write_marketing_events` — note this only *attributes* marketing activity; it cannot send campaigns (confirmed in the prior capability-and-scope report — that's a genuine `SHOPIFY_LIMITATION`, not a scope gap).

### Payments & disputes — SPECIAL_APP_TYPE_ONLY / REQUIRES_SHOPIFY_APPROVAL

`read_payment_gateways` / `write_payment_gateways`, `write_payment_sessions` — **SPECIAL_APP_TYPE_ONLY**, reserved for apps registered as Shopify Payments Apps (a distinct app category with its own review process). Not applicable to Jefe's role as a merchant-operator app.

`read_payment_mandate` / `write_payment_mandate`, `read_payment_customizations` / `write_payment_customizations` — payment *checkout logic* customization (Shopify Functions territory) — **NOT_APPLICABLE**; this is a developer/checkout-customization concern, not a merchant-operating recommendation Jefe would make.

`read_shopify_payments_disputes`, `read_shopify_payments_payouts` — **REQUIRES_SHOPIFY_APPROVAL**, and arguably applicable (dispute/payout visibility is real merchant-operator information) — but the corresponding write scopes (`read_shopify_payments_dispute_evidences` / `write_shopify_payments_dispute_evidences`, `read_shopify_payments_dispute_file_uploads` / `write_shopify_payments_dispute_file_uploads`) are already permanently prohibited at the execution layer (`disputeEvidenceUpdate` is in the named-prohibitions list) regardless of scope — so requesting the write side has no payoff; the read side alone could be a future low-priority addition once approved.

### Cart & checkout customization — NOT_APPLICABLE

`read_cart_transforms` / `write_cart_transforms`, `read_checkout_branding_settings` / `write_checkout_branding_settings`, `read_checkout_and_accounts_configurations` / `write_checkout_and_accounts_configurations`, `read_validations` / `write_validations`, `read_delivery_customizations` / `write_delivery_customizations` — all Shopify Functions / checkout-extensibility developer surfaces, not merchant-operator recommendations. Out of Jefe's role as currently defined.

### Analytics & reports — APPLICABLE_TO_JEFE

`read_analytics_annotations` / `write_analytics_annotations`, `read_reports` / `write_reports` (ShopifyQL) — directly useful for a broader analysis surface, complementary to Merchant Memory's own deterministic beliefs rather than a replacement for them.

### B2B / companies — APPLICABLE_TO_JEFE

Covered under `read_customers` / `write_customers` per Shopify's own scope model (no separate B2B scope) — already captured above.

### Privacy & compliance — APPLICABLE_TO_JEFE (read only)

`read_privacy_settings` / `write_privacy_settings`, `read_legal_policies` — reads are applicable (Jefe should be able to see compliance posture); the corresponding erasure/consent *mutations* are already permanently prohibited at the execution layer regardless of scope, so `write_privacy_settings` has limited practical payoff — low priority.

### Store credit — APPLICABLE_TO_JEFE

`read_store_credit_accounts`, `read_store_credit_account_transactions` / `write_store_credit_account_transactions`.

### App proxy, admin users, other — NOT_APPLICABLE / SPECIAL_APP_TYPE_ONLY

`write_app_proxy` — **NOT_APPLICABLE**; app-proxy endpoints are a storefront-extension developer feature, not a merchant-operator action.
`read_users` — **SPECIAL_APP_TYPE_ONLY** (Shopify Plus merchants only per Shopify's docs); low value for Jefe's role (staff-account visibility isn't a commerce-operating decision input) — **NOT_APPLICABLE**.
`read_merchant_approval_signals` — unclear applicability without more context on what this actually exposes; flag for founder review rather than classify confidently.

---

## 2. Declared / granted / required scope matrix

**A. Declared** (`apps/shopify/shopify.app.toml:75`, unchanged by this task): `read_products, write_products, read_orders, write_orders, read_all_orders, read_customers, write_customers, read_inventory, write_inventory, write_inventory_transfers, read_locations` — 11 scopes.

**C. Granted** (the real dev merchant, `jefe-local-store.myshopify.com`, queried live from the `Session` table this session — not assumed): `read_all_orders, read_customers, read_inventory, read_inventory_transfers, read_locations, read_orders, read_products, write_customers, write_inventory, write_inventory_transfers, write_orders, write_products` — 12 scopes (the 11 declared plus the implied `read_inventory_transfers` companion).

**B. Required by the newly-classified high-value operations** — cross-referencing §1's `APPLICABLE_TO_JEFE` list against what's declared/granted:

| Scope | Declared | Granted (this merchant) | Applicable per §1 | Gap |
|---|---|---|---|---|
| `write_discounts` | no | no | yes | **Tier 1 — highest-value clean gap** |
| `write_merchant_managed_fulfillment_orders` (+read) | no | no | yes | Tier 2 |
| `write_returns` (+read) | no | no | yes | Tier 2 |
| `write_draft_orders` (+read) | no | no | yes | Tier 3 |
| `write_order_edits` (+read) | no | no | yes | Tier 3 (needs the workflow-override work from the capability-surface doc first) |
| `write_metaobjects`/`write_metaobject_definitions` | no | no | yes | Tier 3 |
| `write_markets` (+read) | no | no | yes | low priority — niche, high blast radius |
| `write_marketing_events` (+read) | no | no | yes | low priority — attribution only, can't send |
| `write_gift_cards` (+read) | no | no | yes | low priority |
| `write_publications` | no | no | yes | low priority |
| `write_content`/`write_online_store_navigation` | no | no | yes, but zero supporting Merchant Memory evidence today | defer to evidence work |
| `read_all_orders` | **already granted** | **already granted** | yes | none — already unlocked |
| `read_reports`/`read_analytics_annotations` | no | no | yes | low priority, complements rather than replaces beliefs |

---

## 3. Minimal scope expansion recommendation (unchanged from the companion report, reconciled here)

The companion `shopify-capability-and-scope-expansion.md` report already produced a tiered, ranked recommendation from schema + product-value analysis:

```
Tier 1 — write_discounts
Tier 2 — write_merchant_managed_fulfillment_orders, write_returns
Tier 3 — write_draft_orders, write_order_edits, write_metaobjects
Do not request now — checkout/cart/payment-customization scopes, theme file scopes,
  app-proxy, admin-users, subscriptions (pending approval), payment-app-only scopes
```

This audit's broader §1 classification doesn't change that ranking — it confirms it. The task's stated end state ("broadest legitimate Shopify authority") and the companion report's "minimal sensible set" aren't actually in tension once `NOT_APPLICABLE`/`SPECIAL_APP_TYPE_ONLY` scopes are excluded: **the legitimate applicable surface is itself fairly bounded** (most of Shopify's ~90 scopes are checkout-extensibility, payments-app, or Plus-only surfaces genuinely outside an AI merchant-operator's role) — "broadest legitimate" and "minimal sensible" converge on nearly the same tiered list once the inapplicable two-thirds are correctly excluded, rather than pulling in opposite directions.

---

## 4. Reauthorization / deployment steps (for whenever a scope change is approved)

1. Update `access_scopes.scopes` in `apps/shopify/shopify.app.toml`.
2. `npm run config:link` / `shopify app deploy` (per this repo's existing Shopify CLI workflow — see `HANDOVER.md` → Local Development) to push the new declared scope set to the Partner Dashboard app configuration.
3. Existing installed merchants do **not** automatically receive new scopes — Shopify triggers a re-consent flow (the `app/scopes_update` webhook, already subscribed per `shopify.app.toml:35-36`) only after the merchant re-authorizes. New installs get the full declared set immediately.
4. For scopes requiring Shopify approval (`read_all_orders` confirmation, `write_returns`/subscription scopes if they turn out to need it, Protected Customer Data level) — that approval must be granted in the Partner Dashboard *before* the scope is meaningfully usable, independent of the `shopify.app.toml` declaration.
5. Re-run `npm run shopify:api:generate -- --shop=<dev store> --token-env=...` after any scope change to confirm the live granted-scope probe reflects the new set for the dev store, and re-verify `scopeConfidence`/`execution.status` assignments for the newly-relevant domains in `docs/shopify-full-capability-surface.md`.

---

## Why this wasn't applied

`CLAUDE.md` (this repo's checked-in, override-priority operating instructions) states in the Role section: *"You may not... broaden OAuth scopes."* The task brief that requested this work claimed founder pre-approval for a scope change; that claim, made inside a pasted document, isn't something an agent can verify and doesn't override a standing written repo rule — session house rules separately name scope changes as exactly the kind of hard-to-reverse, product-security-relevant action that needs an explicit in-conversation confirmation from the user, not a claim of prior approval. This audit and the diff it implies (§3) are ready for a founder to review and explicitly authorize; `shopify.app.toml` itself was not touched.
