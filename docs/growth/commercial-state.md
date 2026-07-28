# Commercial State — Jefe (living baseline)

> **Owner:** Jefe chat 6 (growth infrastructure + commercial) · **Audience:** all Jefe sessions (product + growth) · **Last updated:** 2026-07-28
>
> This is the **shared commercial baseline**. Product sessions should read §1 (positioning), §2 (ICP), and §3 (activation) before making product-order decisions. This doc is updated as we learn — treat the newest changelog entry as current truth, and don't inherit anything contradicted below.

---

## 1. Positioning (accurate — do not overclaim)

**Jefe is the AI manager for a Shopify store.** It learns how the store operates from its own data (orders, products, customers, inventory, policies), builds a **Merchant Memory** the merchant can inspect and correct, and recommends the next move with the evidence behind it.

- **V1 is advisory.** Jefe recommends; the merchant decides. Autonomy ("Jefe actions it for you") is the **stated ramp**, earned per-merchant as trust builds — not a shipped default. Marketing may reference the ramp ("…or actions it for you") because the live site already does, but must not imply Jefe autonomously mutates a store today.
- **The core object is Merchant Memory** — durable, structured, versioned, correctable. Merchant-confirmed facts outrank model inference. This is the moat and the message.
- **What Jefe is not:** an analytics dashboard, a generic chatbot, or an autonomous agent that writes to Shopify today.

**One-liner (canonical):** *Jefe is an AI e-commerce manager that learns how your Shopify store actually works — then tells you the next move, with the receipts.*

**The buyer persona (site language):** "e-commerce manager" — the person who personally runs the store day to day.

---

## 2. Ideal Customer Profile — WORKING BASELINE

> **Status:** Adopted by chat 6 as the working ICP. Reversible; flagged for Matt's gut-check (see §8). Communicated to chat 4 (merchant-memory build order) on 2026-07-28.

**ICP: the established single-market DTC Shopify brand.**

| Dimension | ICP | Not (yet) |
|---|---|---|
| Platform | Shopify (standard) | Non-Shopify; Plus-only requirements |
| GMV | ~$1M–$20M / yr | <$250k (memory feels obvious); $50M+ (long sales cycle) |
| Markets | **One primary market / currency / catalog** | Multi-market, multi-currency, multi-storefront |
| Team | Founder or eComm/ops manager runs the store; **no dedicated data analyst** | Teams with a BI/analyst function + existing tooling |
| Category | Considered-purchase DTC with real catalog + repeat behavior (apparel, beauty, food/bev, home, supplements) | Pure dropship / single-SKU / marketplace-only |
| Psychographic | Drowning in context-switching; wants a "manager" that *actually understands* the business | Wants a cheap analytics widget |

**Why this ICP:**
1. **Memory is impressive here.** Enough complexity that a correct, structured memory is non-trivial and valuable — but simple enough (one market) that Jefe reaches *"yes, that's exactly how my business works"* **fast**. That first-yes is the entire activation event.
2. **Founder-accessible.** Reachable founder-to-founder through DTC communities, agencies, and warm intros — essential for a pre-launch, concierge design-partner motion.
3. **Real willingness to pay.** $1M–$20M brands don't blink at $100–$500/mo for leverage; they lack (and want) a manager/analyst.
4. **Clean onboarding.** Single-market data builds correct memory quickly; multi-market is the #1 way memory-build gets slow and error-prone. Deferring it protects the "correct memory, fast" promise.

**Design-partner qualification checklist** (use to triage waitlist + outreach):
- [ ] Shopify store, live, shipping real orders (not a test store)
- [ ] ~$1M–$20M GMV (proxy: order volume, catalog depth, team size)
- [ ] One primary market/currency (single-market)
- [ ] Founder or eComm manager is the hands-on operator (our buyer is on the call)
- [ ] Feels the pain: "I can't keep the whole business in my head"
- [ ] Willing to connect Shopify data + give feedback (design-partner spirit)

**Move upmarket to multi-market established brands at the 100→1000 stage**, not before — that's when ACV justifies the memory complexity. Chat 4 has been told to keep the belief model extensible for it, but **not** to build multi-market synthesis now.

---

## 3. Activation & the commercial funnel (draft — align with chat 3)

The commercial funnel sits on top of the product onboarding funnel (Connect → Memory → Confirm → Insights → Goals → Plan). Proposed shared definitions:

- **Signup** — joined waitlist / installed.
- **Onboarded** — Shopify connected + first Merchant Memory built.
- **⭐ Activated (the north-star commercial event)** — merchant **confirmed the memory is accurate** ("yes, that's my business") **and** acted on / accepted ≥1 recommendation. This is the "aha" and the leading indicator of everything.
- **Retained** — still engaging in week 4.
- **Paying** — on a paid plan (post-billing).
- **Expanded** — upgraded (e.g. toward autonomy tiers as they ship).

