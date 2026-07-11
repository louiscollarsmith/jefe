# Ticket 005 — Daily Verdict v0

## Goal

Generate the first Daily Verdict from real Shopify data.

## Context

Daily Verdict is the habit-forming manager surface. It must sell the conclusion, not the dashboard.

Read:
- docs/context/03_mvp_scope_and_modules.md
- docs/context/04_teardown_cogs_and_onboarding.md
- docs/context/05_architecture_and_data_model.md

## Requirements

For each merchant, calculate:
- revenue by SKU
- units sold by SKU
- refunds by SKU where available
- COGS where available
- estimated contribution margin
- missing COGS confidence ranges
- top winners
- top losers
- margin leaks
- products needing attention

Generate daily brief records with:
- title
- summary
- evidence
- expected value where relevant
- confidence
- verification class
- source event/provenance links

## Acceptance criteria

- Runs against seed/dev store data.
- Produces deterministic output.
- Shows confidence ranges when COGS missing.
- UI card shows evidence and plain-English conclusion.
- Tests cover calculations.
