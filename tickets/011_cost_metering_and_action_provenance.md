# Ticket 011 — Cost metering and action provenance

## Goal

Track per-merchant model and infrastructure costs and expose provenance for every recommendation.

## Context

Founder notes require per-client cost metering from day one. Trust requires action log with full provenance.

Read:
- docs/context/05_architecture_and_data_model.md
- docs/context/15_company_money_metrics.md

## Requirements

- Track model calls by merchant.
- Track approximate token/model cost.
- Track job/connector execution count.
- Add provenance links from action to:
  - ledger events
  - feature snapshot
  - prompt/tool trace placeholder
  - approval
  - execution
  - outcome
- Add internal view/report.

## Acceptance criteria

- Can see rough cost per merchant.
- Every action card has provenance data.
- Tests cover provenance creation.
