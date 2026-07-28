# Commercial State — Jefe (living baseline)

> **Owner:** Jefe chat 6 (growth infrastructure + commercial) · **Audience:** all Jefe sessions (product + growth) · **Last updated:** 2026-07-29
>
> This is the **shared commercial baseline**. Product sessions should read §1 (positioning), §2 (ICP), and §3 (activation) before making product-order decisions. This doc is updated as we learn — treat the newest changelog entry as current truth, and don't inherit anything contradicted below.

---

## 1. Positioning (accurate — precise about the ramp, don't overclaim what's shipped)

**Jefe is the AI eCommerce manager for a Shopify store.** It learns how the store operates from its own data (orders, products, customers, inventory, policies), builds a **Merchant Memory** the merchant can inspect and correct, and — today — recommends the next move with the evidence behind it.

- **The destination is action, not advice.** Merchant Memory is the *substrate*; the point is for Jefe to **operate** as the merchant's eCommerce manager, with **autonomy earned per action type**: advisory now → merchant approves a recommendation and Jefe executes it → progressively autonomous on the safe, high-confidence, reversible, low-blast-radius actions as trust is earned. Advisory-V1 is a deliberate **safety posture, not the endpoint**; the external-write guardrails (typed adapters, previews, approval gates, blast-radius caps, reversibility) are exactly what let autonomy grow safely. The merchant is always the principal — sets goals + autonomy levels, can veto or reverse anything. (Canonical: `AGENTS.md` → North Star.)
- **Don't overclaim what's shipped.** Present tense = advisory (recommends; merchant decides). Frame actioning/autonomy as the direction Jefe *earns*, not something it does to a store today. The live site's "…or actions it for you" is the aspirational edge — keep marketing on the right side of "earns the right to."
- **The core object is Merchant Memory** — durable, structured, versioned, correctable. Merchant-confirmed facts outrank model inference. This is the moat and the message.
- **What Jefe is not:** an analytics dashboard, a chatbot, or an *ungrounded* autonomous agent. Autonomy is memory-grounded and earned — never generic.

**One-liner (canonical, advisory-today):** *Jefe is the AI eCommerce manager that learns how your Shopify store actually works — tells you the next move today, and earns the right to just handle it.*

**Selling the ramp:** the pitch is not "an advisory tool" — it's *"your eCommerce manager: it learns your business, proves its recommendations, and takes over the routine work as you trust it."* Bigger story, and it's what the product is genuinely built toward.

**The buyer persona (site language):** "eCommerce manager" — the person who personally runs the store day to day.

---

## 2. Ideal Customer Profile — WORKING BASELINE

> **Status:** ✅ Confirmed as chat 6's call — Matt delegated the ICP (2026-07-29). Reframed from "single-market" to **single-store** after Matt's note that international sales are near-universal on Shopify. Reversible; revisit only on the parked 800-op signal (below).

**ICP: the established DTC Shopify brand — single store.**

| Dimension | ICP | Not (yet) |
|---|---|---|
| Platform | Shopify (standard) | Non-Shopify; Plus-only requirements |
| GMV | ~$1M–$20M / yr | <$250k (memory feels obvious); $50M+ (long sales cycle) |
| **Store structure** | **One Shopify store / one catalog** — selling internationally (UK + international, Shopify Markets, multi-currency) is normal and **first-class** | **Multiple stores / catalogs per brand**, Plus expansion stores — the genuinely-hard multi-store case |
| Team | Founder or eComm/ops manager runs the store; **no dedicated data analyst** | Teams with a BI/analyst function + existing tooling |
| Category | Considered-purchase DTC with real catalog + repeat behavior (apparel, beauty, food/bev, home, supplements) | Pure dropship / single-SKU / marketplace-only |
| Psychographic | Drowning in context-switching; wants a "manager" that *actually understands* the business | Wants a cheap analytics widget |

