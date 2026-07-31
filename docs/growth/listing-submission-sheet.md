# Jefe — Shopify App Store listing · as-submitted record

*Updated 2026-07-31 to reflect the actual values entered during submission. Companion to `shopify-app-store-launch.md` (the reasoning). This is the record of what's in the listing — use it for edits, re-submission, and localization later.*

## Submission status (2026-07-31)
- ✅ **Technical gate:** automated common-error checks passed; **execution live in prod** (`CLEARANCE_EXECUTE_ENABLED=true`); 7-scope trim deployed; GDPR compliance webhooks registered.
- ✅ **Privacy Policy live** — `https://mynamejefe.com/privacy` (reconciled to autonomy-from-day-1).
- ⏳ **Assets** — screenshots done (design) but **must match the shipping UI** (recapture if live screens differ); demo video uploaded.
- ⏳ **AI self-review** — chat 7 running `/shopify-app-store-review`; clear flags → tick "reviewed all requirements" → Submit.
- **No pre-submit write-verification blocker** (a reviewer's fresh store has no costed dead stock → no clearance to execute).
- **Post-submit / near-term:** Terms + DPA go live (read-through pending → chat 7 merge); first real-merchant write verified by chat 7 before the first live execution.

---

## App identity
- **App name:** `Jefe - Your AI Store Manager`
- **App introduction (≤100):** `Your AI store manager for Shopify. It learns your business, finds your next move, and acts on it.`
- **Category:** Store management › Operations › **Workflow automation**
- **Capabilities:** **Embedded** only
- **Languages:** English only

## Listing copy
- **Subtitle (≤62):** `Learns your store, finds the next move, acts on it — your call`
- **App details (≤500):** `Meet Jefe — an AI manager for your Shopify store. Jefe reads your orders, products, customers, and inventory to learn how your business works, finds the next move, and acts on it. You choose the mode for each type of action: Jefe recommends it and you act, Jefe executes on your approval, or Jefe runs it autonomously and reports back. Every action goes through controlled, reversible steps — you set the rules, and can veto or undo anything. You're always in control.`
- **Features (≤80 each):**
  1. `Learns how your store works from your own orders, products and customers`
  2. `Finds the next move worth making — always with the evidence behind it`
  3. `3 modes; recommend, execute-on-approval, or fully autonomous`
  4. `Every action is controlled and reversible — set the rules, veto, or undo`
  5. `A living Merchant Memory you can inspect and correct anytime`

## Discovery / SEO
- **Title tag (≤60):** `Jefe — AI eCommerce Manager for Shopify Stores` *(fine as-is; optional: align to "Store Manager" to match the app name)*
- **Meta description (≤160):** `Jefe is an AI eCommerce manager for Shopify. It learns how your store works, finds the next move, and acts on it — you approve, or let it run autonomously.`
- **Search terms (5):** `ecommerce manager` · `AI store manager` · `store insights` · `inventory alerts` · `reorder reminders` *(recommended set — confirm these are what you entered vs. the earlier AI/Intelligence/AI-Assistance draft)*

## Media
- **Featured media:** demo video + thumbnail (uploaded).
- **Screenshots (upload order):** `01-memory` → `02-evidence` → `03-mode-control` → `04-connect` → `05-goals`, plus mobile `01m-memory`, `02m-evidence`. ⚠️ **Designed frames — must match the shipping UI. Recapture on synthetic data into the same frames if the live screens differ.**
- **Alt text (<64):**
  - 01-memory → `Jefe's Merchant Memory — what it knows about your store`
  - 02-evidence → `A reorder recommendation, with the evidence behind it`
  - 03-mode-control → `Choose per action: recommend, approve, or autonomous`
  - 04-connect → `Jefe reading your store's data during setup`
  - 05-goals → `Goals Jefe works toward, and what it changed`
  - 01m-memory → `Jefe's Merchant Memory of your store (mobile)`
  - 02m-evidence → `A reorder recommendation with its evidence (mobile)`
- **Demo store URL:** *(blank — N/A for an admin-embedded app; the video carries the demo)*

## Pricing
- **Plan — internal handle:** `early-access` *(recommended; can't be changed later — confirm vs. `jefe-1` if you kept that)*
- **Billing:** Free · **"This plan has additional charges" — unchecked**
- **Public display name:** `Early Access`
- **Top features:** `Full access while Jefe is in early access: connect your store, build your Merchant Memory, get recommendations with the evidence, and let Jefe act on them — your call.`
- **"I have approval to charge outside the Shopify Billing API":** **UNCHECKED**, no URL. *(App-Store charges must run through Shopify Billing API — 0% under $1M/yr; see [pricing-strategy.md](pricing-strategy.md).)*
- **Pricing URL (optional):** blank.

## Integrations
- **Slack** only (real). Add Klaviyo + others as each actually ships.

## Support & resources
- **Preferred support channel:** Support email `hola@mynamejefe.com` *(no support portal — concierge until 100→1k)*
- **Privacy policy URL:** `https://mynamejefe.com/privacy` (live)
- **Developer website:** `https://mynamejefe.com`
- **FAQ / Changelog / Tutorial / Docs:** *(blank — post-launch adds)*

## App testing information
- **Test account:** ✅ "My app doesn't require an account to use it" (Shopify OAuth, embedded — no separate login).
- **Screencast URL:** the 3–8 min demo — must show onboarding **and** a clearance executing (approve→execute→revert). *(That clip comes from chat 7's filmed run on a seeded dev store — which also exercises the real write path before submit.)*
- **Testing instructions:**
  ```
  Jefe is an AI eCommerce manager for Shopify. It reads your store data to build a
  "Merchant Memory," surfaces the next move with the evidence, and can act on it — for
  each action type you choose whether Jefe recommends it, executes it on your approval,
  or runs it autonomously. Every action is previewed and reversible.

  Please install on a development store that has some products and a few orders — Jefe's
  value comes from real store data, so an empty store will show little.

  1. Install the app (Shopify OAuth) and open it in the Shopify admin.
  2. Connect: approve the requested scopes. Jefe begins reading orders, products,
     inventory, and locations.
  3. Merchant Memory: open "What Jefe knows about your business" to see the structured
     understanding Jefe has built. Entries can be inspected and corrected.
  4. Insights: review the insights generated from that memory.
  5. Goals: review and refine a goal for the store.
  6. Plan: review the recommended next moves — each shows the evidence behind it.
  7. Action (dead-stock clearance): where Jefe finds slow-moving stock it can mark it
     down. For each action type you set the mode (recommend / approve-then-execute /
     autonomous). Approving executes a real, reversible product update via the Shopify
     API, and can be undone.
  8. Optional: connect a Slack channel to receive Jefe's updates.

  Seeing an action execute: clearance needs slow-moving inventory, which a fresh test
  store may not have — the screencast shows the full approve → execute → revert flow on a
  data-rich store. For a live walkthrough on a seeded store, email hola@mynamejefe.com.

  Note: English-only at launch. Support: hola@mynamejefe.com.
  ```

## Tracking
- **Google Analytics:** *(not set at launch — pinned; add the Measurement ID post-launch, or now if a GA property exists)*
- **Google remarketing / Facebook Pixel:** skipped (no paid-ad program).

## Reference (not form fields)
- **OAuth scopes (7):** `read_products, write_products, read_orders, read_all_orders, read_customers, read_inventory, read_locations` (`write_products` powers clearance).
- **Protected customer data:** Level 2 (`read_customers` → name/email/address/phone).

---
*Items flagged "confirm" (search terms, plan handle) are my recommendations — update this record if what you actually entered differs.*
