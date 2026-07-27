# Merchant Memory Data Model

This document describes the current implementation, not a future target schema.

Merchant Memory is stored in Postgres through Prisma as queryable rows for beliefs, evidence, history, refresh runs, conversations, open questions, insight runs, goal runs and plan runs. The current app does not store a single versioned JSON memory document; the durable memory surface is built from these relational records.

## Core Records

| Record | Purpose |
| --- | --- |
| `merchants` | Business tenant. |
| `shops` | Connected Shopify store, onboarding state and backfill readiness. |
| `connector_accounts` | Durable connector account metadata and granted scopes. Shopify tokens remain in `Session`. |
| `ledger_events` | Source event ledger for backfill/webhook idempotency, raw source audit and provenance. |
| Commerce tables | Shopify products, variants, orders, line items, refunds, customer identities and inventory levels. |
| `merchant_memory_beliefs` | Current and historical structured memory statements with key, category, value, status, confidence, precedence and derivation version. |
| `merchant_memory_evidence` | Evidence/provenance for beliefs without copying raw Shopify payloads or customer PII into memory evidence. |
| `merchant_memory_belief_history` | Append-only history of value, status, correction, confirmation, supersession and obsolescence changes. |
| `merchant_memory_refresh_runs` | Deterministic memory rebuild attempts and diagnostics. |
| `store_understanding_runs` | LLM Store Understanding attempts, accepted inferences and safe failure states. |
| `merchant_memory_conversations` and messages | Conversation infrastructure used by Goals coaching and dormant generic memory-chat service code. |
| `merchant_memory_open_questions` | Explicit unresolved questions that can improve memory or recommendations. |
| `merchant_insight_runs` and findings | Bounded, validated insight generation from active Merchant Memory. |
| `merchant_goal_runs` and horizons | Generated 3-, 6- and 12-month objectives with merchant coaching/document context. |
| `merchant_plan_runs` and recommendations | One generated first move derived from memory, insights and goals. This is a recommendation record, not external execution. |
| Channel records | Slack and future WhatsApp connection state, encrypted credentials, OAuth/verification state and test-message delivery records. |

## Memory Lifecycle

Shopify evidence is imported from backfills and webhooks into canonical commerce tables and `ledger_events`.

Deterministic Merchant Memory rebuilds compute facts from canonical Shopify records. Calculated beliefs publish only when applicability and minimum-data rules are met. Skipped derivations are recorded on the refresh run rather than creating misleading zero-value beliefs.

Store Understanding runs after deterministic memory. It sends bounded, privacy-safe summaries to the configured LLM provider and can create lower-authority inferred beliefs. These inferences cannot overwrite merchant-confirmed or merchant-corrected memory.

Insights, Goals and Plan are generated from active Merchant Memory. Their outputs are validated against allowed IDs, grounded evidence and product rules before persistence.

Merchant corrections and confirmations create history and higher-precedence memory. Later deterministic refreshes must not silently overwrite merchant-authoritative rows.

## Status And Authority

Current belief statuses include:

- `inferred`
- `merchant_confirmed`
- `merchant_corrected`
- `superseded`
- `obsolete`

Precedence is intentionally explicit. Merchant corrections outrank merchant confirmations, which outrank system inference. Store Understanding model inferences have lower authority than deterministic and merchant-originated memory.

Never promote a model inference to fact just because it was generated confidently. The application controls persistence and status changes.

## Evidence And Privacy

Evidence records should identify source type, source reference, evidence type, summary, value metadata and observation/evaluation timestamps.

Evidence should be specific enough to explain a belief, but must not copy customer names, emails, phone numbers, addresses or other raw customer PII into memory evidence. Use aggregate customer evidence where possible.

## Recommendation And Action Boundary

The current Plan step persists one recommended first move. It can say what Jefe would start with and why, but it does not execute external changes.

Future external writes require typed adapters, idempotency keys, previews, merchant approval gates and blast-radius caps. Do not let an LLM write directly to Shopify, Slack, WhatsApp or any third-party system.

## Migration Policy

Keep Prisma migration history intact. Old migration names may mention retired Daily Brief, COGS, Klaviyo or action-safety work because they are historical deployment records. Do not edit, squash or delete migrations unless a founder explicitly approves a database reset.
