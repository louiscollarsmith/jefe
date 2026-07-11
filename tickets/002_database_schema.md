# Ticket 002 — Database schema and migrations

## Goal

Add the first Postgres schema and migration setup.

## Context

The app needs an event-first data model so every meaningful Shopify event, recommendation, approval, execution and feedback item can be traced and replayed.

Read:
- AGENTS.md
- docs/context/03_architecture.md
- docs/context/06_security_and_data.md

## Requirements

Create migration setup and initial tables for:
- merchants
- shops
- ledger_events
- products
- variants
- orders
- order_line_items
- inventory_levels
- actions
- executions
- feedback
- provenance_links

## Architecture notes

- Postgres is the source of truth.
- The event ledger must be append-only by convention.
- Use tenant/merchant IDs consistently.
- Use idempotency/dedupe keys where relevant.
- Store raw external payloads in JSONB, but also normalise core fields needed for queries.
- Do not add pgvector yet unless required by another ticket.

## Acceptance criteria

- Migrations run locally.
- Schema is documented.
- Tests cover basic insert/read for core tables.
- No production credentials or secrets.
