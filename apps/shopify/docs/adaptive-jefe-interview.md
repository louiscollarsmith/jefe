# Adaptive Jefe Interview

The Jefe Interview is the merchant onboarding conversation that turns merchant-provided context into structured Merchant Memory. Shopify-derived memory says what happened; the interview captures what matters, what the merchant wants, and what Jefe should avoid.

## State Model

The interview uses dedicated tables:

- `merchant_interviews` tracks status, readiness, current topic and current question.
- `merchant_interview_topics` tracks controlled topic coverage such as business description, primary customer, goal, optimisation priority, acquisition channel, operational problem and recommendation restrictions.
- `merchant_interview_turns` stores merchant-visible questions, answers, structured interpretation, commit status and related belief ids.

The interview can be `in_progress`, `paused`, `completed`, `skipped` or `failed`. Page reloads restore the pending turn instead of restarting.

## Topic And Belief Registries

Topics live in `app/lib/merchant-memory/interview-registry.server.js`. Each topic points at one registered Merchant Memory belief key, a default question, answer suggestions, priority and readiness weight.

Merchant-created belief definitions live in `app/lib/merchant-memory/conversational-belief-registry.server.js`. The LLM may only propose those keys. The application rejects unsupported keys, non-merchant-creatable beliefs, invalid values and likely customer PII.

To add a topic:

1. Add or confirm a merchant-creatable belief definition.
2. Add a topic entry with a stable `topicKey`, `beliefKey`, question, priority and weight.
3. Add deterministic extraction or a mocked LLM test for the expected answer shape.

## Question Selection

Question selection is controlled by application code:

Merchant Memory + interview topic state + readiness coverage + priority rules = next question.

The LLM can interpret answers and suggest a next topic, but it does not create the agenda. A topic already covered by active Merchant Memory is marked answered and skipped.

## Structured Interpretation

The LLM returns strict JSON with:

- `answer_status`
- `candidate_beliefs`
- `covered_topics`
- `needs_clarification`
- `clarification_question`
- `merchant_visible_acknowledgement`
- `suggested_next_topic`

Each candidate belief includes `belief_key`, `value`, `value_type`, `merchant_statement_summary` and `confidence`. The application validates every candidate before writing.

If the LLM is disabled, times out or returns invalid structure, deterministic fallback interpretation is used.

## Commit Flow

Validated beliefs are committed through `upsertMerchantSuppliedBelief`, not by the LLM. Evidence is recorded with `source_type: merchant_interview` and references the interview turn. Belief history is recorded by the existing Merchant Memory service.

Observed facts remain separate from merchant policy. For example, if Shopify says two variants are out of stock and the merchant says preorder products are still available, Jefe keeps the observed stock belief and stores `policies.preorder_zero_inventory_available = true`.

## Readiness

Readiness is deterministic and testable. The MVP weights are:

- Business description: 20
- Primary customer: 15
- Primary business goal: 20
- Optimisation priority: 15
- Primary acquisition channel: 10
- Operational problem: 10
- Recommendations to avoid: 10

The completion threshold is 75. Declined, unknown and not-applicable answers count as partial coverage so the merchant is not trapped by one question.

## Privacy

The LLM prompt includes active aggregate beliefs, registered topic definitions and recent interview turn summaries. It does not include raw orders, customer emails, phone numbers, postal addresses or raw Shopify payloads. Application logs use safe identifiers and counts, not full merchant answers.

## Worked Examples

Multi-topic answer:

Merchant: "We sell premium handmade candles, mostly bought as gifts by women in their thirties through Instagram."

Result:

- `business.description`
- `business.market_positioning = premium`
- `customers.primary_customer_type`
- `customers.primary_purchase_reason = gifting`
- `marketing.primary_acquisition_channel = Instagram`

Covered later topics are skipped.

Policy instead of fact correction:

Merchant: "Those products are not really out of stock because we sell them on preorder."

Result:

- Keep `inventory.out_of_stock_variant_count` unchanged.
- Create `policies.preorder_zero_inventory_available = true`.
