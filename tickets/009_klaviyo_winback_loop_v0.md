# Ticket 009 — Klaviyo winback loop v0

## Goal

Implement the first measured write loop using Klaviyo private keys for pilot stores.

## Context

Klaviyo winback is the clean first proof of incremental margin.

Read:
- docs/context/03_mvp_scope_and_modules.md
- docs/context/06_pilot_fast_path_and_integrations.md
- docs/context/07_ai_runtime_learning_and_holdouts.md
- docs/context/10_security_privacy_operational_reality.md

## Requirements

- Store merchant Klaviyo private key securely.
- Identify dormant customers from Shopify order history.
- Create/prepare Klaviyo segment or export list as appropriate.
- Assign randomised holdout.
- Create campaign draft.
- Stage send 10% → 90%.
- Enforce caps:
  - max segment size
  - max discount
  - cooldowns
  - send frequency
- Approval required in app.
- Record provenance on every step.
- Record holdout assignments.

## Acceptance criteria

- Works in test/pilot mode.
- No real campaign sends without explicit approval.
- Holdout assignment is stored.
- Blast-radius caps enforced.
- All external writes use typed adapter and idempotency keys.
