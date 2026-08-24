# Shopify Full Scope Audit

**Date:** 2026-08-24 — **applied** the same day, following explicit founder confirmation in conversation.
**Status:** §1's classification and §3's ranked recommendation were produced as an audit and held unapplied through two prior task documents that each *claimed* founder pre-approval inside a pasted document (declined both times — a document can't authorize itself). The founder then confirmed directly, in conversation, and the scope change below was applied on that basis. See `CLAUDE.md` → "OAuth scope authorization record" for the standing record of that confirmation.

Source for the canonical scope list: Shopify's public Admin API access-scopes documentation, fetched **twice** this session — a second, more careful fetch immediately before writing any scope name into `shopify.app.toml` (this file's §1 was based on the first fetch, which turned out to have at least one likely-merged/inaccurate entry; the second fetch is what was actually applied). Treat the special-approval/protected-data/plan-restriction annotations below as accurate as of this fetch, not a substitute for confirming current requirements directly in the Partner Dashboard before relying on a gated scope.

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

**A. Declared — BEFORE** (`apps/shopify/shopify.app.toml`, as of the audit): `read_products, write_products, read_orders, write_orders, read_all_orders, read_customers, write_customers, read_inventory, write_inventory, write_inventory_transfers, read_locations` — 11 scopes.

**A. Declared — AFTER** (applied 2026-08-24, `apps/shopify/shopify.app.toml` + `shopify.app.staging.toml` + `.env`/`.env.example` `SCOPES`, kept in sync and covered by `tests/deployment-health.test.mjs`'s "tracked Shopify scope declarations stay in sync" regression test): **72 scopes** — every scope classified `APPLICABLE_TO_JEFE` in §1 that isn't gated by a Shopify-side approval process (§3.4 below), a not-yet-available API version, or a restriction to an incompatible app type. Full current list: see `apps/shopify/shopify.app.toml`'s `[access_scopes]` block directly — the canonical source, not reproduced here to avoid drift.

Added, by domain: fulfillment (`read/write_assigned_fulfillment_orders`, `read/write_merchant_managed_fulfillment_orders`, `read_third_party_fulfillment_orders`, `read_marketplace_fulfillment_orders`, `read/write_fulfillments`, `read/write_shipping`), discounts/pricing (`read/write_discounts`, `read/write_price_rules`, `read/write_payment_terms`, `read/write_gift_cards`), orders (`read/write_draft_orders`, `read/write_order_edits`, `read/write_returns`), customers (`read_customer_events`, `write_pixels`, `read/write_customer_merge`), content/storefront (`read/write_content`, `read_online_store_pages`, `read/write_online_store_navigation`, `read/write_translations`), inventory (`read_inventory_transfers`, `read/write_inventory_shipments`, `read/write_inventory_shipments_received_items`), international (`read/write_markets`, `read/write_marketing_events`), structured data (`read/write_metaobjects`, `read/write_metaobject_definitions`), platform (`read/write_files`, `read/write_locales`, `write_locations`, `read/write_reports`), and compliance/store-credit (`read/write_privacy_settings`, `read_legal_policies`, `read_store_credit_accounts`, `read/write_store_credit_account_transactions`).

**C. Granted, per-merchant — unchanged by this action.** Declaring a broader scope set in `shopify.app.toml` does **not** grant it to any existing installed merchant. The real dev merchant (`jefe-local-store.myshopify.com`, `Session` table, queried live) still holds the pre-expansion 12-scope grant (`read_all_orders, read_customers, read_inventory, read_inventory_transfers, read_locations, read_orders, read_products, write_customers, write_inventory, write_inventory_transfers, write_orders, write_products`) until it re-authorizes through the `app/scopes_update` webhook flow — see §4. **Production execution continues to check each merchant's actual live granted scopes before any write, unconditionally** (`gateway.server.js`'s `resolveGatewayAuthorizationScopes`, unchanged by this task, already re-verifies live against Shopify on every call rather than trusting a local snapshot).

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

## 3. Scope expansion — applied 2026-08-24

The companion `shopify-capability-and-scope-expansion.md` report's original tiered "minimal" recommendation and this audit's "broadest legitimate" classification converged, as §3 originally predicted — most of Shopify's ~95 scopes are checkout-extensibility, payments-app, or Plus-only surfaces genuinely outside an AI merchant-operator's role, so classifying honestly by role rather than by current implementation status produced a large but still *bounded* applicable set: **61 new scopes added, 72 total declared.**

### 3.1 — Applied now (`APPLICABLE_TO_JEFE`, no Shopify-side approval gate)

All scopes listed in §1's "APPLICABLE_TO_JEFE" categories except the exclusions in §3.2/§3.3 below. See §2 for the domain-grouped added list, and `apps/shopify/shopify.app.toml` for the exact canonical declaration.

### 3.2 — Desired but pending Shopify approval (NOT added to `shopify.app.toml`)

These are legitimately applicable to Jefe's role but Shopify gates them behind a separate approval process; declaring them in config without that approval would either be rejected or would misrepresent what's actually available. Tracked here so they aren't forgotten, not silently dropped:

