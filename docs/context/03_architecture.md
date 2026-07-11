# Architecture

## Recommended stack

Frontend:
- Shopify embedded app
- React
- TypeScript
- Shopify Polaris
- App Bridge

Backend:
- TypeScript / Node
- Postgres
- job queue
- typed connector gateway

Infrastructure:
- Cloud Run + Cloud SQL + Cloud Tasks + Secret Manager
- or AWS equivalent if preferred
- no Kubernetes initially
- no Redis initially unless proven necessary

AI:
- direct model calls with structured JSON first
- no fine-tuning initially
- no dedicated vector DB initially
- use cheap model for summaries/classification
- use stronger model for high-impact decision planning

Observability:
- OpenTelemetry
- LLM tracing later via LangSmith/Braintrust/HoneyHive

## Planes

1. Ingestion
   - Shopify OAuth
   - Admin GraphQL API
   - bulk syncs
   - webhooks
   - third-party read connectors

2. Canonical commerce model
   - merchants
   - products
   - variants
   - orders
   - customers
   - inventory
   - refunds
   - campaigns

3. Decisioning
   - feature builder
   - action generator
   - policy scorer
   - evidence builder

4. Execution
   - approval UI
   - typed connector adapters
   - idempotency keys
   - blast-radius caps
   - execution ledger

5. Evaluation
   - outcome events
   - holdouts
   - attribution
   - policy/ranking updates

## Core rule

The LLM never directly mutates external systems.

LLMs may propose action specs.
Typed deterministic code validates and executes approved action specs.
