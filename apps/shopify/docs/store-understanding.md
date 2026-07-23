# Store Understanding Pass

Store Understanding is the cautious LLM pass that runs after deterministic Merchant Memory has been rebuilt and before the first adaptive Jefe Interview starts. Its job is to form a provisional business-context interpretation from stored Shopify evidence so the interview can confirm, correct and complete Jefe's understanding instead of starting from a blank slate.

## Deterministic facts vs LLM inferences

Deterministic Merchant Memory is calculated by application code from stored Shopify records. Examples include product counts, average order value, repeat customer rate and inventory counts.

Store Understanding creates lower-authority `inferred` beliefs with `derivation_version = store-understanding-v1`, `source_type = llm_store_analysis` and `evidence_type = model_inference`. These beliefs never overwrite merchant-confirmed or merchant-corrected beliefs, and their precedence is lower than deterministic observations.

## Input-summary construction

`buildStoreUnderstandingSummary` builds a bounded, privacy-safe JSON summary from existing stored data:

- deterministic active Merchant Memory beliefs;
- store and shop names;
- product, variant, order, refund, customer and inventory aggregate metrics;
- sampled product titles, product types, vendors, tags, short description excerpts and variant names/prices;
- top products by units ordered.

The summary excludes customer names, emails, phone numbers, addresses, raw order payloads and raw customer records. Product and variant samples are deterministically capped so prompt input remains bounded.

## Inference registry

The model can only return keys registered in `store-understanding-registry.server.js`. Each entry defines category, value type, allowed enum values where applicable, minimum evidence, confidence ceiling, merchant confirmability/correctability and interview topic mapping.

Initial registered inferences include business description/category/catalogue strategy/business model, likely primary customer type, customer purchase pattern, catalogue assortment character and apparent brand positioning.

To add an inference type:

1. Add a registry entry with a clear evidence requirement and confidence ceiling.
2. Add or update tests for value validation, confidence capping and interview mapping.
3. Ensure the key does not conflict with deterministic observed facts unless the precedence behaviour is explicitly intended.

## Structured output

The LLM response must match `STORE_UNDERSTANDING_OUTPUT_SCHEMA`:

- `storeSummary`
- `candidateBeliefs`
- `uncertainties`
- `suggestedInterviewConfirmations`

The app validates the response again after model output. Unsupported keys, malformed values, missing evidence, PII-looking values and candidates without enough source evidence are rejected.

## Confidence

Model confidence is not trusted directly. The app caps confidence by:

- the registry confidence ceiling;
- minimum product/order evidence;
- dataset size and completeness;
- customer/order evidence availability for customer-oriented inferences.

Low-confidence accepted beliefs can exist as provisional context, but interview readiness gives them little or no credit.

## Evidence and provenance

Accepted beliefs store evidence with:

- provider and model;
- prompt/input versions;
- deterministic source-summary hash;
- safe supporting evidence summaries;
- analysis timestamp;
- model confidence, confidence ceiling and final confidence.

The app does not store hidden chain-of-thought or unrestricted model reasoning.

## Precedence

Store Understanding inferences use `BELIEF_PRECEDENCE.llmInference`, below deterministic system inference, direct observations, merchant confirmation, merchant correction and House Rules. Merchant-authoritative beliefs are skipped during Store Understanding writes. Older Store Understanding inferences can be updated or obsoleted on rerun.

## Refresh and idempotency

Each run is recorded in `store_understanding_runs` with status, trigger, input summary version/hash, model, candidate/accepted/rejected/obsolete counts, duration and error summary. Unchanged completed or model-disabled input summaries are skipped unless the caller forces a retry.

Reruns update active Store Understanding beliefs when values change, preserve one active row per key, and obsolete older Store Understanding inferences that are no longer supported.

## Interview integration

The adaptive interview maps Store Understanding beliefs into topic coverage:

- merchant-confirmed/corrected: full coverage;
- high-confidence LLM inference: provisional coverage and confirmation wording;
- medium-confidence LLM inference: confirmation-needed coverage and correction-friendly wording;
- low-confidence or unknown: the LLM question planner can ask an open-ended question from the allowed topic set.

The first interview acknowledgement uses accepted inferences when available and explicitly frames them as Jefe's interpretation. Merchant confirmation upgrades the belief to merchant-confirmed. Merchant correction stores merchant-authoritative context through the existing interview memory path where the key is merchant-correctable.

## Fallback behaviour

If Store Understanding is disabled or unavailable, it records a safe run state and onboarding continues. The interview question planner still needs an enabled LLM to create merchant-facing questions; Jefe does not fall back to deterministic registry questions.

## Privacy boundaries

Store Understanding is server-side only. It sends bounded catalogue and aggregate commerce summaries to the model, not raw customer records or raw order payloads. General logs record run metadata and usage, not full prompts or full model responses.

## Testing

Use mocked LLM providers in tests. Tests should cover accepted persistence, unsupported key rejection, invalid value rejection, confidence ceilings, authoritative-belief protection, idempotent reruns, obsolescence, disabled fallback, bounded/no-PII input summaries and interview confirmation behaviour.
