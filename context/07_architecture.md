# Architecture

Commerce systems → evidence → Merchant Memory → LLM inquiry → recommendations → actions → learning.

That one line is the whole system. The rest of this file is how it is actually built (reverse-engineered 2026-07 from `apps/shopify/app/lib/*`, which is the source of truth — keep this in sync when the shape changes).

## The spine

```
Shopify (Admin GraphQL + webhooks)
  → ingestion:   HMAC → append-only ledger → canonical commerce tables    [deterministic]
  → derivation:  belief registry → facts + evidence + confidence          [deterministic]
  → Merchant Memory: beliefs · evidence · history · open questions        [system of record]
  → LLM inference:   insights · goals · plan · store-understanding · chat  [proposes only, validated]
  → surfaces & comms: embedded app UI · Slack · email
  → merchant: reviews · confirms · corrects  ──(corrections outrank inference)──┐
        └─────────────────────────────────────────────────────────────────────┘
```

## Layers

- **Ingestion** (`lib/ingestion/shopify`, `lib/shopify`): HMAC-verified webhooks and paginated backfill write an append-only `ledger_events` source of truth, then upsert canonical commerce tables (products/variants/orders/line-items/refunds/inventory/customer-identity). Deterministic; read-only against Shopify.
- **Derivation** (`lib/merchant-memory/shopify-derivations`, `deterministic-belief-registry`): reads canonical tables, computes facts via a registry of belief definitions with calibrated confidence templates, emits belief + evidence rows. Coverage-/data-gated — never guesses; suppresses with diagnostics rather than publishing a misleading value.
- **Merchant Memory** (`lib/merchant-memory`): the product's core object. A belief = one `MerchantMemoryBelief` row keyed by a stable semantic key; provenance lives in separate evidence rows; changes are recorded in an append-only history table. Everything else reads and writes through it.
- **LLM inference** (`lib/llm`, plus `store-understanding`, `merchant-insights|goals|plan`): interprets a compact, privacy-safe belief snapshot into typed proposals — insights, goals, a plan recommendation, candidate beliefs, or a conversation operation. Never writes anywhere itself.
- **Surfaces & comms** (`app/routes/app._index.tsx`, `lib/channels`, `lib/email`): advisory output renders in the embedded app; Slack is a transport over the same conversation engine; email (Resend) is transactional only.

## Load-bearing invariants

What keeps the system correct — and what makes earned autonomy safe to grow into:

1. **The LLM proposes; application code validates and persists.** No LLM call site touches an external adapter. Proposals are validated deterministically: every cited belief id must be in the supplied snapshot (citation allowlist), every generated number must appear in a cited belief value (numeric grounding), plus banned-phrase filters and a 2-attempt validation retry. Deterministic math lives in code, never prompts.
2. **Merchant corrections outrank inference**, enforced at every write site via a numeric precedence ladder: llmInference 10 → systemInference 20 → directObservation 40 → merchantConfirmation 60 → merchantCorrection 80 → houseRule 100. Inference is never laundered into fact — provenance + confidence are always attached.
3. **History is append-only; memory versions rather than overwrites.** A belief row supersedes (new row + lineage) on a `derivationVersion` change; the history table is the audit trail.
4. **Idempotency throughout.** Ledger/canonical natural keys dedupe ingestion; generation runs are keyed by `(shop, snapshotHash, promptVersion, schemaVersion)`, so an unchanged snapshot reuses its run (free caching) and a new one supersedes the old.
5. **One unified job queue** (`BackfillJob`) drives both ingestion backfill and all LLM generation, drained by an in-process poll worker. (Scaling note: no separate worker service today — concurrency safety rests on a DB unique key + in-memory guards.)
6. **Observability by default** (`lib/observability`): structured logger with always-on redaction, a central error hook → Sentry + the activity log, correlation ids across jobs. Health: `/health` liveness, `/ready` readiness.
7. **External writes go only through typed adapters** — idempotency key, preview, approval gate, blast-radius cap, reversibility, merchant as principal. This is the permanent guardrail the autonomy ramp grows within (see `11_actions_and_autonomy.md`).

See also: `docs/ops/build-deploy-and-coordination.md` (how it is built and deployed) and `apps/shopify/docs/` (per-subsystem detail).
