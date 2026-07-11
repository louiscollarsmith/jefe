# Ticket 003 — Shopify ingestion, bulk backfill and webhooks

## Goal

Implement Shopify read ingestion for products, variants, inventory, orders and refunds.

## Context

The MVP needs reliable read data before recommendations can be generated. The system must be event-first, HMAC-verified and deduped.

Read:
- AGENTS.md
- docs/context/05_architecture_and_data_model.md
- docs/context/06_pilot_fast_path_and_integrations.md
- docs/context/10_security_privacy_operational_reality.md

## Requirements

- Shopify OAuth/token handling.
- Admin GraphQL client.
- Bulk/backfill job for:
  - products
  - variants
  - inventory
  - orders
  - line items
  - refunds
- Webhook receiver for:
  - orders
  - refunds
  - products
  - inventory
  - app/uninstalled
  - compliance topics
- HMAC verification.
- Dedupe handling.
- Ledger event writes for all ingested data.
- Upsert canonical tables.
- Tests using mocked Shopify payloads.

## Out of scope

- customer protected data beyond what is required for MVP backfill
- write scopes
- Klaviyo
- recommendations
