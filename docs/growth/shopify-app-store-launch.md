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

1. **Protected Customer Data = Level 2.** Scopes include `read_customers` (customer name/email/address/phone) → strictest tier + a **data-protection review**. The *request* is submitted; the *substance* must be true and implemented: encryption at rest + in transit, data minimization, retention limits, staff access controls + logs, incident-response policy, test/prod separation. Reviewers verify, and there's an **annual re-review** (heavier the more installs / customer records you hold). Owner: product/security.
2. **Scope hygiene — trim the *unused* writes, keep the used one.** Autonomy is live from day 1, so Jefe **does** write to Shopify — but only clearance is wired at launch, which uses `write_products`. **Decision (chat 7): keep `read_*` + `write_products`; trim the four unused writes (`write_orders`, `write_customers`, `write_inventory`, `write_locations`).** "Request only necessary scopes" is a review criterion and every customer-data scope widens the Level 2 review, so requesting writes nothing exercises yet invites a flag; the registry re-adds each write per-action as it ships (`scopes_update`, which re-prompts merchants). chat 7 owns the `shopify.app.toml` edit + `shopify app deploy` (folded into the pre-submit write-client deploy); chat 6 then syncs this listing + `apps/growth/legal-triggers.json` to the final set. Owner: chat 7 (arch) + Matt.
3. **Pricing / Billing.** No Billing API integration exists, and charges **must** run through Shopify's Billing API. Design partners are free anyway → **launch with a free plan (early-access/beta)** so Billing API isn't a submission blocker. Get installs + reviews first; build Billing API before monetizing (that's the 10→100 gate). Owner: Matt.

**⬜ Run last:** the automated checks + Shopify's **AI Toolkit self-review** (`shopify` CLI command the dashboard offers) — run against the app to pre-empt rejections. Owner: whoever holds the Shopify CLI + Partner auth (product/Matt).

---

## Listing content — first draft (chat 6)

> ⚠️ **Superseded for COPY (2026-07-30):** the intro / details / feature copy here was the 2026-07-29 *advisory-era* draft. For the copy you paste into the form, use the **"Listing copy — autonomy from day 1, three modes"** section above — it's authoritative (autonomy from day 1, execution live at launch, three modes). The **app-name** options below still stand; the Level-2 / billing / testing / category notes are reconciled inline.

**App name** (≤30 chars, must start with brand, no "Shopify" trademark):
- **`Jefe: AI eCommerce Manager`** (26) — or `Jefe — Your AI Store Manager` (28)

**App introduction / App details / Feature list:** → use the authoritative copy in the **autonomy-from-day-1, three-modes** section above. The advisory-era drafts previously here are superseded — Jefe executes on the merchant's behalf from day 1 (three modes: recommend · approve-execute · autonomous), not "advisory today."

**Pricing:** Free while in early access (Design Partner program).

**Visual assets (spec — to produce):**
- **Icon** 1200×1200 PNG/JPEG — bold Jefe brand, no text, no Shopify marks.
- **3–6 screenshots** 1600×900 (16:9): (1) Connect, (2) "What Jefe knows about your business" memory view, (3) an Insight, (4) a Goal, (5) a Plan/recommendation with its evidence. Crop browser chrome, no PII.
- **Feature video** (optional, 2–3 min, ≤25% screencast): the "my name is Jefe" hook → the *"yes, that's exactly how my business works"* moment.
- **Demo store + test instructions** for reviewers — use `tools/synthetic-shopify` seed data (no real customer data).

---

## Locked listing decisions (2026-07-29)

**Primary category:** Store management › Operations › **Workflow automation** (execution is close → tag for the destination; Analytics is the fallback if actioning slips; category is changeable post-launch).

**Automation tasks — tags:**
- **Selected:** Inventory levels, Stock replenishment, Return processing, Order processing, Order tags, Product tags, Customer segments, Customer tags.
- **Left off:** Time-based, Sales thresholds *(rule-builder — off-brand)*; Payment status, Order fulfillment *(no scope provisioned)*; Fraud detection, Email responses *(different product categories)*.

**Customization — tags:**
- **Selected:** Auto-sync data, Multi-store. *(Optional/founder's call: Scheduled tasks, APIs.)*
- **Left off:** Conditional logic, Custom triggers, Custom workflows, Templates *(rule-builder — Jefe is judgment, not merchant-configured rules)*.

**Tagging principle (for future edits):** tag for the *destination* (what Jefe will do), but exclude (a) other product categories Jefe won't be (fraud, customer-service email), (b) "build-your-own-rules" tags (the anti-thesis of Jefe), (c) domains with **no provisioned write scope**. The `write_products / orders / customers / inventory` scopes are the evidence of what's genuinely on the action roadmap.

**Languages: English only at launch.** The app — UI *and* AI-generated output — is English-only; the checkbox attests the **app** is fully available, not just the listing. Localization is a **100→1000 item — German → French first** (biggest non-English Shopify markets).

> ⚠️ **When localization ships, the App Store submission info must be redone:** a fully translated listing per language, re-attest the "languages the app is fully available in," and expect **re-review**. Adding a language = redo the listing + resubmit, not a checkbox.

---

## Listing copy — autonomy from day 1, three modes (2026-07-30; direction confirmed, exact wording pending Matt's line)

> **Direction (Matt-confirmed, relayed by chat 7, 2026-07-30):** **three modes, all v1** — *recommend* · *recommend→approve→execute* · *autonomous* — and **autonomy from day 1**: Jefe **executes on the merchant's behalf, live at launch** (Matt explicitly rejected flagged-off / propose-first). Supersedes both the "advisory-today" copy and the interim "recommends-now" cut. chat 7 is shipping the live Shopify write client and **enabling execution before submit**, so "Jefe executes" is **true at review time**.
>
> **⚠️ Honesty gate (the one hard condition):** the "executes / autonomous" copy is accurate **only if execution is actually LIVE when the listing is submitted / reviewed.** chat 7 owns landing + confirming the write client first, and will ping before Matt submits. If it's somehow not live at submit, fall back to the recommends-now wording (in git history). Same principle as the "transient" line: fix by shipping the capability, not softening the words.
>
> **Exact final wording is still Matt's to confirm** (chat 7 relays it). Copy below is *direction-accurate* — safe to work from, but expect the last-mile phrasing to be swapped for Matt's confirmed line.

**Direction-accurate canonical line (Matt via chat 7):** *Jefe acts on your behalf — you approve each action, or let it run autonomously, per action type.*

**Listing copy (autonomy-from-day-1, three modes):**
- **App card subtitle (≤62):** `Learns your store, finds the next move, acts on it — your call`
- **Introduction:** `Jefe learns how your Shopify store actually works from your own data, then acts on your behalf. You choose the mode per action type: Jefe just recommends it, recommends and executes on your approval, or runs it autonomously and reports back. You set the rules, and can veto or reverse anything.`
- **App details (≤500):** `Meet Jefe — an AI manager for your Shopify store. Jefe reads your orders, products, customers, and inventory to learn how your business works, finds the next move, and acts on it. You choose the mode for each type of action: Jefe recommends it and you act, Jefe executes on your approval, or Jefe runs it autonomously and reports back. Every action goes through controlled, reversible steps — you set the rules, and can veto or undo anything. You're always in control.`
- **Features:** (1) `Learns how your store works from your own orders, products and customers` (2) `Finds the next move worth making — always with the evidence behind it` (3) `Three modes, your choice per action: recommend, execute-on-approval, or fully autonomous` (4) `Every action is controlled and reversible — set the rules, veto, or undo` (5) `A living Merchant Memory you can inspect and correct anytime`
- **Meta description (≤160):** `Jefe is an AI eCommerce manager for Shopify. It learns how your store works, finds the next move, and acts on it — you approve, or let it run autonomously.`

**Scope (per chat 7 — trimmed to 7):** requested scopes are `read_products`, `write_products`, `read_orders`, `read_all_orders`, `read_customers`, `read_inventory`, `read_locations`. **Keep `write_products`** (clearance executes against it); the four unused writes (`write_orders`, `write_customers`, `write_inventory`, `write_locations`) were **trimmed** (landed on main: ecb5abe/cd616eb) — unused write scopes draw a reviewer flag, and the registry re-adds each per-action as it ships (`scopes_update`, which re-prompts merchants). Reviewer note: the demo should exercise a requested scope (clearance covers `write_products`).
**Category:** **Store management › Operations › Workflow automation** — correct, *because* execution is live/demonstrable at launch (not recommendations-only). Reviewer-demo: show clearance (approve→execute or autonomous) working on the test store / screencast.

---

## Listing submission — field-by-field answers (2026-07-29)

Paste-ready. **✅ = final · ⚠️ = founder must provide/host.**

### Resources
- **Privacy policy URL** *(required)* — ⚠️ host at `https://mynamejefe.com/privacy` (page doesn't exist yet; content to draft — also required for the Level-2 data-protection review).
- **Developer website** — ✅ `https://mynamejefe.com`
- FAQ / Changelog / Tutorial / Additional docs — optional; leave blank for launch.

### Pricing (≥1 public plan required)
- **Plan name** — ✅ `Free`
- **Top features** — ✅ `Full access while Jefe is in early access: connect your store, build your Merchant Memory, get recommendations with the evidence, and let Jefe act on them — your call.`
- **"I have approval to charge outside the Shopify Billing API"** — ⚠️ **leave UNCHECKED** (free / Billing-API only).
- Pricing URL — optional; blank.

### App discovery content
- **App card subtitle (≤62)** — ✅ `Learns your store, finds the next move, acts on it — your call`
- **Search terms (5, ≤20 each, no "Shopify"/competitors)** — ✅ `ecommerce manager` · `store insights` · `AI assistant` · `inventory alerts` · `reorder reminders`
- **Title tag (≤60)** — ✅ `Jefe — AI eCommerce Manager for Shopify Stores`
- **Meta description (≤160)** — ✅ `Jefe is an AI eCommerce manager for Shopify. It learns how your store works, finds the next move, and acts on it — you approve, or let it run autonomously.`

### Install requirements
- **Sales channels** — ✅ **"My app doesn't require the Shopify Online Store or Shopify POS"** (admin-embedded; no theme extension/POS).
- **Geographic** — leave unset (English-only is a language limit, not geographic).

### Tracking (optional)
- Add a **Google Analytics Measurement ID** for the listing if available — feeds the growth funnel (listing views → installs). Else skip.

### Contact
- Merchant review email + App submission email — ✅ `matt@mynamejefe.com` (or a shared inbox). Allowlist `noreply@shopify.com`.

### App testing
- **Test account** — ✅ **"My app doesn't require an account"** (auth is Shopify OAuth). ⚠️ Reviewers need a **dev store seeded with `tools/synthetic-shopify`** so Jefe isn't empty.
- **Screencast URL** — ⚠️ record 3–8 min (storyboard in the Design brief below).
- **Testing instructions** — ✅:
  ```
  1. Install Jefe on a development store that has orders, products, and customers (or use the seeded demo store linked above).
  2. Jefe authenticates via Shopify OAuth on install and opens inside the admin.
  3. Jefe reads your orders, products, customers, and inventory in the background to build its Merchant Memory (allow a few minutes for the first build).
  4. Open "What Jefe knows about your business" to see the structured understanding; entries can be inspected and corrected.
  5. Review the Insights generated from that memory.
  6. Review and refine the Goals.
  7. Review and accept one Plan — each recommendation shows the evidence behind it.
  8. Optional: connect a channel (Slack) to receive Jefe's updates.
  Note: Jefe executes real actions in this version — for each action type the merchant picks the mode (recommend · approve-execute · autonomous) and every change is reversible. The reviewer should see an action execute (e.g. dead-stock clearance). [Contingent on execution being live at submit — chat 7's gate; if it slips, this reverts to recommend-and-approve.]
  ```

### Still to clear before submit
1. **Privacy policy** hosted at a URL (content to draft — chat 6 can produce).
2. **Screencast** recorded + a **data-seeded test store**.
3. **Icon + screenshots** produced (Design brief below).
4. Founder calls: Level-2 data-protection substance, scope trim, confirm the free plan.

---

## Design brief (for Claude design)

All assets sit on the **real Jefe brand** (pulled from `apps/marketing`). Match the marketing site.

### Brand tokens
- **Logo mark:** rounded square (~14/64 corner radius) in **navy `#33456b`**, a stylised cream **"J"** (`#f8ece7`), with a **dusty-rose dot** (`#c98a8a`) at the base. Source: `apps/marketing/public/favicon.svg`.
- **Palette:** navy/indigo `#33456b` (primary) · cream `#f8ece7` · dusty rose `#c98a8a` · warm gold (~`#dcb87a`) · warm off-white background (`oklch(0.985 0.005 70)`). Dark panels = deep navy (`oklch(0.31 0.06 262)`).
- **Type:** **Bricolage Grotesque** (display/wordmark) · **Schibsted Grotesk** (body) · **Instrument Serif** (italic serif accent for cheeky emphasis words).
- **Feel:** warm, premium, a little cheeky ("my name is Jefe"). Confident, human, evidence-led.

### 1. App icon — `1200×1200` PNG
- The Jefe mark scaled crisply: navy rounded square, cream "J", rose dot.
- Bold, simple, **no text, no Shopify trademarks**, no photographic detail; legible at 64px. Deliver flat PNG + keep the SVG source.

### 2. Screenshots — `3–6 × 1600×900` (16:9)
Captured from the live app on a warm off-white/navy frame, one-line caption each, **no PII** (use `tools/synthetic-shopify` data), crop browser chrome. Sequence:
1. **Connect** — the install/connect screen.
2. **"What Jefe knows about your business"** — the Merchant Memory view (**hero shot**).
3. **Insights** — generated insights.
4. **Goals** — a generated/refined goal.
5. **Plan** — a recommendation **with its evidence** (the differentiator — keep the evidence visible).
Captions in Bricolage Grotesque, brand navy on cream; optional gold underline on the emphasis word.

### 3. Feature media — `2–3 min` video (or `1600×900` static) + screencast storyboard
For the *feature video*, screencast ≤25%; for the *testing screencast* field, a straight 3–8 min screen recording is fine. Beats:
1. Cold open — the "my name is Jefe" brand hook (~5s).
2. Connect Shopify (~10s).
3. Memory builds → "what Jefe knows about your business" — the aha (~30s).
4. An insight → a goal → a plan **with the evidence** (~45s).
5. Merchant approves an action and Jefe **executes** it (e.g. clearance) — show the three modes (recommend · approve-execute · autonomous) and that every action is reversible (~20s).
6. Close on the wordmark + "Join the early access." (~5s).
Warm, unhurried, no loud audio; brand navy/cream throughout.

### 4. Privacy policy page (content + hosted page)
- **Content:** chat 6 to draft — what data Jefe reads (orders/products/customers/inventory), why, retention, security, merchant + customer rights; aligned to the Level-2 protected-customer-data commitments.
- **Page:** host on the marketing site at `/privacy`, styled to match (Schibsted Grotesk body, brand palette). This is an `apps/marketing` add — coordinate before building.

---

## What to learn — ASO & Built for Shopify

There's **no keyword hack**. Shopify ranks on: **install volume + retention**, **reviews & rating**, **listing quality**, and **performance** (Lighthouse — don't drop a storefront's score >10 pts; jefe is admin-embedded so low storefront risk, but confirm). So ASO is mostly **earned post-launch**, not a pre-launch trick:
- **Reviews are the engine.** Ask each activated design partner to review **at the aha moment** (ties to [case-study-template.md](case-study-template.md)). First reviews disproportionately drive early ranking.
- **Retention** — nail activation (memory confirmed + 1 rec accepted) so uninstalls stay low.
- **Complete, high-quality listing** (above) + a demo video.
- **Category: Store management → Operations → Workflow automation** (confirmed 2026-07-30). Correct because execution is **live/demonstrable at submit** — Jefe *operates* the store, executing actions per action type (recommend · approve-execute · autonomous). (Analytics — *"insights or recommendations"* — is only the fallback if execution slips and isn't live at submit; **category is changeable post-launch**.) **Set expectations honestly in the copy:** the listing must convey the three modes and merchant control — *"you approve each action, or let Jefe run it autonomously, per action type"* — so merchants aren't surprised in either direction (full-autopilot *or* advisory-only); accurate expectations protect early retention → ranking.
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
- **2026-07-29** — Doc completed as the full submission reference: every field's paste-ready answer (resources/pricing/discovery/install/contact/testing) + a Claude-design brief (icon, screenshots, screencast storyboard, privacy page) on the real Jefe brand tokens (navy `#33456b`, cream, rose, gold; Bricolage/Schibsted/Instrument Serif).
- **2026-07-29 (pm)** — Locked category (Workflow automation) + final tag sets + English-only launch (localization = 100→1000, DE→FR; needs listing resubmission then). Rewrote intro/details/features to Shopify's factual-listing rules — stripped marketing-voice flourishes (that voice lives on the site) and the auto-flagged words ("best", "pricing"). Field-by-field submission answers provided to founder (discovery/pricing/testing).
- **2026-07-29** — Created (chat 6). Audited app vs. requirements; app is technically ready-ish, listing is the blocker. Drafted full listing copy; flagged Level 2 data-protection, scope trim, free-plan pricing.
