# Post-launch backlog — the "pins"

> **Owner:** Jefe chat 6 (growth). Deferred-but-tracked items we consciously parked to focus on launch. **Nothing here blocks launch.** Grouped + roughly stage-tagged. Companion to [growth-strategy.md](growth-strategy.md) + [commercial-state.md](commercial-state.md).
> **Last updated:** 2026-07-31 (parked during the App Store submission fill).

## A. App Store listing — fill / optimize as we go (all editable post-launch)
- **Integrations field:** add Klaviyo + others **as each actually ships** (Slack listed at launch). Don't list unbuilt integrations — reviewer-flag + merchant-trust risk.
- **Resources — FAQ / Tutorial / Changelog / docs:** build + link post-launch. FAQ first, seeded from the questions design partners actually ask. (Privacy policy URL is already live + linked.)
- **Support portal:** add around 100→1k when ticket volume justifies it. Concierge email (`hola@mynamejefe.com`) until then.
- **Demo store URL:** N/A for an admin-embedded app (nothing shows on a public storefront) — the feature video carries it. Revisit only if a storefront-visible surface ships.
- **Tracking — Google Analytics:** set up a GA property + add the **Measurement ID** (and API Secret for install tracking) to the listing → the only way to see listing-view→install conversion (core growth-funnel signal). ~10 min setup; do at launch if a property exists, else early post-launch.
- **Tracking — Google remarketing + Facebook Pixel:** **skip** unless/until we run paid ads (we're warm/direct now). Revisit if a paid-acquisition channel opens (100→1k+).
- **"Built for Shopify" status:** target after the first cohort of reviews (badge + ranking boost + "Picked for you").
- **Localization (German → French):** 100→1k item. Adding a language = fully translated listing + re-attest + re-review, not a checkbox.

## B. Legal — near-term (post-privacy)
- **Terms of Service + DPA pages live:** read-through → reconcile to autonomy-from-day-1 → chat 7 merges. (Privacy is live at `/privacy`.)
- **DPA finalization:** Neon region, Railway region, Neon PITR/backup window (Matt's console values).
- **`hola@` receiving alias:** it's now the public support/contact email — ensure it actually receives.
- **Legal-watch alert:** add `ALERT_WEBHOOK_URL` as a repo Actions secret so the Slack ping fires (chat 7/Matt).
- **Lawyer review** pass on privacy / terms / DPA.

## C. Onboarding / conversion surfaces
- **/early-access install landing page:** build from [early-access-install-spec.md](early-access-install-spec.md) (design session) — the unlisted-link front door.
- **Reviewer test store + clearance-executing screencast** (also the real-write verification with chat 7).
- **Post-install "welcome to early access" first-run state** (nice-to-have).

## D. Growth engine
- **Content engine:** wire up once Matt provides the Jefe X handle + LinkedIn company page. **Before it posts:** update its voice guardrail + content ideas from advisory-era → autonomy-from-day-1 / three-mode.
- **Framing sweep (finish):** reconcile residual advisory-era language in `content-engine.md`, `design-partner-playbook.md`, `growth-strategy.md`.
- **Warm outreach (Quiver cohort):** tiered lists ready; **pending consent basis + Matt's go** — no sends yet.
- **Reviews engine:** ask each activated design partner to review **at the aha moment** — first reviews disproportionately drive ranking.

## E. Product-adjacent (chat 4 / 7 lanes, growth-relevant)
- **More action types beyond clearance:** each re-adds its write scope via `scopes_update` (merchant re-consent) — sequence for review-friendliness.
- **Multi-store support:** 100→1k (ICP defers it).
- **Billing API integration:** before monetizing (10→100 gate; free / early-access until then).

## F. Monetization
- **Public pricing tiers:** hypothesis $99–$499 entry; higher tiers as autonomy broadens (more action types + more autonomous). Validate with design partners before publishing.

---
*How to use: pull from here when a launch task frees up. Promote an item into [growth-strategy.md](growth-strategy.md) when it becomes the active focus. Add new pins as they're parked.*
