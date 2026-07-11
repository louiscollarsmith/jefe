# Ticket 003 — Shopify read connector v0

## Goal

Build the first Shopify read connector for products, variants, inventory and recent orders.

## Context

The MVP needs read-only Shopify data before any recommendations can be generated.

Read:
- AGENTS.md
- docs/context/02_mvp_plan.md
- docs/context/03_architecture.md
- docs/context/06_security_and_data.md

## Requirements

- Use Shopify Admin GraphQL API.
- Pull products and variants.
- Pull inventory levels where available.
- Pull recent orders and line items.
- Store raw sync events in ledger_events.
- Upsert normalised entities into canonical tables.
- Use typed adapter functions.
- Add rate-limit handling.
- Add retry-safe logic.
- Add tests with mocked Shopify responses.

## Out of scope

- Customer protected data unless needed for later winback ticket.
- read_all_orders.
- write scopes.
- product updates.
- billing.
