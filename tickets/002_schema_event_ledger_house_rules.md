# Ticket 002 — Schema, event ledger, House Rules and goals

## Goal

Create the initial Postgres schema and migrations for the event-first architecture.

## Context

Every recommendation must be traceable to source data, rules consulted, approvals, execution and outcome. House Rules and goals are core product identity.

Read:
- AGENTS.md
- docs/context/02_house_rules_and_goals.md
- docs/context/05_architecture_and_data_model.md
- docs/context/10_security_privacy_operational_reality.md

## Requirements

Add migration setup and tables for:
- merchants
- shops
- merchant_users
- house_rules
- goals
- ledger_events
- products
- variants
- orders
- order_line_items
- refunds
- inventory_levels
- cogs_inputs
- daily_briefs
- actions
- executions
- feedback
- provenance_links
- holdout_assignments
- attribution_results
- connector_accounts
- cost_metering

## Notes

Actions must support:
- expected_value
- confidence
- risk_level
- evidence
- rules_consulted
- preview
- verification_class

Ledger must support:
- dedupe keys
- source system
- event type
- raw payload JSONB
- event timestamp
- merchant ID

## Acceptance criteria

- Migrations run locally.
- Schema documented.
- Basic insert/read tests for core tables.
- No production credentials.
- No unnecessary dependencies.
