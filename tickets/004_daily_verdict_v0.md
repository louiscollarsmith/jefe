# Ticket 004 — Daily Verdict v0

## Goal

Generate the first read-only Daily Verdict from synced Shopify data.

## Context

Daily Verdict is the first habit-forming product surface. It should produce a plain-English conclusion, not a dashboard.

Read:
- AGENTS.md
- docs/context/00_north_star.md
- docs/context/02_mvp_plan.md
- docs/context/03_architecture.md

## Requirements

For each merchant, calculate:
- revenue by SKU
- units sold by SKU
- refunds by SKU where possible
- estimated gross margin where COGS exists
- missing COGS warnings
- top winners
- top losers
- products needing attention

Generate action-card style outputs:
- title
- money at stake
- evidence
- confidence
- suggested next step

## Notes

Rules/SQL first. LLM can be used later to explain the verdict in plain English, but the underlying calculations must be deterministic.

## Acceptance criteria

- Can run locally against seed data.
- Produces stable output.
- Tests cover calculations.
- No external write actions.
