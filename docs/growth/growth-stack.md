# Growth Stack — build vs. buy (Jefe chat 6 view)

> **Owner:** Jefe chat 6 · **Last updated:** 2026-07-29 · Companion to [growth-strategy.md](growth-strategy.md)
>
> Matt asked for a wide view on what tools we should use. This is that view. It's opinionated and stage-aware — we adopt tools when a stage's volume demands them, not before.

## The stance

**Buy the commodities; build only the connective tissue that is unique to Jefe.**

The unique tissue is the join between *commercial state* (who's a prospect/partner/customer) and *product signal* (did they install, onboard, and **activate** — confirm their Merchant Memory + accept a recommendation). No off-the-shelf tool has our product events, so that join is ours to build. Everything else — sending email, a lead board, BI charts — is a bought commodity we don't reinvent.

Two hard constraints shape every choice:
- **First-party source of truth.** Postgres/Neon holds the real data; external tools are views or mirrors, never the system of record (mirrors the analytics spec's "first-party first").
- **Deliverability firewall + PII discipline.** Growth outbound on its own subdomain; no merchant/customer PII pushed to third-party tools without review.

## The stack, by layer

| Layer | Now (0→10) | Later | Call |
|---|---|---|---|
| **CRM / pipeline** | First-party tracker in `apps/growth` (ICP triage + product-signal join). Optional Airtable/Notion *mirror* for a clickable board. | Attio if we outgrow a mirror; never HubSpot/Salesforce at this stage. | **Build** the join; **buy** the board UI only if wanted |
| **Transactional email** | Resend on `mynamejefe.com` (already live) | — | **Buy** (have it) |
| **Growth / lifecycle email** | Resend on separate subdomain (`hola.mynamejefe.com`, approved). Behavioral triggers off product events. | Segmentation, win-back sequences | **Buy** transport, **build** triggers |
| **1:1 sales outreach** | Matt's inbox + the tracker. Personal, warm, no cold-email tool. | Light sequencer at 10→100 *if* volume needs it (watch deliverability) | **Neither** yet — human |
| **Product analytics / funnel** | chat 3's first-party `ProductEvent` stream | PostHog layered for exploration (spec already notes this) | **Build** first-party; buy explorer later |
| **Attribution / BID dashboard** | The tracker's report + chat 3's analytics | Metabase on Neon (read-only) at 100→1k | **Build**/lightweight-buy later |
| **App Store optimization** | Manual listing + review-generation flow | ASO tooling at 100→1k | **Neither** yet |
| **Referral** | — | First-party referral loop at 100→1k (don't buy a referral SaaS early) | **Build** later |
| **Scheduling / follow-up nudges** | Existing scheduled-tasks/cron to remind Matt of partner follow-ups | — | **Buy** (have it) |

## Why not a real CRM yet

At ~10 partners, a HubSpot/Salesforce is cost + admin overhead for a spreadsheet's worth of rows, and it *still* couldn't answer the only question that matters — "which partners actually activated?" — because it doesn't hold our product events. We build the thin join now; if Matt wants to *work* leads in a nice UI, we mirror the tracker's output into Airtable/Notion (cheap, editable, no lock-in) while keeping Neon authoritative.

## Guardrails

- Keep the SaaS footprint small at this stage — every tool is a cost, an integration, and a place data leaks.
- Growth code lives in `apps/growth` / `docs/growth`, never in `apps/shopify`.
- Nothing external sends without Matt's explicit OK.

## Changelog

- **2026-07-29** — Created (chat 6). Initial build-vs-buy view; commercial tracker chosen as build, CRM SaaS deferred, mirror-to-Airtable offered as the UI option.
