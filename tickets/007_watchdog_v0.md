# Ticket 007 — Watchdog v0

## Goal

Detect obvious silent breakages and anomalies from store data.

## Context

Watchdog builds insurance value and trust. One caught issue can justify the product.

Read:
- docs/context/03_mvp_scope_and_modules.md
- docs/context/05_architecture_and_data_model.md
- docs/context/07_ai_runtime_learning_and_holdouts.md

## Requirements

Detect v0 anomalies:
- refund spike
- return-rate outlier if data exists
- SKU sales collapse
- unusual stock movement
- product unavailable
- revenue drop versus recent baseline
- discount stacking if discount data exists
- ad set over CPA threshold later if ad data exists

Each alert includes:
- what changed
- why it matters
- evidence
- confidence
- estimated prevention label if value is counterfactual

## Acceptance criteria

- Runs against seed data.
- Produces clear alerts.
- Does not claim verified lift.
- Estimated prevention is separated from verified totals.
- Tests cover normal/anomalous cases.
