# Conversational Merchant Memory

The Jefe app page exposes Merchant Memory as a conversation, not a belief editor.
Merchants speak naturally; Jefe translates the message into a strict structured
operation, validates it, then calls Merchant Memory services.

## Flow

```text
Merchant message
  -> conversational interpreter
  -> structured operation
  -> deterministic validation
  -> Merchant Memory service
  -> conversation event and memory history
```

The interpreter is replaceable. The first live provider is Gemini through
`@google/genai`; deterministic interpretation remains the fallback and test
path. The LLM must never write directly to the database.

## Supported Intents

- Inspect memory, including category-level questions.
- Explain a belief using evidence summaries, formulas, source record counts and
  last evaluation time.
- Confirm an unambiguous belief.
- Correct supported merchant-correctable beliefs.
- Add supported merchant-provided business context.
- Answer one active open question.
- Reject a proposed change.
- Undo the latest eligible merchant-originated memory change.

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

Supported operation types:

- `confirm_belief`
- `correct_belief`
- `create_merchant_belief`
- `answer_open_question`
- `request_explanation`
- `no_memory_change`
- `clarification_required`

Unsupported operation types are rejected before any memory write.

## LLM Provider

The provider boundary lives in `app/lib/llm`. Conversation code asks for a
structured operation; provider-specific API details stay outside Merchant Memory
and conversation persistence.

Runtime configuration:

```bash
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.5-flash-lite
GEMINI_API_KEY=...
LLM_ENABLED=true
LLM_TIMEOUT_MS=8000
LLM_MAX_INPUT_TOKENS=6000
LLM_MAX_OUTPUT_TOKENS=900
LLM_MAX_RETRIES=1
```

`LLM_ENABLED=false` is the kill switch. If the LLM is disabled, unavailable,
times out, exceeds input limits or returns invalid structured output, Jefe falls
back to deterministic interpretation and still runs deterministic memory
validation before writing.

Gemini requests use:

- server-side API key only
- `responseMimeType = application/json`
- a structured response schema
- `maxOutputTokens`
- `AbortController` timeout
- bounded retries for timeout, rate-limit and transient server/network failures
- usage logging for provider, model, duration, attempts and token counts

Do not add Anthropic or OpenAI providers without a separate provider module and
without keeping this conversation/domain boundary intact.

## Validation

Validation checks:

- operation type is supported
- referenced belief belongs to the merchant
- belief key exists in the conversational registry
- category is allowed
- merchant create/correct/confirm is allowed for that belief
- proposed value matches the registered value type
- likely customer PII is not stored in business-level memory

Observed Shopify facts stay separate from merchant policy. For example, preorder
availability creates `policies.preorder_zero_inventory_available`; it does not
overwrite raw out-of-stock counts.

## Belief Registry

The registry lives in
`app/lib/merchant-memory/conversational-belief-registry.server.js`.

Each definition includes key, category, merchant-facing label, value type,
whether merchants can create/correct/confirm it, memory kind and mapping
guidance. Add a new conversational belief type there before teaching the
interpreter or future LLM prompt to emit it.

Initial merchant-created types include:

- `goals.primary_business_goal`
- `goals.current_priority`
- `business.primary_sales_channel`
- `business.business_model`
- `customers.primary_customer_type`
- `operations.fulfilment_model`
- `preferences.optimisation_priority`
- `policies.low_stock_threshold`
- `policies.preorder_zero_inventory_available`
- `policies.never_discount_products`

## Persistence

Conversation tables:

- `merchant_memory_conversations`
- `merchant_memory_conversation_messages`
- `merchant_memory_open_questions`

Messages store merchant-visible content, structured operations, operation status,
related belief IDs, related open question ID and short safe summaries. They do
not store hidden chain-of-thought.

Merchant-originated memory changes record evidence with
`source_type = merchant_conversation` and a conversation/message reference in
metadata. Belief history records the service-level change and preserves
correction precedence so later deterministic refreshes do not silently overwrite
merchant-authoritative beliefs.

## Confirmation Policy

Explicit, low-risk, unambiguous changes commit immediately.

Broad policies, unclear references, or multi-belief confirmations produce a
review card with Confirm update and Not quite actions. Rejected proposals do not
alter Merchant Memory.

## Testing

Use mocked or deterministic interpreter outputs. Core tests must not depend on
live model calls or real API keys.

Run:

```bash
npm run typecheck
node --test tests/conversational-merchant-memory.test.mjs
```
