# Merchant Memory — Current State & Gaps

> **What this is.** An honest, dated map of what Merchant Memory knows today, what it does not yet, and where to push next. It complements the principle-level docs (`merchant-memory.md`, `store-understanding.md`, `conversational-merchant-memory.md`, `merchant_memory_data_model.md`) — those describe *how it works*; this describes *how good it is and where to push*.
>
> **Sources.** Original four-pass code audit + an ~800-member e-commerce operators Slack channel demand signal (2026-07-28), **refreshed 2026-07-29** after a large fidelity wave shipped and the founder set the forward direction (a demand-derived **action ontology** with a merchant-set **autonomy slider**). Keep it current as items ship.

## The frame

The product loop is **Understand → Recommend → (Execute) → Observe → Learn**.

As of 2026-07-29 the **Understand** layer is broad and grounded — the "thin on the axes merchants think in" problem is largely closed (see the shipped list). The frontier has moved twice:

1. *Go-live hardening* → done.
2. *Memory fidelity + closing the learn loop* → **largely done** (product/margin/returns/customer/inventory/geo/time beliefs; gap-driven questions; the post-onboarding correction surface is live; passive outcome capture exists).
3. **Now: the Kinetic layer.** The marginal *belief* has diminishing returns — depth you don't act on is a prettier dashboard. The value has moved to **acting** on memory: a **demand-derived action ontology** (executable actions + decision-support intents, discovered from what merchants ask and do, not hand-authored) governed by typed adapters, with a **merchant-set autonomy slider** (recommend → approve→execute → earned autonomy per action class). Memory is now the *substrate*; the destination is Jefe operating as the eCommerce manager. See the North Star in `AGENTS.md`; a dedicated ontology + autonomy-as-policy direction doc is the recommended next design artefact.

**One-line read:** stop adding beliefs for their own sake; deepen only where an action or a decision needs it, and start building the layer that *uses* the memory.

## What's solid — keep, don't rebuild

**Foundations**
- **Relational, versioned, provenanced belief store** — beliefs / evidence / append-only history / refresh-runs; atomic version bumps.
- **Deterministic-vs-inferred boundary is exemplary** — numeric facts computed in app code; the LLM store-understanding schema has no number field and cannot overwrite deterministic beliefs. This discipline now extends to the **multi-modal feed**: structured input (a costs sheet) → deterministic fact; unstructured (doc/voice) → inference until the merchant confirms.
- **Merchant-correction precedence is coded and enforced at every write site**, tested.
- **Generators are genuinely grounded** — Insights/Goals/Plan citations validated against the belief allowlist; numeric claims traced to belief *values*; hardened for **structured** belief values (`*Percent` fields) and made to **degrade gracefully** to deterministic observations instead of hard-failing.
- **Airtight multi-tenancy; disciplined ingestion.**

**Belief content now in memory (shipped 2026-07-29 wave)**
- **Product performance** — selling/no-sale counts, revenue concentration (top / top-5 share), best-seller by revenue and by units, **product momentum** (risers/fallers), **revenue by product type** (attribute slicing).
- **Margin / COGS** — `cost_coverage` + coverage-gated `gross_margin`, from Shopify `unitCost` **and** a merchant **cost-sheet upload** (bulk gap-fill).
- **Returns-by-SKU** — `top_returned_products` with return rate, from backfill **and** the refunds webhook.
- **Customer memory** — repeat-customer rate, **repeat revenue share**, **average lifetime spend** (repeat vs one-time), **top-customer concentration**.
- **Inventory velocity** — **days-of-cover** reorder signals: `at_risk_stockout_count` + `low_cover_products` (the reorder list).
- **Time & seasonality** — **year-over-year** growth, **recent revenue trend**, **peak sales month**, on a configurable **24-month** history window.
- **Geo & channel** — **`revenue_by_region`** (revenue by destination country), **`online_revenue_share`** (store vs online vs marketplace), and **shop-base-currency normalization** so multi-currency stores are no longer skipped.
- **Learn loop (partial)** — **recommendation-engagement** capture; **gap-driven open questions** that raise *and retract* themselves as data fills (e.g. "add your product costs").

