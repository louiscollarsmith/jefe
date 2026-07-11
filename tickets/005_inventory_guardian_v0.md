# Ticket 005 — Inventory Guardian v0

## Goal

Generate stockout and reorder warnings from sales velocity and inventory levels.

## Context

Inventory Guardian is one of the clearest value surfaces. Stockouts lose sales and dead stock traps cash.

Read:
- AGENTS.md
- docs/context/02_mvp_plan.md
- docs/context/03_architecture.md

## Requirements

For each SKU/variant:
- calculate recent sales velocity
- calculate current stock
- estimate days until stockout
- estimate revenue/margin at risk where possible
- produce reorder recommendation placeholder
- produce PO/email draft placeholder

## Acceptance criteria

- Works from canonical order/inventory tables.
- Handles missing inventory safely.
- Outputs confidence level.
- Tests cover common edge cases.
