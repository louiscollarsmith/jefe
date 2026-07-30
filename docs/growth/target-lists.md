# Target Lists — model, sizing & status

> **Owner:** Jefe chat 6 · **Last updated:** 2026-07-30 · Companion to [commercial-state.md](commercial-state.md) + [growth-strategy.md](growth-strategy.md)
>
> **PII note:** the *actual* email lists (names, addresses, per-brand contacts) live in the **session scratchpad** (`scratchpad/target-lists/`), bound for Airtable/a CRM — **never committed to this repo**. This doc holds only the PII-free model, counts, and status. Specific Quiver customer names are commercially sensitive and stay out of the repo too.

## The beachhead: Quiver's own customers

Jefe is **incubated inside Quiver** and first ships to **Quiver's existing e-commerce customers**, before spinning out as its own company. So the wedge is *warm, in-house relationships* — not cold outreach. This pulls the first-client timeline sharply forward.

Source of truth = the founder's Quiver Gmail, which is a de-facto CRM (labelled `Client/<Brand>` and `Client/<Brand>/Customer`):
- **212 Quiver customers** — paying, already in active conversation. The warm core.
- **2,486 total brand relationships** — the wider warm-ish prospect pool.

## Conversion-factor sizing model

Each stage's list is sized **backwards**: `prospects to reach = clients needed ÷ assumed conversion`. Warmer audience → higher conversion → smaller list needed.

| Stage | Clients | Assumed convert | Prospects to reach | Primary source |
|---|---|---|---|---|
| **1→10** | 10 | ~1 in 3 (warm customer, free) | ~30 | best-ICP Quiver customers |
| **10→100** | 90 | ~1 in 8 | ~720 | all 212 + top prospects |
| **100→1,000** | 900 | ~1 in 15 | ~13,500 | prospects + App Store + content + paid |
| **1,000→10,000** | 9,000 | ~1 in 30 | ~270,000 | multi-channel |

Factors are **assumptions to recalibrate** with real reply/convert data. The email history realistically powers **Stages 1–2**; 100→1k+ needs App Store + content + paid — email alone won't yield 13k+.

## The lists

- **Stage 1→10** — ~30 best ICP-fit Quiver customers (established DTC, single-store, **Shopify-verified**). A ~40-brand shortlist is under founder review (dead/changed brands being pruned). Shopify-verification running.
- **Stage 10→100** — all 212 customers (DTC-filtered) + the top prospects from the 2,486 (ranked by engagement).
- **Stage 100→1,000+** — prospect pool + App Store + content + paid.

## Status (2026-07-30, overnight) — lists assembled

- **Contact sweep:** done, 212/212. Email found for 210. Quality: **88 genuine brand-domain contacts**, 90 freemail (likely consumer/personal), 32 other-corporate, 2 none.
- **Shopify-verify:** done, 38/40 (dropped **Chilli No 5** = WooCommerce, **Cefinn** = store permanently closed).
- **Lists assembled** (scratchpad, PII out of repo): `stage1-10-targets.csv` — 38 verified-Shopify brands, **18 with a ready brand contact, ~20 needing an operator-contact pass**; and `stage10-100-targets.csv` — 212, tiered by contact quality.
- **⚠️ Data-quality caveat:** the `Client/<Brand>/Customer` labels are largely the brands' *end-consumer* support threads, so many extracted emails are a brand's *customer*, not its operator. Usable brand contacts = the 88 domain-matched (and several of those are generic `hello@`/`support@` inboxes). The ~124 others need the operator email found (brand site / LinkedIn) — or, since these are the founder's *own Quiver customers*, supplied from his knowledge/CRM. A deeper mailbox pass (pageSize > 5) would also recover more.
- **⚠️ Consent/compliance:** contacts compiled from a support inbox = fine to *review*; **sending needs a lawful basis (GDPR) + explicit founder OK — never an automated follow-on**, and not to end-consumers. **Nothing was sent or drafted.**

## Changelog

- **2026-07-30** — Created. Quiver-incubation beachhead; 212 customers / 2,486 relationships surfaced from the Gmail CRM; conversion-factor model; lists being populated overnight (contact + Shopify sweeps running).