**Loops now running**
- **Post-onboarding correct-anything surface is LIVE** (onboarding session, Phase 1) — the memory view carries a "tell me what's wrong or missing" conversation + per-belief `correctable`. The north-star convergence mechanism now runs continuously, not once.
- **Multi-modal memory feed foundation** — modality-agnostic capture → the engine's structured operations; first net-new modality (cost sheets → deterministic facts) shipped.

## Remaining gaps (the real list, 2026-07-29)

1. **The Kinetic layer is unbuilt.** No executable actions, no belief→action binding, no autonomy slider yet. This is the single biggest gap now — the destination the memory exists for. Needs the architecture session for the typed-adapter/action-framework shape (a one-way-door design → founder + architecture).
2. **Markets/languages/locations aren't first-class *dimensions*.** We now have destination-country revenue + channel split + currency normalization, but performance isn't sliced **× market** across beliefs, and languages / multi-location inventory / localized SEO aren't modeled.
3. **No per-region margin.** `revenue_by_region` gives geo *revenue*; the store-split / US-expansion decision also needs margin-by-region (duties/landed cost). (Surfaced directly by an operator's live store-split question.)
4. **Marketing / channel / ROAS memory.** Still absent — needs non-Shopify connectors (Meta/Google/Klaviyo) + attribution. Longer horizon.
5. **The Learn loop is passive.** Recommendation *engagement* is captured but outcomes aren't measured back into belief confidence/autonomy — matures alongside Execute.
6. **Dynamic conversation token budget.** A mitigation shipped (bounded per-belief serialization); the full budget (trim-to-fit, prioritise discussed beliefs) is pending for the largest memories.
7. **Smaller follow-ups:** returns *reasons* (Returns API, vs units/value today); cost provenance + override (cost-sheet is gap-fill only); a coarse region rollup (UK/EU/US/ROW) + domestic-vs-international headline; multi-*store* synthesis (the 100→1000 extension).

## Demand-side signal (operator channel) — status

| # | What operators keep raising | Status 2026-07-29 |
|---|---|---|
| 1 | **Multi-market / geo / currency / language / location** | ⚠️ **partial** — country-revenue + channel + currency shipped; per-market slicing, languages, multi-location still open (gap #2) |
| 2 | **Product & attribute performance** | ✅ **shipped** — per-product performance + momentum + revenue-by-product-type |
| 3 | **Inventory velocity / reorder** | ✅ **shipped** — days-of-cover + reorder list |
| 4 | **Returns/refunds & anomalies** | ✅ returns-by-SKU shipped; reasons + anomaly detection open |
| 5 | **Marketing/channel performance (ROAS)** | ❌ deferred — needs connectors (gap #4) |
| 6 | **Store-split / international expansion** (new, live) | ⚠️ geo-revenue shipped as the first brick; per-region margin + decision-support intent open (gaps #3, #1) |

## Recommended build order

**Near-term memory depth (only where an action/decision needs it):**
1. **Per-region margin** + a coarse market rollup — completes the store-split / expansion decision-support picture; small, deterministic, high operator salience.
2. **Market as a first-class slice** (product × market) — the established-brand ICP's #1 ask.
3. **Dynamic conversation token budget** — robustness for memory-rich merchants (the feed will drive more conversation traffic).

**The frontier — the Kinetic layer (needs founder + architecture sign-off):**
4. **Intent-capture** — log every merchant action-intent (incl. the ones Jefe can't yet fulfil) as candidate-intent records; the seed corpus of the demand-derived ontology. Low-risk, observation-only, buildable now.
5. **First executable action, end-to-end — reorder.** Memory already justifies it (`low_cover_products` + days-of-cover); a clean first typed adapter (preview + approval, slider-defaulted to propose-only). Exercises belief → decision → typed action → outcome.
6. **Belief→action binding + the autonomy slider as policy over the ontology** (recommend / ask-then-act / act, per action risk × merchant setting × Jefe confidence).

**Deferred (need connectors or Execute maturity):** channel/marketing ROAS memory; external/regulatory signals; active outcome→confidence learning.

## Already fixed — don't re-flag

Product performance · margin/COGS · returns-by-SKU · customer memory · inventory velocity · YoY/trend/seasonality · geo-revenue · channel split · currency normalization · gap-driven open questions · recommendation-engagement capture · the post-onboarding correction surface · generator structured-value grounding + graceful degrade · conversation input-limit mitigation. All shipped 2026-07-29; see `CHANGELOG.md`.