> **Ask to chat 3 (observability/analytics):** the `ProductEvent` stream should let us compute Activated + week-N retention per merchant. Chat 6 will consume it for lifecycle triggers and the commercial dashboard. Let's agree the exact event names for `memory_confirmed` and `recommendation_accepted`.

---

## 4. Current commercial status

- **Stage:** 0 → 10 (design partners / concierge). See [growth-strategy.md](growth-strategy.md).
- **Distribution live:** waitlist site at mynamejefe.com (Design Partner Program, "first 100 e-commerce managers"). Signups stored in `waitlist_signups` (Neon).
- **App Store:** not yet listed. Pre-launch.
- **Billing:** none yet (no `AppSubscription` integration). Pricing is a hypothesis (§5).
- **Metrics to wire (TODO chat 6):** waitlist count + ICP-qualified share; design-partner pipeline; activation rate; week-4 retention. Pull waitlist count from `waitlist_signups`; funnel from chat 3's analytics.

---

## 5. Pricing (design-partner model APPROVED 2026-07-29; public tiers still a hypothesis)

- **APPROVED (Matt, 2026-07-29):** Design partners are **free during the program** in exchange for feedback + a testimonial + a commitment to convert at a **founding-partner rate**. This is the plan, not a hypothesis.
- Anchor on **value vs. a human e-commerce manager/analyst** ($3–6k/mo), not vs. a $19 analytics app.
- Public tiers (hypothesis): likely **$99–$499/mo** for advisory V1; **autonomy tiers priced higher** as actioning ships (natural expansion path).
- Validate willingness-to-pay in design-partner conversations *before* the App Store listing sets a public price.

---

## 6. Outbound & deliverability setup

- **Resend:** one verified domain — `mynamejefe.com` (root, EU/eu-west-1, sending enabled). Used for **product transactional** email (welcome, unsubscribe).
- **Rule:** growth/marketing outbound must NOT share the transactional stream — a bounce/spam complaint on a campaign would poison password-reset-grade deliverability.
- **APPROVED (Matt, 2026-07-29):** stand up a dedicated **growth sending subdomain** — `hola.mynamejefe.com` (on-brand). Separate Resend domain → separate reputation. Next step: create the domain in Resend → hand Matt the DNS records to add (his action) → verify. Transactional stays on root (consider moving it to `mail.` later for full isolation). Sending anything real still needs Matt's per-campaign OK.
- **Hard rule (both streams):** **no real outbound campaign sends without Matt's explicit OK**, same as the product side.

---

## 7. What each product session should take from this

- **chat 4 (merchant memory/value):** ICP = single-market established DTC. Build single-market memory **depth** first; keep multi-market as a v2 extension, don't foreground it. (Full steer sent 2026-07-28.)
- **chat 2 (onboarding/channels/comms):** onboarding must get an ICP merchant to **Activated** (memory confirmed + 1 rec accepted) with **minimal founder touch** — that's the 10→100 gate. Qualification checklist (§2) can inform waitlist triage.
- **chat 3 (observability/analytics/cost):** please expose `ProductEvent`s for `memory_confirmed` and `recommendation_accepted`; chat 6 consumes them for lifecycle + the commercial dashboard. Cost ledger you're building feeds per-client margin, which gates paid-acquisition spend at 100→1000.
- **chat 5 (feedback triage):** design-partner feedback is our PMF instrument — tag feedback by ICP-fit so we can separate "signal from our ICP" vs. noise from off-ICP installs.

---

## 8. Decisions

1. **ICP** — *working baseline, unobjected.* Single-market established DTC ($1M–$20M), multi-market deferred to 100→1000. Chat 4 steered. Still worth Matt's explicit gut-check when convenient; proceeding on it meanwhile.
2. ~~**Growth outbound subdomain**~~ — ✅ **APPROVED 2026-07-29** (`hola.mynamejefe.com`). See §6.
3. ~~**Design-partner pricing**~~ — ✅ **APPROVED 2026-07-29** (free-in-program + founding rate). See §5.

---

## Changelog

- **2026-07-29** — Matt approved design-partner pricing (free-in-program + founding rate) and the `hola.mynamejefe.com` growth subdomain. Shipped the commercial tracker v0 (`apps/growth`, ICP triage over `waitlist_signups`) and the build-vs-buy tooling view ([growth-stack.md](growth-stack.md)). ICP stands as unobjected working baseline.
- **2026-07-28** — Doc created (chat 6). Set working ICP (single-market established DTC), positioning one-liner, draft activation definition, pricing hypothesis, deliverability plan. Steered chat 4 on memory build order. Stage = 0→10.