| Scope(s) | Why desired | What approval, and where |
|---|---|---|
| `read_own_subscription_contracts`, `write_own_subscription_contracts` | Subscription churn/retention is squarely merchant-operator territory | Shopify docs mark "Permissions required via Partner Dashboard" |
| `read_customer_payment_methods` | Marginal value only; recommended `NOT_APPLICABLE` in §1 unless a concrete use case emerges | "Permissions required; request via Partner Dashboard" — not being pursued |
| `read_shopify_payments_disputes`, `read_shopify_payments_payouts` | Dispute/payout visibility is real merchant-operator information | No explicit note on this fetch, but Shopify Payments data has historically required a support-mediated grant — verify directly before requesting |
| `read_shopify_payments_dispute_evidences`, `write_shopify_payments_dispute_evidences`, `read_shopify_payments_dispute_file_uploads`, `write_shopify_payments_dispute_file_uploads` | The write path is already permanently prohibited at the execution layer (`disputeEvidenceUpdate` — `mutation-safety.server.js`) regardless of scope, so there's no execution payoff yet | Shopify docs: "Permissions required; contact Shopify Support" |
| `read_analytics_annotations`, `write_analytics_annotations` | Complements Merchant Memory's own deterministic beliefs | **Not a Shopify approval gate — an API version gate.** Shopify's docs mark this "Available as of API version 2026-10"; this app runs `2026-07` (`SHOPIFY_API_VERSION`). Revisit when the app upgrades API version. |

### 3.3 — Deliberately excluded (not applicable, incompatible app type, or effectively deprecated)

- **`SPECIAL_APP_TYPE_ONLY`**: `read_payment_gateways`/`write_payment_gateways`/`write_payment_sessions` (Shopify Payments Apps only), `read_users` (Shopify Plus only), `write_third_party_fulfillment_orders` (Shopify's docs: "Restricted as of API version 2024-10 for order management apps" — Jefe isn't registered as one).
- **`NOT_APPLICABLE`**: checkout/cart/payment-customization scopes (`cart_transforms`, `checkout_branding_settings`, `checkout_and_accounts_configurations`, `payment_customizations`, `payment_mandate`, `delivery_customizations`, `validations`) — all Shopify Functions/checkout-extensibility developer surfaces, not merchant-operator recommendations; `write_app_proxy` (storefront-extension developer feature); `read_themes`/`write_themes` (theme-file mutation is already permanently prohibited; theme-metadata-only access has no clear use case yet).
- **Effectively legacy**: `read_script_tags`/`write_script_tags` — the ScriptTag API is a legacy injection mechanism Shopify has been steering apps away from in favor of Web Pixels/Theme App Extensions; treated as deprecated-in-spirit and excluded rather than requested.
- **Unclear, needs a real founder judgment call, not an agent's**: `read_merchant_approval_signals` — the audit couldn't confidently determine what this actually exposes or whether it fits Jefe's role; excluded pending that review rather than guessed into either bucket.
- **Unverifiable this session**: a `read_products`/`write_products` note says "Requires related purchase option or subscription contract scopes" but the live fetch didn't surface an exact current `read_purchase_options`/`write_purchase_options`-style identifier to add with confidence — rather than guess a scope name that could fail `shopify app deploy` or silently do nothing, this is flagged for direct Partner Dashboard verification instead of being added blind.

---

## 4. Reauthorization / deployment steps

1. **Done**: `access_scopes.scopes` updated in `apps/shopify/shopify.app.toml` and `shopify.app.staging.toml`; `SCOPES` updated in `.env`/`.env.example` (the actual runtime OAuth-request source, separate from the CLI-facing toml declaration — both must match, and `tests/deployment-health.test.mjs`'s "tracked Shopify scope declarations stay in sync" test now guards this).
2. **Not yet done, next step for whoever deploys this**: `npm run config:link` / `shopify app deploy` to push the new declared scope set to the Partner Dashboard app configuration. This wasn't run as part of this change — it talks to Shopify's real Partner Dashboard for this app, which is a step beyond editing local config files, and should be a deliberate deploy action, not a side effect of an agent session.
3. Existing installed merchants do **not** automatically receive new scopes merely because they're now declared — Shopify triggers a re-consent flow (the `app/scopes_update` webhook, already subscribed per `shopify.app.toml`) only after the merchant re-authorizes. New installs get the full declared 72-scope set immediately once step 2 runs.
4. For the §3.2 scopes requiring Shopify approval — that approval must be granted in the Partner Dashboard *before* the scope is meaningfully usable, independent of any `shopify.app.toml` declaration (which is exactly why they weren't declared).
5. Re-run `npm run shopify:api:generate -- --shop=<dev store> --token-env=...` once the dev store has actually re-authorized under the new scope set, to refresh the live granted-scope probe and re-verify `scopeConfidence`/`execution.status` assignments for the newly-relevant domains in `docs/shopify-full-capability-surface.md`. Not run yet — no merchant, including the dev store, has re-consented to the broadened set at time of writing.
