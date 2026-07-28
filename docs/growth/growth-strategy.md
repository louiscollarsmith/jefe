# Growth Strategy — Jefe (10 → 100 → 1,000 → 10,000)

> **Owner:** Jefe chat 6 · **Last updated:** 2026-07-28 · **Companion:** [commercial-state.md](commercial-state.md) (living baseline: positioning, ICP, activation)
>
> A **stage-gated** plan. Each stage has one goal, one metric that matters (OMTM), the motion, what to build, the gate to advance, and — just as important — **what not to do yet**. We update this as we learn; premature scaling is the main failure mode, so gates are real.

---

## The engine (applies at every stage)

Jefe's product north star is a loop: **Understand → Recommend → Execute → Observe → Learn.** The **growth engine is the same loop pointed at merchants:**

**Observe** (instrument the funnel) → **Understand** (where do ICP merchants stall / what converts) → **Recommend/Execute** (the right nudge, channel, or campaign) → **measure → Learn** → tighten.

Two constraints thread through all four stages:

- **Trust is the gating input to growth.** Jefe asks a merchant to connect their entire store and eventually to *act* for them. So security posture, transparency, and "memory you can correct" are **growth features**, not just product ones. Growth can never outrun earned trust — that's why V1 is advisory and autonomy is a per-merchant ramp.
- **Activation is the leading indicator, not signups.** The whole machine optimizes for **Activated** merchants (memory confirmed + ≥1 recommendation accepted), because a vanity waitlist that never activates teaches us nothing and compounds nothing.

---

## Stage 0 → 10 · Design Partners (concierge)

**Goal:** Prove Jefe reliably produces the *"yes, that's exactly how my business works"* moment plus one acted-on recommendation — for our ICP. Learn what activation really requires.

**OMTM:** # of design partners who **activated** (confirmed memory + accepted a rec) **and** would be "very disappointed" without Jefe (Sean-Ellis PMF signal, target ≥40%).

**ICP focus:** Single-market established DTC ($1M–$20M). Hand-picked. Quality over quantity.

**Motion & channels — founder-led, hand-to-hand:**
- Matt personally recruits ~40–60 qualified prospects to land 10 partners.
- Sources: warm intros; DTC founder communities (Twitter/X DTC scene, relevant Slack/Discord, indie e-comm forums); e-commerce agencies (they touch many ICP stores); the waitlist (qualify against the §2 checklist).
- **Concierge onboarding:** Matt on a call, white-glove. No self-serve required yet.

**What chat 6 builds (growth infra):**
1. **Commercial tracker / lightweight CRM** — design-partner pipeline (prospect → contacted → call → onboarding → activated → advocate). First infra deliverable. Lives in the growth code area (not `apps/shopify`).
2. **1:1 outbound tooling** — sending subdomain (§6 of commercial-state) + personal (not bulk) outreach templates + reply tracking. **Personal 1:1 only at this stage — no campaigns.**
3. **Waitlist → qualified-partner flow** — pull `waitlist_signups`, score ICP-fit, tag.
4. **Activation baseline** — with chat 3, lock the definition + first read of the funnel.

**What product sessions build:** rock-solid onboarding + memory correctness for the ICP. Concierge covers the gaps.

**Gate to advance (→ 100):**
- ≥6–8 of 10 partners **activated** and retained ~4 weeks.
- PMF signal ≥40% "very disappointed."
- A **repeatable, nameable "aha"** we can point to.
- Willingness-to-pay validated in conversation.

**Do NOT yet:** paid ads · App Store SEO investment · lifecycle automation · scaled outreach · referral loops · productized self-serve onboarding. Learning > scaling.

---

## Stage 10 → 100 · Repeatable partners → paid ("first 100 e-commerce managers")

**Goal:** Find **one** repeatable acquisition channel; convert design partners to paid; make onboarding self-serve enough to remove Matt from every install.

**OMTM:** net-new **activated** merchants / week from a *repeatable* channel, + week-4 retention.

**Motion:** Templatized founder involvement. **Shopify App Store listing goes live** (the big distribution unlock). First lifecycle email program. Introduce pricing/billing.

**Channels — test 2–3, keep the winner:**
1. **Shopify App Store** — listing + first reviews from activated design partners → ranking flywheel.
2. **Content / category SEO** — own the "Merchant Memory" / "AI e-commerce manager" narrative; how-your-store-actually-works POV content.
3. **Agencies / partners** — e-comm agencies manage many ICP stores = leverage per relationship.
4. **Founder brand / build-in-public** — Matt's POV in DTC communities.

