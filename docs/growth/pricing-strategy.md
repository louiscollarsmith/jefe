# Pricing Strategy — Jefe (living doc)

> **Owner:** Jefe chat 6 (growth / commercial). **Living** — this tracks Jefe pricing from launch, through the tests we run, to public tiers, and evolves as we learn. [commercial-state.md](commercial-state.md) §5 stays the one-paragraph baseline; **this is the depth + the running log.** Treat the newest changelog entry as current truth.
> **Last updated:** 2026-07-31 · **Stage:** 0→10 (design partners, free) · **Revenue:** pre-revenue.

---

## 0. Where we are today (launch)
- **Free**, early-access / design-partner program. **No Billing API** integrated yet; **no paid plan live.**
- Design-partner terms: **free in-program + a founding rate** locked later (APPROVED 2026-07-29).
- We are **discovering value + willingness-to-pay (WTP)** — not charging, not price-testing yet.

## 1. Philosophy — how we think about the number
- **Value-anchored, not app-anchored.** The trap is pricing Jefe like "another Shopify app" ($20–50/mo). It's an AI *manager* that does the work of an eComm operator/analyst. Reference anchor = a fraction of a **$50–100k/yr hire** or a **$2–10k/mo agency**, not the app-store norm. The "AI manager, autonomy-from-day-1" positioning is precisely what unlocks the higher anchor — marketed as an app we cap at $50; marketed as a manager *with proof* $200–500+ is credible.
- **Autonomy is the value ladder.** recommend → approve-execute → autonomous, × breadth of action types = more value delivered = higher tier. This is both the tier structure **and** a built-in upgrade motion (as trust grows, merchants widen autonomy → they upgrade). Pricing rides the same ramp the product does.
- **Jefe acts → outcomes are measurable → outcome-based is the long-game lever.** Because actions have $ impact (clearance recovers trapped cash, reorder prevents stockouts), a base + success-fee model is the aligned end-state ("pay Jefe when it makes you money"). Powerful, differentiated — but attribution + merchant wariness make it a later experiment, not launch.
- **Free-now builds the pricing evidence base.** The ROI proof ("Jefe recovered $12k of dead stock in month one") is what justifies the eventual price. Free isn't only goodwill — it manufactures the case studies that set the number.

## 2. Working hypothesis — to VALIDATE, not decided (confidence: LOW)
Three tiers, laddered by breadth + autonomy of action:

| Tier | ~Price/mo | What it is | Mode |
|---|---|---|---|
| **Starter / Analyst** | ~$99 | Merchant Memory + insights + recommendations with evidence | recommend |
| **Operator** | ~$299 | + Jefe executes on your approval across core action types | approve-execute |
| **Autopilot** | ~$499 | + autonomous across many action types; higher limits | autonomous |

- These bands are a **starting frame, not a commitment.** Everything here gets validated (or discarded) via the roadmap below.
- **Open structural questions:** does the app-anchor cap the top tier? Is a **GMV-based** tier (price scales with store size) cleaner than feature-based? Is there a **usage/scale dimension** (order volume, catalog size, # actions)? Annual vs monthly discount?

## 3. How we learn & test — the roadmap (this is the part that changes over time)

### Phase 0 — now → first 10 (design partners, FREE)
- **Goal:** discover value + WTP, build ROI proof. **Not** price-testing.
- **Method:** run the WTP-discovery question set (§4) in every partner call; keep an **ROI ledger** — the $ value Jefe's actions create per partner.
- **Exit signal:** a value-attribution range + a reference-price picture + which capabilities command a premium.

### Phase 1 — 10 → 100 (founding cohort, introduce paid)
- **Prereq:** Billing API integration (pinned in [post-launch-backlog.md](post-launch-backlog.md)).
- **Method:** launch paid at a **single considered price** (from Phase-0 learnings) with a **founding rate** (locked-in discount for early adopters). Not A/B yet — validate by **conversion**: do free→paid conversions hold at $X?
- **Track:** free→paid conversion, churn, expansion (autonomy-ladder upgrades), the objections we hear.

### Phase 2 — 100 → 1,000 (public tiers, real testing)
- **Method:** public listing pricing; **A/B test** tier levels, boundaries, feature-ladder vs GMV-tier, annual vs monthly. Enough volume to split-test honestly.
- **Track:** listing-view → install → paid funnel *by price*; LTV/CAC by tier; downgrade/upgrade flows.

### Phase 3 — later (outcome-based experiment)
- **Method:** pilot **base + success-fee** on high-value actions with willing merchants. Measure attribution cleanliness + merchant reception before generalizing.

### Billing mechanics — the constraint that shapes all of the above
- **App-Store-listed apps must charge through Shopify's Billing API.** You can't quietly use an own biller for merchants who install via the public listing; the "charge outside Billing API" option requires Shopify's **explicit approval** (rarely granted — we don't have it, and don't need it).
- **The cut is 0% under $1M/yr of app revenue**, then ~15% above. So through the early stages Billing API costs us **nothing** — the "avoid Shopify's cut" worry is moot until *Jefe itself* is doing >$1M/yr in app revenue.
- **Own billing is only an option for direct / custom (non-App-Store) installs** — a separate distribution path, not the listed app.
- **So:** monetize via **Billing API** in Phase 1 (0% cut early); revisit own-billing only at real scale, and only if the ~15% actually bites.
- **Listing checkbox today:** leave *"I have approval to charge merchants outside the Shopify Billing API"* **unchecked** (we're free, and we lack — and don't need — that approval).

## 4. WTP-discovery question set (run in design-partner calls)
1. **Reference price** — "What would you have to hire or pay today to get this leverage?" (analyst / agency / tools)
2. **Value attribution** — "What $ impact do you credit to Jefe this month?" (feeds the ROI ledger)
3. **Van Westendorp (4):** at what monthly price is Jefe (a) a no-brainer, (b) expensive-but-worth-it, (c) too expensive to consider, (d) so cheap you'd question the quality?
4. **Ladder** — "Which would you pay *more* for: the recommendations, Jefe executing on approval, or full autonomy?"
5. **Model preference** — "Flat monthly fee, or a share of the value Jefe creates?"

## 5. Decisions & open questions (log — append as we learn)
- ✅ **DECIDED (2026-07-29):** launch **free / early-access**; no Billing API at launch; "charge outside Billing API" unchecked on the listing.
- ✅ **DECIDED (2026-07-29):** design-partner = **free in-program + founding rate** (rate TBD).
- ✅ **CLARIFIED (2026-07-31):** App-Store charges must run through **Shopify Billing API** (0% rev-share under $1M/yr, ~15% above); own-billing is only for direct/custom installs. Monetize via Billing API in Phase 1; the "charge outside Billing API" listing checkbox stays **unchecked**. (Corrects the earlier "own billing to dodge Shopify's cut" assumption — the cut is 0% until we're past $1M/yr anyway.)
- ❓ **OPEN:** the $99 / $299 / $499 bands — hypothesis only, unvalidated.
- ❓ **OPEN:** feature-ladder vs GMV-tier vs a usage dimension.
- ❓ **OPEN:** outcome-based (base + success-fee) as a later lever — attribution feasibility.
- ❓ **OPEN:** annual vs monthly; founding-rate size + lock-in length.

---

## Changelog
- **2026-07-31** — Doc created (chat 6). Captured the value-anchored philosophy, the autonomy pricing ladder, the $99/$299/$499 working hypothesis (LOW confidence), the phased learn→test roadmap (Phase 0 discover → 1 founding paid → 2 A/B tiers → 3 outcome-based), and the WTP-discovery question set for partner calls. Stage 0→10, pre-revenue.
