# Conversational Merchant Memory

Jefe has one canonical conversation history and one bounded context contract
across Daily Home, Slack DMs, inbound AI email, Goals, Plan, explicit Memory
editing and action chat. Daily Home shows app general chats only (plus the labelled
pre-migration thread); other surfaces remain searchable without being mixed into
that visible list.

## Flow

```text
merchant-authored message
  -> canonical append + idempotency guard
  -> rebuildable episode + background indexing
  -> bounded MerchantContextPacket for the current task
  -> grounded reply OR explicit memory-operation interpreter
  -> deterministic validation before any durable belief change
```

The LLM interpreter is replaceable. The current live provider is Gemini through `@google/genai`; deterministic interpretation remains the fallback and test path. The LLM must never write directly to the database.

## Supported Service Intents

The service can interpret and validate:

- Inspect memory, including category-level questions.
- Explain a belief using evidence summaries, formulas, source record counts and last evaluation time.
- Confirm an unambiguous belief.
- Correct supported merchant-correctable beliefs.
- Add supported merchant-provided business context.
- Answer one active open question.
- Reject a proposed change.
- Undo the latest eligible merchant-originated memory change.

General chat never writes beliefs or external systems. It persists and returns its
own assistant reply so Slack and email never race on a global "latest reply" read.

## Structured Operation

Operations are stored on conversation messages as JSON:

```json
{
  "operationType": "correct_belief",
  "targetBeliefKey": "business.primary_currency",
  "targetBeliefId": "belief id when available",
  "category": "business",
  "proposedValue": { "currency": "EUR" },
  "valueType": "currency_code",
  "reason": "Merchant explicitly corrected the primary currency.",
  "merchantStatement": "Our primary currency is euros now.",
  "confidence": 0.92,
  "requiresConfirmation": false,
  "relatedOpenQuestionId": null
}
```

Unsupported operation types are rejected before any memory write.

## LLM Provider

The provider boundary lives in `app/lib/llm`. Conversation code asks for a structured operation; provider-specific API details stay outside Merchant Memory and conversation persistence.

Runtime configuration:

```bash
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.1-flash-lite
GEMINI_API_KEY=...
LLM_ENABLED=true
LLM_TIMEOUT_MS=8000
LLM_MAX_INPUT_TOKENS=6000
LLM_MAX_OUTPUT_TOKENS=900
LLM_MAX_RETRIES=1
```

`LLM_ENABLED=false` is the kill switch. If the LLM is disabled, unavailable, times out, exceeds input limits or returns invalid structured output, Jefe falls back to deterministic interpretation and still runs deterministic memory validation before writing.

## Validation

Validation checks:

- operation type is supported
- referenced belief belongs to the merchant
- belief key exists in the conversational registry
- category is allowed
- merchant create/correct/confirm is allowed for that belief
- proposed value matches the registered value type
- likely customer PII is not stored in business-level memory

Observed Shopify facts stay separate from merchant policy. For example, preorder availability creates policy memory; it does not overwrite raw out-of-stock counts.

## Persistence and authority

Authoritative tables remain:

- `merchant_memory_conversations`
- `merchant_memory_conversation_messages`
- `merchant_memory_open_questions`
- `merchant_memory_beliefs`, evidence, history and refresh runs
- `action_executions` and `action_execution_writes`
- `backfill_jobs`

Rebuildable derivatives are:

- `merchant_memory_episodes` for message and structured-summary search documents
- `merchant_memory_candidates` for passive-learning proposals and deterministic outcomes
- `merchant_context_retrieval_runs` for PII-safe selection diagnostics

Messages store merchant-visible content, structured operations, operation status, related belief IDs, related open question ID and safe summaries. They do not store hidden chain-of-thought.

Merchant-originated memory changes record evidence with `source_type = merchant_conversation` and a conversation/message reference in metadata. Belief history records the service-level change and preserves correction precedence so later deterministic refreshes do not silently overwrite merchant-authoritative beliefs.

## Retrieval contract

`retrieveMerchantContext` requires `merchantId`, `shopId` and a registered task.
It composes working, semantic, episodic, action, open-question and live-evidence
retrievers. Exact entity/action references, PostgreSQL full text, exact
tenant-filtered vector similarity, recency and adjacent messages are fused into a
deterministic bounded packet. Default chat packets are capped at 6,000 estimated
tokens; generation may request up to the hard 8,000-token cap.

Every selected item retains authority, confidence, temporal status, scope, source
IDs and score components. Diagnostics persist hashes, IDs, counts, timings and
selection components only—never the merchant's raw query or conversation text.
Normal requests exclude `historical_only` documents. Explicit history questions
may retrieve them and must label them historical.

## Episodes, summaries and embeddings

Messages remain canonical. A coalesced background job builds sanitised message
episodes, Gemini `gemini-embedding-2` vectors at 768 dimensions and structured
summaries after close or 30 minutes of inactivity. Summaries segment at 20
messages or 6,000 characters with one-message overlap and always retain exact
source message IDs. They are search aids, never evidence.

`EPISODIC_EMBEDDING_ENABLED=false` disables external embeddings. Failed or
disabled embedding calls leave PostgreSQL lexical retrieval available. Existing
messages are backfilled idempotently and are explicitly barred from retroactive
passive belief promotion.

## Passive durable learning

Only merchant-authored current messages are eligible. The extractor can propose
multiple registered operations; deterministic code verifies tenant, role,
registry key, value type, PII, allowed scope, temporal bounds, precedence and
retraction state. Unknown concepts stay episodic. Clear corrections replace
current truth while preserving the earlier source as historical. Ambiguous
contradictions open a question. Forgetting suppresses linked candidates and keeps
linked episodes out of normal retrieval.

Feature controls:

```bash
MERCHANT_CONTEXT_V2_ENABLED=true
MERCHANT_PASSIVE_MEMORY_ENABLED=true
EPISODIC_EMBEDDING_ENABLED=true
EPISODIC_EMBEDDING_MODEL=gemini-embedding-2
EPISODIC_EMBEDDING_TIMEOUT_MS=5000
```

## Testing

Use mocked or deterministic interpreter outputs. Core tests must not depend on live model calls or real API keys.

Run:

```bash
npm run typecheck
node --test tests/conversational-merchant-memory.test.mjs
node --test tests/holistic-merchant-memory.test.mjs
```
