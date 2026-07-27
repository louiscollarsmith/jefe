# Conversational Merchant Memory

The repo contains a structured Merchant Memory conversation service. In the current product, this infrastructure is used by the Goals step for merchant coaching and planning-document context. A full post-onboarding memory chat UI is dormant and should not be described as shipped.

## Flow

```text
Merchant message or planning document
  -> conversation service
  -> optional LLM structured operation
  -> deterministic validation
  -> Merchant Memory service
  -> conversation event and memory history
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

Not every service intent has current route/UI wiring.

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

## Persistence

Conversation tables:

- `merchant_memory_conversations`
- `merchant_memory_conversation_messages`
- `merchant_memory_open_questions`

Messages store merchant-visible content, structured operations, operation status, related belief IDs, related open question ID and safe summaries. They do not store hidden chain-of-thought.

Merchant-originated memory changes record evidence with `source_type = merchant_conversation` and a conversation/message reference in metadata. Belief history records the service-level change and preserves correction precedence so later deterministic refreshes do not silently overwrite merchant-authoritative beliefs.

## Testing

Use mocked or deterministic interpreter outputs. Core tests must not depend on live model calls or real API keys.

Run:

```bash
npm run typecheck
node --test tests/conversational-merchant-memory.test.mjs
```
