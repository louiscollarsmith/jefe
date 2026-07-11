# Ticket 006 — Inventory Guardian v0

## Goal

Generate stockout and reorder warnings from sales velocity and inventory.

## Context

Inventory Guardian is a clear merchant-value surface: stockouts lose sales, dead stock traps cash.

Read:
- docs/context/03_mvp_scope_and_modules.md
- docs/context/05_architecture_and_data_model.md

## Requirements

For each SKU/variant:
- calculate recent sales velocity
- calculate current inventory
- estimate days until stockout
- estimate revenue/margin at risk where possible
- produce reorder quantity suggestion
- create evidence links
- produce draft PO/email placeholder

## Acceptance criteria

- Handles missing inventory safely.
- Outputs confidence.
- Stores action/proposal records.
- UI card shows £ at risk, evidence and suggested action.
- Tests cover common cases.