**The line that matters is single- vs multi-*store*, not single- vs multi-*market*.** Most of our ICP sells internationally from one store — that's table stakes, not a segmentation axis, and the product treats it as first-class (revenue/margin beliefs **normalize to the shop's base currency**; Shopify already stamps shop-currency totals on every order). What's deferred to upmarket is multi-*store* synthesis: separate US/UK stores, Plus expansion stores, cross-store identity.

**Why this ICP:**
1. **Memory is impressive here.** Enough complexity (real catalog, repeat behavior, returns, seasonality, international mix) that a correct structured memory is valuable and non-trivial — but bounded enough (one store) to reach *"yes, that's exactly how my business works"* **fast**. That first-yes is the activation event.
2. **Founder-accessible.** Reachable founder-to-founder through DTC communities, agencies, and warm intros — essential for the pre-launch, concierge design-partner motion.
3. **Real willingness to pay.** $1M–$20M brands don't blink at $100–$500/mo for leverage; they lack (and want) a manager/analyst.
4. **Clean onboarding at the right scope.** One store builds correct memory quickly; multi-*store* is the #1 way memory-build gets slow and error-prone. Deferring it protects the "correct memory, fast" promise.

**Design-partner qualification checklist** (use to triage waitlist + outreach):
- [ ] Shopify store, live, shipping real orders (not a test store)
- [ ] ~$1M–$20M GMV (proxy: order volume, catalog depth, team size)
- [ ] One Shopify store (selling internationally / multi-currency is fine)
- [ ] Founder or eComm manager is the hands-on operator (our buyer is on the call)
- [ ] Feels the pain: "I can't keep the whole business in my head"
- [ ] Willing to connect Shopify data + give feedback (design-partner spirit)

**Move to multi-*store* brands at the 100→1000 stage**, not before — that's when ACV justifies the complexity. Chat 4 keeps the belief model extensible for it, but does **not** build multi-store synthesis now.

**Extension boundary (agreed with chat 4, 2026-07-29):** keep beliefs *market-scopable* — a belief can grow a market/segment dimension later without changing its identity (beliefs are shop-scoped today; Markets-within-a-store is the v2 seam). For the common one-store-international case, beliefs should **normalize to the shop's base currency** (the shop-currency total is already on Shopify orders — the `*_set` / money-bag fields) rather than skipping multi-currency stores. Multi-*store* synthesis is the deferred extension. This is how "single-store depth now" stays a clean extension, not a rewrite.

**Parked signal — the "800-operator Slack channel."** An earlier product doc ranked multi-market #1 off a Slack channel Matt shared; Matt has since delegated the ICP and doesn't read multi-market as the wedge. Left unexplored on purpose. Revisit the wedge only if that channel turns out to be a named acquisition channel or a concentration of a specific brand type.

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

- **Resend:** one verified domain — `mynamejefe.com` (root, EU/eu-west-1, sending enabled). Used for **product transactional** email.
- **Sender identity (confirmed Matt, 2026-07-29):** transactional email sends as **`Hola <hola@mynamejefe.com>`** (address on the verified root domain — no subdomain needed), **Reply-To `matt@mynamejefe.com`**. ✅ Both `RESEND_FROM_EMAIL` and `RESEND_REPLY_TO` **set on the Railway `jefe` service (production), 2026-07-29** via CLI with `--skip-deploys` (applies on next deploy). Remaining for full effect: chat 2's adapter must read `RESEND_REPLY_TO` (Reply-To support) + update `.env.example`; the From works today without it. Still `ENABLE_EMAIL`-gated (not live yet). **NB:** the `apps/shopify` dir is Railway-mislinked to `jefe-shepherd` (repo `korso-ai/shepherd`) — always target `--service jefe` explicitly.
- **Rule:** growth/marketing outbound must NOT share the transactional stream — a bounce/spam complaint on a campaign would poison password-reset-grade deliverability.
- **Growth subdomain — approved in principle (Matt, 2026-07-29) but execution deferred:** a dedicated growth sending subdomain (`hola.mynamejefe.com`) for separate reputation. **Resend's current plan includes only 1 domain**, so it needs a paid upgrade. Timing says wait: 0→10 outreach is **personal 1:1 (Matt's own inbox)**, which needs no subdomain. The subdomain earns its keep when we build **automated lifecycle email at 10→100** — upgrade Resend and create it *then*. Until then: **no bulk/automated growth sends on the transactional domain**.
- **Hard rule (both streams):** **no real outbound campaign sends without Matt's explicit OK**, same as the product side.

