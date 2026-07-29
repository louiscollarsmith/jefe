# Shopify App Store — launch checklist + listing (jefe-specific)

> **Owner:** Jefe chat 6 (listing/ASO) + product/founder (compliance/scopes/billing) · **Last updated:** 2026-07-29 · Status: app in **Draft** (Partner Dashboard)

Grounded in the actual Partner Dashboard state + an audit of `apps/shopify`. Not a generic checklist.

## Where we actually are

**✅ Technical spine — done (audited in code + confirmed on the dashboard):**
- Embedded app (`embedded = true`), **current API version `2026-07`**, config issues fixed, emergency contact added.
- **Mandatory GDPR compliance webhooks implemented** — `customers/redact`, `customers/data_request`, `shop/redact` (`app/lib/ingestion/shopify/compliance.server.js`). *This is the #1 thing apps get rejected for — jefe has it.*
- `app/uninstalled` handled; **HMAC-verified** webhooks; **valid TLS** (Railway).
- Broad webhook coverage (orders, products, refunds, inventory, scopes_update).
- Protected-customer-data access **request submitted** (dashboard shows a Review link).
- → The **automated common-error checks** (auth-after-install, redirect-to-UI, compliance webhooks, HMAC, TLS) should pass. Run them **last** (they expire after 30 days).

**⬜ The real blocker — Listing content (English).** Not started. This is a copy/positioning job → **chat 6 owns it** (drafted below).

**⚠️ Three things to get right before submit — product/founder, not growth:**

1. **Protected Customer Data = Level 2.** Scopes include `read_customers`/`write_customers` (customer name/email/address/phone) → strictest tier + a **data-protection review**. The *request* is submitted; the *substance* must be true and implemented: encryption at rest + in transit, data minimization, retention limits, staff access controls + logs, incident-response policy, test/prod separation. Reviewers verify, and there's an **annual re-review** (heavier the more installs / customer records you hold). Owner: product/security.
2. **Scopes are too broad for V1.** Requesting `write_products, write_orders, write_customers, write_inventory, write_locations, read_all_orders` — but V1 is **advisory (no Shopify writes)**. "Request only necessary scopes" is a review criterion, and every customer-data scope widens the Level 2 review. **Rec: trim to the reads V1 actually uses; re-add write scopes when action/autonomy features ship** (scopes expand later via `scopes_update`). NB: HANDOVER intentionally pre-provisioned write scopes for the autonomy roadmap — so this is a founder call: cleaner review now vs. fewer scope prompts later. Owner: product + Matt.
3. **Pricing / Billing.** No Billing API integration exists, and charges **must** run through Shopify's Billing API. Design partners are free anyway → **launch with a free plan (early-access/beta)** so Billing API isn't a submission blocker. Get installs + reviews first; build Billing API before monetizing (that's the 10→100 gate). Owner: Matt.

**⬜ Run last:** the automated checks + Shopify's **AI Toolkit self-review** (`shopify` CLI command the dashboard offers) — run against the app to pre-empt rejections. Owner: whoever holds the Shopify CLI + Partner auth (product/Matt).

---

## Listing content — first draft (chat 6)

**App name** (≤30 chars, must start with brand, no "Shopify" trademark):
- **`Jefe: AI eCommerce Manager`** (26) — or `Jefe — Your AI Store Manager` (28)

**Introduction** (≤100 chars, merchant benefit):
> Jefe learns how your store really works, then tells you the smartest next move — with the receipts.

**Description** (≤500 chars):
> Meet Jefe — the AI manager for your Shopify store. Jefe reads your orders, products, customers and returns and builds a living memory of how your business actually works — one you can check and correct. Then it finds the next move worth making and shows the evidence behind it, so you decide with confidence. No dashboard to babysit, no generic chatbot — just a manager that gets your store. Advisory today; Jefe earns the right to act as you trust it.

**Feature list** (≤80 chars each, benefit-first):
- Learns how your store works from your own orders, products and customers
- Recommends your next best move — always with the evidence behind it
- A living Merchant Memory you can inspect and correct anytime
- Surfaces stockouts, pricing gaps and retention risks before you do
- Advisory now, earns autonomy as you trust it — you're always in control

**Pricing:** Free while in early access (Design Partner program).

**Visual assets (spec — to produce):**
- **Icon** 1200×1200 PNG/JPEG — bold Jefe brand, no text, no Shopify marks.
- **3–6 screenshots** 1600×900 (16:9): (1) Connect, (2) "What Jefe knows about your business" memory view, (3) an Insight, (4) a Goal, (5) a Plan/recommendation with its evidence. Crop browser chrome, no PII.
- **Feature video** (optional, 2–3 min, ≤25% screencast): the "my name is Jefe" hook → the *"yes, that's exactly how my business works"* moment.
- **Demo store + test instructions** for reviewers — use `tools/synthetic-shopify` seed data (no real customer data).

---

## What to learn — ASO & Built for Shopify

There's **no keyword hack**. Shopify ranks on: **install volume + retention**, **reviews & rating**, **listing quality**, and **performance** (Lighthouse — don't drop a storefront's score >10 pts; jefe is admin-embedded so low storefront risk, but confirm). So ASO is mostly **earned post-launch**, not a pre-launch trick:
- **Reviews are the engine.** Ask each activated design partner to review **at the aha moment** (ties to [case-study-template.md](case-study-template.md)). First reviews disproportionately drive early ranking.
- **Retention** — nail activation (memory confirmed + 1 rec accepted) so uninstalls stay low.
- **Complete, high-quality listing** (above) + a demo video.
- **Category (decided 2026-07-29): Store management → Operations → Workflow automation.** Founder call: execution/actioning is *close*, so we categorize for the destination — Jefe *operating* the store, executing approved actions per action type. (Analytics — *"insights or recommendations"* — is the accurate V1-today shelf and the fallback if actioning slips; **category is changeable post-launch**.) **Because V1 is still advisory at submit, the listing description must carry the honesty** — *"advisory today; you approve, Jefe executes as it earns your trust"* — so merchants don't install expecting full autopilot and churn (early retention drives ranking).
  - **Tag field → Automation tasks:** applicable — the operational domains Jefe acts in: inventory/reordering, pricing, product management, order management, marketing. Tick the closest the form offers.
  - **Tag field → Customization:** likely **N/A** (AI-driven, not a build-your-own-rules tool) — unless there's a merchant-set **goals / autonomy-level / preferences** tag, which genuinely fits.
  - Exact tag strings live only in the Partner Dashboard form, not public docs.
- **"Built for Shopify"** status is the prize — badge + search-ranking boost + "Picked for you" placement. Earned via app quality + installs + reviews + performance. Target it *after* the first cohort of reviews.

## Critical path

1. **chat 6:** finalize listing copy + asset spec (done — above) → hand assets to design/Matt to produce.
2. **product/Matt:** decide scope trim; confirm Level 2 data-protection substance; set free pricing plan.
3. **product/Matt:** run automated checks + AI Toolkit self-review.
4. Submit → review (days–weeks; may request changes).
5. Post-launch: reviews from design partners → ranking → Built for Shopify.

## Changelog
- **2026-07-29** — Created (chat 6). Audited app vs. requirements; app is technically ready-ish, listing is the blocker. Drafted full listing copy; flagged Level 2 data-protection, scope trim, free-plan pricing.