**What chat 6 builds (growth infra):**
- **Lifecycle email engine** (Resend, growth subdomain): event-triggered off chat 3's `ProductEvent` stream — welcome, step-specific onboarding nudges, "insights ready," stall recovery, reactivation. Behavioral, not blast.
- **App Store listing assets** + a **review-generation flow** (ask activated merchants at the right moment).
- **Referral seed** — soft "invite another merchant."
- **Commercial dashboard v1** — pipeline, activation rate, channel attribution, week-N retention, early MRR.
- **Partner/agency program v0.**

**Gate to advance (→ 1,000):**
- A channel with **known CAC** and predictable volume.
- Self-serve **activation without founder touch** above target.
- **Positive net revenue retention**; **margin known** (chat 3 cost ledger + billing).

**Do NOT yet:** multi-channel paid scaling · a sales team · enterprise/Plus motions · heavy multi-market product investment.

---

## Stage 100 → 1,000 · Scale the engine

**Goal:** Turn the one channel into a machine, add a second, make unit economics work, make self-serve excellent.

**OMTM:** CAC:LTV + payback period; scalable-channel throughput; NRR.

**Motion:** Scalable acquisition (App Store ASO/ranking, paid where CAC works, productized agency partnerships, incentivized referral loop, content engine). **Sales-assist** for the top of the ICP (bigger established brands). This is where **moving upmarket** begins.

**What chat 6 builds:**
- **Referral loop** with tracking + incentive.
- **Paid acquisition** instrumentation + attribution.
- **Agency/partner portal** (multi-store management, revenue share).
- **Lifecycle sophistication** — segmentation, win-back, expansion prompts (upsell toward autonomy tiers as the product ramps).
- **Margin-aware growth** — don't scale-acquire unprofitable segments (uses chat 3's cost ledger).
- **Sales CRM** for assisted deals.

**Product tie-in:** **now** signal chat 4 to build **multi-market memory** — ACV upmarket finally justifies the complexity. This is the pre-planned extension point, not a rewrite.

**Gate to advance (→ 10,000):** repeatable **multi-channel** acquisition · healthy payback · expansion revenue · low-touch onboarding at scale · early brand pull.

**Do NOT:** over-customize for enterprise one-offs · ignore margin · let CAC outrun payback.

---

## Stage 1,000 → 10,000 · Category & compounding

**Goal:** Category leadership ("AI e-commerce manager" / "Merchant Memory"), compounding loops, expansion revenue, autonomy tiers as the product ramps.

**OMTM:** NRR + organic/word-of-mouth share of new merchants + blended payback.

**Motion:** Brand + category creation; Shopify ecosystem partnerships + integrations marketplace; outbound sales for enterprise/Plus; international; community/advocacy.

**What chat 6 builds:**
- **Expansion monetization** as autonomy ships (advisory → actioning = the natural upsell ladder).
- **Ecosystem integrations** (more systems Jefe reads/acts on = stickier + higher memory value).
- **Community/advocacy engine.**
- **Full RevOps** — forecasting, cohort economics, multi-product.

**Do NOT:** dilute the memory-correctness moat while scaling · let growth outrun trust (autonomy must stay earned).

---

## Chat 6 infra roadmap, mapped to stages

| Now (0→10) | 10→100 | 100→1,000 | 1,000→10,000 |
|---|---|---|---|
| Commercial tracker/CRM | Lifecycle email engine | Referral loop + attribution | Expansion/monetization tooling |
| 1:1 outbound + subdomain | App Store assets + reviews | Agency/partner portal | Ecosystem integrations |
| Waitlist ICP scoring | Commercial dashboard v1 | Paid-acquisition instrumentation | Advocacy/community engine |
| Activation baseline (w/ chat 3) | Referral seed | Margin-aware growth + sales CRM | Full RevOps |

All growth **code** lives outside `apps/shopify` (see [README.md](README.md)) to avoid collisions with the four product sessions.

---

## Changelog

- **2026-07-28** — Created (chat 6). Four stages defined with OMTM, motion, build, gates, and anti-goals. Multi-market memory pinned to the 100→1,000 upmarket step.