---

## 7. What each product session should take from this

- **chat 4 (merchant memory/value):** ICP = established DTC, **single store**. Build single-store **depth** first, with international/multi-currency **first-class** (normalize beliefs to the shop's base currency — likely already-ingested Shopify `shop_money`, verify — not "skip with diagnostics"). Defer multi-*store* synthesis to 100→1000. Confirmed 2026-07-29; re-rank green-lit.
- **chat 2 (onboarding/channels/comms):** onboarding must get an ICP merchant to **Activated** (memory confirmed + 1 rec accepted) with **minimal founder touch** — that's the 10→100 gate. Qualification checklist (§2) can inform waitlist triage. Transactional sender is now `Hola <hola@mynamejefe.com>` / Reply-To `matt@` (§6).
- **chat 3 (observability/analytics/cost):** please expose `ProductEvent`s for `memory_confirmed` and `recommendation_accepted`; chat 6 consumes them for lifecycle + the commercial dashboard. Cost ledger you're building feeds per-client margin, which gates paid-acquisition spend at 100→1000.
- **chat 5 (feedback triage):** design-partner feedback is our PMF instrument — tag feedback by ICP-fit so we can separate "signal from our ICP" vs. noise from off-ICP installs.

---

## 8. Decisions

1. ~~**ICP**~~ — ✅ **CONFIRMED 2026-07-29** (Matt delegated → chat 6's call). Established DTC **single store** ($1M–$20M); international/multi-currency first-class; multi-*store* deferred to 100→1000. chat 4 green-lit to re-rank. See §2.
2. **Growth outbound subdomain** — approved in principle, but **deferred to 10→100**: blocked by Resend's 1-domain plan (needs upgrade), and not needed while 0→10 outreach is 1:1 from Matt's inbox. See §6.
3. ~~**Design-partner pricing**~~ — ✅ **APPROVED 2026-07-29** (free-in-program + founding rate). See §5.
4. ~~**Email sender**~~ — ✅ **CONFIRMED 2026-07-29** — send as `Hola <hola@mynamejefe.com>`, Reply-To `matt@mynamejefe.com`. See §6.

---

## Changelog

- **2026-07-29 (pm)** — Matt delegated the ICP; **reframed single-market → single-store** (international/multi-currency is table stakes on Shopify → first-class now, not a segmentation axis; multi-*store* deferred to 100→1000). Green-lit chat 4 to re-rank. Aligned §1 positioning to the sharpened product narrative (Merchant Memory = substrate; destination = Jefe operating as eCommerce manager with autonomy earned per action type; advisory-V1 is a safety posture, not the endpoint). Confirmed transactional sender `Hola <hola@mynamejefe.com>` + Reply-To `matt@`.
- **2026-07-29 (am)** — Matt approved design-partner pricing (free-in-program + founding rate) and the growth subdomain *in principle* (execution deferred to 10→100 — Resend's 1-domain plan needs an upgrade, and 0→10 outreach is 1:1 anyway). Shipped the commercial tracker v0 (`apps/growth`, ICP triage over `waitlist_signups`) and the build-vs-buy tooling view ([growth-stack.md](growth-stack.md)).
- **2026-07-28** — Doc created (chat 6). Set working ICP, positioning one-liner, draft activation definition, pricing hypothesis, deliverability plan. Steered chat 4 on memory build order. Stage = 0→10.
