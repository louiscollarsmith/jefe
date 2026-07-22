# Merchant Memory Data Model

## Recommendation

Use a hybrid model.

Store Merchant Memory as versioned JSON document snapshots for review, rendering and reconstruction, while storing independently queryable relational records for evidence, claims, corrections, open questions and recommendation/action provenance.

This prevents prompt output from becoming the only source of truth and makes the important pieces queryable without forcing the entire memory into a rigid schema too early.

## Entities

| Entity | Purpose | First merchant? |
| --- | --- | --- |
| Merchant | Commercial account and business owner. | Required |
| Merchant integration/source | Connected commerce source such as Shopify/Klaviyo. Existing `shops` and `connector_accounts`. | Required |
| Source record/event | Raw and canonical external records. Existing `ledger_events` plus commerce tables. | Required |
| Deterministic fact/feature | Calculated sales, margin, inventory, repeat-rate and product metrics. Initially represented as evidence items and service payloads. | Required |
| Evidence item | Queryable fact or source-backed observation used by claims. | Required |
| Merchant memory document | Stable memory container for a merchant/shop. | Required |
| Merchant memory version | Immutable-ish version snapshot of the document. | Required |
| Memory section | Section key inside the versioned document and claims. | Required |
| Claim/belief | Atomic statement with status, confidence and provenance. | Required |
| Claim status | Distinguishes observed fact, merchant-confirmed fact, model inference, unresolved, rejected and superseded. | Required |
| Provenance | Links evidence/claims to ledger events, source records and calculations. | Required |
| Merchant correction/confirmation | Merchant-authored update that supersedes inference or confirms a claim. | Required |
| Open question | Unresolved information needed to improve memory. | Required |
| Recommendation | Proposed action/explanation generated from confirmed memory and evidence. Existing `actions` retained. | Later in pilot |
| Action provenance | Existing action/evidence/rules/execution records. | Later in pilot |

## Key Fields And Lifecycle

`merchant_memory_documents` hold `merchant_id`, optional `shop_id`, status, title, current version number/id and metadata.

`merchant_memory_versions` hold document id, version number, status, generation source, full `document_json`, source snapshot metadata and timestamps. A new version is created for initial synthesis, merchant correction, new evidence refresh or consistency repair.

`merchant_memory_claims` hold version id, section key, claim type, status, confidence, statement, structured value, evidence summary, supersession link and timestamps. Claims are never silently promoted: a model inference remains a model inference until a merchant correction/confirmation or deterministic observation changes its status.

`merchant_memory_evidence_items` hold deterministic or source-backed evidence with type, source table/record, ledger event link, summary, value JSON and observation/computation timestamps.

`merchant_memory_claim_evidence` links claims to evidence items and ledger events with relationship metadata.

`merchant_memory_corrections` hold merchant confirmations, corrections, rejections and answers. Corrections create a new memory version and may supersede earlier claims.

`merchant_memory_open_questions` hold section, prompt, reason, priority, status and answer/correction links.

## Answers To Explicit Questions

Should memory be relational, JSON, or hybrid? Hybrid. JSON versions keep the merchant-facing document coherent; relational claims/evidence/corrections keep truth and provenance queryable.

Which records must be queryable independently? Evidence items, claims, claim statuses, open questions, merchant corrections, memory versions and recommendations/actions.

How are claims connected to evidence? Through `merchant_memory_claim_evidence`, with optional direct ledger/source references on evidence items.

How is a merchant correction represented? As an append-only correction row with actor, correction type, original claim/version references, corrected content and status. It creates or contributes to a new memory version.

How do we prevent inference becoming fact? Status is explicit. `model_inference` can only become `merchant_confirmed_fact` through merchant action or `observed_fact` through deterministic source evidence. The application, not the LLM, controls persistence.

How do we rebuild memory from source evidence? Recompute deterministic features from canonical commerce records/ledger, regenerate evidence items, replay merchant corrections and create a new memory version. Older versions remain available.

What happens when deterministic facts change? Create new evidence items or mark previous evidence superseded in metadata, then create claims that supersede outdated claims. Do not mutate historical versions.

Minimum viable pilot schema: memory documents, versions, evidence items, claims, claim-evidence links, corrections and open questions. Existing `actions`, `provenance_links`, `ledger_events`, commerce tables, goals and House Rules remain in place.
