# Merchant Memory

Merchant Memory is Jefe's structured understanding of a merchant's business. Raw Shopify records describe what happened; Merchant Memory records durable beliefs that affect what Jefe explains, asks, recommends or refuses to do.

The current implementation is Prisma-backed relational memory: beliefs, evidence, history and refresh runs. It does not yet use a separate JSON document/version table.

## Schema

`merchant_memory_beliefs` stores current and historical belief rows. Each belief has a stable semantic `key`, `category`, structured `value_json`, `value_type`, lifecycle `status`, confidence, observed/evaluated timestamps, precedence and optional derivation lineage.

Current statuses are:

- `inferred`
- `merchant_confirmed`
- `merchant_corrected`
- `superseded`
- `obsolete`

`merchant_memory_evidence` stores provenance separately from beliefs. Evidence references source type, source reference, evidence type, summary, metadata and observed timestamp. It records calculations and aggregate source counts rather than copying raw Shopify payloads or customer PII.

`merchant_memory_belief_history` records lifecycle and value changes so Jefe can explain how understanding changed over time.

`merchant_memory_refresh_runs` records memory build attempts, requested categories, result counts, failures, duration and deterministic derivation attempts. Each registry row finishes as `CALCULATED`, `INSUFFICIENT_DATA`, `NOT_APPLICABLE` or `BLOCKED_BY_MISSING_SOURCE`; only `CALCULATED` attempts publish active beliefs.

## Confidence

Confidence uses calibrated published bands: `0.98`, `0.95`, `0.90`, `0.85`, `0.80`, `0.70` and `0.60`. Confidence answers how likely the belief is to represent reality accurately. Sample size, freshness and completeness remain visible as quality inputs and evidence metadata rather than being treated as the belief itself.

Deterministic beliefs use named templates in `app/lib/merchant-memory/confidence-templates.server.js`, with per-belief template selection in `app/lib/merchant-memory/deterministic-confidence-registry.server.js`.

Do not add one confidence template per belief. Add a new template only when a reusable confidence family exists; otherwise add belief-specific thresholds as parameters in the central confidence registry.

## Precedence

The current precedence model is:

- House Rule or authoritative merchant instruction, future only: `100`
- Merchant correction: `80`
- Merchant confirmation: `60`
- Direct platform observation, reserved: `40`
- System inference: `20`
- LLM Store Understanding inference: lower than deterministic system inference

Deterministic recalculation does not silently overwrite `merchant_confirmed` or `merchant_corrected` beliefs. When recalculation proposes a value for an authoritative belief, Jefe records that the recalculation was skipped rather than replacing the merchant's statement.

## Deterministic Registry

Shopify derivations are driven by `app/lib/merchant-memory/deterministic-belief-registry.server.js`. Calculations live in `app/lib/merchant-memory/shopify-derivations.server.js`.

Each registered definition preserves the stable key, category, value type, calculation text, source dependencies, minimum-data rule, confidence rule, caveat, materialisation rule and LLM exposure. `internal_guardrail` beliefs are persisted only as data-quality signals and should not be presented as ordinary merchant knowledge.

Definitions that cannot be safely calculated do not create zero-valued active beliefs. They are recorded in the refresh-run result as suppressed derivation attempts with source counts, required sources, quality flags and a skipped outcome.

## Derivation Versioning

Deterministic belief versions use the persisted convention `<belief-key>@vN`, for example `orders.average_order_value.all_time@v1`. The belief key supplies identity; the suffix identifies the material derivation contract.

A derivation version must be bumped when the meaning or method of a belief changes materially: formula, included sources, analysis-window semantics, currency/refund handling, value shape, business meaning, confidence methodology or source-of-truth selection.

When a derived belief version changes, Jefe creates a new inferred row, marks the previous derived row `superseded`, sets `supersededAt` and links lineage. Merchant-authoritative beliefs are protected and must not be superseded by derived rows.

## Evidence Builders

Evidence construction uses `app/lib/merchant-memory/evidence-builders.server.js`. Every deterministic evidence item records source type, evidence type, summary, formula identifier, derivation version, analysis window, source record counts, calculated timestamp, coverage metadata and confidence provenance.

Evidence must remain specific enough to explain the belief without including customer names, emails, phone numbers, addresses or other PII.

## LLM And Onboarding Integration

Store Understanding can create lower-authority inferred beliefs from bounded Shopify summaries. Merchant Insights, generated Goals and generated Plan records use active Merchant Memory as their input and validate model output before persistence.

The current Merchant Memory conversation infrastructure is used by Goals coaching and planning-document context. A full post-onboarding memory chat UI is not currently shipped.

## Adding Or Changing A Belief

Add or update the registry definition, then update the deterministic calculation. The calculation must publish only when applicability and minimum-data rules are met.

Before changing an existing deterministic belief:

1. Decide whether the formula or business meaning changes.
2. If yes, bump the derivation version.
3. Update the machine-readable formula identifier.
4. Update tests and fixtures.
5. Confirm supersession behavior.
6. Confirm merchant-authoritative precedence.
7. Document migration or rollout implications.
8. Run parity tests for unaffected beliefs.
