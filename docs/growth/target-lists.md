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

## Status (overnight, 2026-07-30)

- Contact-email sweep over the 212 customers → running (background) → `scratchpad/target-lists/quiver-customer-contacts.csv`.
- Shopify-verification of the Stage 1→10 shortlist → running (background) → `scratchpad/target-lists/stage1-shopify-check.csv`.
- **No outreach drafted or sent** — per founder, lists only; sending is a separate go.

## Changelog

- **2026-07-30** — Created. Quiver-incubation beachhead; 212 customers / 2,486 relationships surfaced from the Gmail CRM; conversion-factor model; lists being populated overnight (contact + Shopify sweeps running).
