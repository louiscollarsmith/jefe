# Merchant Memory — Current State & Gaps

> **What this is.** An honest, dated map of what Merchant Memory knows today, what it does not yet, and what real merchant demand says to build next. It complements the principle-level docs (`merchant-memory.md`, `store-understanding.md`, `conversational-merchant-memory.md`, `merchant_memory_data_model.md`) — those describe *how it works*; this describes *how good it is and where to push*.
>
> **Sources.** A four-pass code audit (memory core · generators · ingestion/evidence · correction/learn loop) cross-referenced with `CHANGELOG.md` and `docs/ops/backend_code_review_2026-07-28.md`, plus a demand signal pulled from an ~800-member e-commerce operators Slack channel. Dated **2026-07-28**. Keep it current as items ship.

## The frame

The product loop is **Understand → Recommend → (Execute) → Observe → Learn**. Execute (external writes) is deliberately out of scope — Jefe is advisory. Mapping the audit onto the loop:

- **Understand — plumbing:** strong. **Understand — content:** thin on the axes merchants actually think in.
- **Recommend:** strong and grounded.
- **Observe → Learn:** systematically missing / passive.

The frontier has moved from *go-live hardening* (largely shipped — see the code-review status header) to **memory fidelity + closing the learn loop**.

## What's solid — keep, don't rebuild

- **Relational, versioned, provenanced belief store** — beliefs / evidence / append-only history / refresh-runs, atomic version bumps (atomicity shipped 2026-07-28).
- **Deterministic-vs-inferred boundary is exemplary** — numeric facts computed in app code; the LLM store-understanding schema has *no number field*, persists at lower precedence, and cannot overwrite deterministic beliefs. Inference can't masquerade as fact at the persistence layer.
- **Merchant-correction precedence is coded and enforced at every write site**, not just prompted; tested.
- **Generators are genuinely grounded** — Insights/Goals/Plan citations validated against the prompt's belief allowlist; numeric claims traced to belief *values* (hardened 2026-07-27).
- **Airtight multi-tenancy; disciplined ingestion** — append-only ledger + dedupe, idempotent upserts, throttle backoff, durable job queue with atomic claim.

## Supply-side gaps (from the audit)

1. **No product-level performance memory.** Every order line is ingested and indexed (`OrderLineItem.productId`), yet *zero* per-product beliefs exist — no revenue-by-product, bestsellers, product mix, or momentum. The raw material is in hand; it is simply un-derived. **This is the single biggest fidelity gap.**
2. **No margin / COGS.** Unit cost is never fetched; "margin" survives only as an LLM keyword in prompts. Profit truth is impossible without an ingestion change.
3. **Returns-by-SKU blocked.** Refund *amount* is modeled but refund line items aren't fetched → can't attribute returns to products/reasons.
4. **Post-onboarding correction loop is built but unwired.** `correctBelief` / `sendConversationMessage` is real, tested and precedence-safe, but reachable only inside onboarding. The post-onboarding Memory view is read-only and its "chat" composer is a decorative element. The mechanism for the north star runs exactly once.
5. **No recommendation-outcome capture.** `MerchantPlanRecommendation.completedAt` / `successSignal` are never written or measured. Recommend-and-forget; nothing flows back into memory. (Bounded by Execute being out of scope.)
6. **Memory can't find its own gaps.** Open-question generation is 2 static seeds — no gap-detection from low-confidence / missing / contradictory beliefs.
7. **Single-market / single-currency assumption.** Currency is GBP-defaulted; order country is fetched but not modeled; markets/languages/locations are not first-class memory dimensions.

## Demand-side signal (operator Slack channel, ~800 members)

Ranked by recurrence × centrality to "how my business works" (noise excluded: dev sourcing, backups, payout timing, generic app discovery):

| # | What operators keep raising | Memory needed | Jefe today |
|---|---|---|---|
| 1 | **Multi-market / geo / currency / language / location** (Markets consolidation, Klaviyo multi-geo, multi-location back-in-stock, translation, localized-market SEO, Bol.com) | Markets, currencies, languages, locations as first-class dimensions; performance *per market* | ❌ single-shop, GBP-defaulted, country un-modeled |
| 2 | **Product & attribute performance** (PDP model-imagery ROI; analyse sales by category/model, collection/model) | Per-product revenue/velocity sliced by attribute | ❌ no per-product performance (gap #1); no attribute slicing |
| 3 | **Inventory velocity / stock buys / reorder** (Inventory Planner; multi-location back-in-stock) | Sell-through velocity, days-of-cover, reorder points per variant/location | ⚠️ raw inventory + staleness only |
| 4 | **Returns/refunds & order anomalies** (refunds polluting attribution; duplicate orders) | Returns by SKU/reason; anomaly detection | ⚠️ refund amount only; guards exist but unsurfaced |
| 5 | **Marketing/channel performance** (Reddit vs Meta; server-side tracking; Klaviyo) | Channel / spend / ROAS memory | ❌ none; needs non-Shopify connectors → longer horizon |

Plus **regulatory churn** (EU withdrawal button, BNPL law, accessibility) → an "external signals / seasonality" horizon, not core memory.

**Read:** the channel skews established, multi-market brands. Demand *validates* the audit (product performance, returns) and *adds* two things above product-alone: **geo/market/currency** as a foundational dimension, and **inventory velocity**.

## Recommended build order

**Spine, either ICP:** derive **product-level performance memory** — deterministic, additive, data already in hand, no LLM/no external writes, unit-testable on plain `node`. Biggest recognizability win; compounds into every downstream surface (Insights/Goals/Plan/Memory view). *(Pending founder ICP steer — see below.)*

- **If ICP = multi-market established brands** (the channel's read): product **× market × attribute** performance, with **geo/market/currency** promoted to first-class memory dimensions → then **inventory velocity / reorder** → then **returns-by-SKU** (needs a refund-line-item ingestion change) → then wire the **live confirm/correct surface** (with the onboarding session, which owns `app._index.tsx`).
- **If ICP = single-market DTC first:** product **× attribute** performance is #1; **geo/market** a fast-follow; **inventory velocity** #2; **live correction surface** #3.

**Deferred (need connectors or Execute):** channel/marketing ROAS memory (Meta/Google/Klaviyo); external/regulatory signals; recommendation-outcome capture (matures once Execute exists).

## Already fixed — don't re-flag

GDPR/compliance webhooks · line-item total · numeric grounding · memory-write atomicity · belief staleness (partial) · Insights/Goals input bounding. All shipped since the 2026-07-27 doc freeze; see `CHANGELOG.md` and the status header in `docs/ops/backend_code_review_2026-07-28.md`.
