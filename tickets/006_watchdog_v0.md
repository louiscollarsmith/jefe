# Ticket 006 — Watchdog v0

## Goal

Detect obvious operational anomalies from synced store data.

## Context

Watchdog creates insurance value: it catches issues before they cost the merchant money.

Read:
- AGENTS.md
- docs/context/02_mvp_plan.md
- docs/context/03_architecture.md

## Requirements

Detect initial anomalies:
- refund spike
- SKU sales collapse
- unusual stock movement
- product suddenly unavailable
- revenue drop versus recent baseline

Each alert should include:
- what changed
- why it matters
- evidence
- confidence
- suggested next step

## Acceptance criteria

- Runs against seed data.
- Produces clear alerts.
- Tests cover normal and anomalous cases.
- No write actions.
