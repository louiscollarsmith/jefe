# 05 — Architecture and Data Model

## Architecture planes

### 1. Ingestion

Purpose:
- capture Shopify and third-party events
- reconcile canonical state

Implementation:
- HMAC-verified webhooks
- bulk sync jobs
- connector pulls
- dedupe keys
- queues

### 2. Canonical state

Purpose:
- normalise products, variants, orders, customers, inventory, campaigns, tickets, goals and House Rules

Implementation:
- Postgres tables
- materialised views
- JSONB for connector payloads

### 3. Decisioning

Purpose:
- generate and score candidate actions by expected value, confidence, risk, merchant policy and House Rules

Implementation:
- rules
- features
- LLM explanations
- ranking/calibration model later

### 4. Execution

Purpose:
- carry out approved actions safely

Implementation:
- typed adapters
- idempotency keys
- dry-run previews
- approval gates
- blast-radius caps

### 5. Evaluation

Purpose:
- attribute outcomes and improve policy

Implementation:
- ledger reconstruction
- holdouts
- pooled attribution
- batch retraining

## Event-first flow

Every meaningful item becomes an immutable ledger event:

- external event
- data backfill
- recommendation
- evidence snapshot
- House Rules consulted
- approval
- execution step
- external API call
- feedback
- outcome
- attribution result

This enables point-in-time rebuilds:
- what data existed when an action was proposed
- what the model/tool chain did
- what the merchant approved
- what happened afterwards

## Core tables

MVP tables:
- `merchants`
- `shops`
- `merchant_users`
- `house_rules`
- `goals`
- `ledger_events`
- `products`
- `variants`
- `orders`
- `order_line_items`
- `refunds`
- `inventory_levels`
- `cogs_inputs`
- `daily_briefs`
- `actions`
- `executions`
- `feedback`
- `provenance_links`
- `holdout_assignments`
- `attribution_results`
- `connector_accounts`
- `cost_metering`

## Important fields on actions

- `expected_value`
- `confidence`
- `risk_level`
- `evidence`
- `rules_consulted`
- `preview`
- `verification_class`

## API field meanings

### expected_value

Conservative low/high estimate, in incremental gross margin where possible, not revenue.

### confidence

How strong the evidence is, not how confident the model sounds.

### risk_level

Blast-radius category; drives approval friction and whether approval is mandatory.

### evidence

Concrete facts with source event IDs and connector references.

### rules_consulted

Which House Rules constrained or shaped this proposal, citable in the UI.

### preview

Draft campaign, PO, segment, diff or other reviewable artefact.

### verification_class

`verified` for holdout-measured results.
`estimated` for counterfactuals.

Never blend these in totals.
