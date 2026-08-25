# Part 12 — Baseline comparison

## The baseline this was supposed to compare against doesn't exist, and the real one says something different

`docs/ops/recommendation-yield-forensics-2026-08-25/` — the directory the task brief named as the
"broken catalogue baseline" — does not exist in this repository. The real same-day diagnostic is
`apps/shopify/docs/proposal-generation-failure-2026-08-25.md`, and it explicitly rules out the
catalogue as the cause of the failure it investigated: a genuine OpenAI 429 exhaustion during
candidate discovery, before `retrieve_shopify_operations` was ever reached, with a same-day
comparable run on the *same* catalogue architecture succeeding normally (12 LLM calls, 58k–85k input
tokens/call). See `00-overview.md` for how this was surfaced to the founder before building anyway.

This means the comparison below is **not** "broken vs fixed." It's two working architectures,
compared on what's actually measurable from what exists.

| Metric | Catalogue (actual, from real repo data) | Agentic Gateway (this session) |
| --- | --: | --: |
| Model-visible Shopify tools | 2 (`retrieve_shopify_operations`, `call_shopify_operation`) | 4 (`shopify_schema`, `shopify_query`, `shopify_prepare_mutation`, `shopify_execute_mutation`) |
| Pre-generated operations | 810 | 0 — operations are classified on the fly from name+domain, never pre-generated |
| Useful Shopify reads (this session) | n/a (not re-run) | 0 live reads — blocked on missing `JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN`, not a gateway defect (`13-known-limitations.md`) |
| Schema discovery calls (real run) | n/a | 20 (`shopify_schema`) |
| GraphQL validation failures / repairs (real run) | n/a | 0 in the live run (first document was valid); repair mechanic proven separately by 20/20 adversarial unit tests |
| Candidates discovered / recommendation result | Real successful same-day run: 12 LLM calls → `no_actionable_opportunity` (a legitimate result after real investigation, per the diagnostic doc) | Not run — no gateway-native recommendation loop this session (`11-real-recommendation-run-trace.md`) |
| LLM calls (comparable unit: one investigation-shaped run) | 12 (real, successful same-day run) | 8 (real, this session's schema-discovery run — different task shape, not apples-to-apples) |
| Total input tokens (comparable run) | ~58k–85k **per call**, successful run (diagnostic doc §6) | 33,959 **total** across 8 calls this session |
| Max per-call input | ~69k (diagnostic doc range) | not separately tracked this session (aggregate only) |
| Runtime | not captured in the diagnostic doc | 25,458 ms (8 calls) |
| Code/generated-data maintenance burden | 810 generated stub entries; `npm run shopify:api:generate` required to add new operations | 0 generated per-operation entries; new Shopify operations get a real classification with zero code changes (proven: `agentic-shopify-gateway-safety.test.mjs`, "operation absent from the local catalog snapshot") |
| API-version migration work | Regenerate the 810-op catalogue (`shopify:api:generate`), review classifier diff | Regenerate/refresh the schema index from a fresh introspection (same generator, read-only reuse) — no per-operation classification work either way, because classification was already structural before this experiment (`02-architecture-decision.md`) |

## What this comparison can and can't tell you

**Can tell you:** the gateway's tool surface is smaller (4 vs 2 tool *names*, but 0 vs 810
pre-generated operation *documents*); the classification and execution-safety machinery is now
provably shared code, not a second implementation to keep in sync; a genuinely novel operation gets a
real, non-dead-end classification either way, because that property came from the 2026-08-25
execution-safety change, not from this experiment — the gateway's real contribution is proving that
same structural classification also works from a model-written document instead of a catalogue
lookup.

**Can't tell you, this session:** which architecture produces a *better recommendation* on real
Merchant Memory against a live store, because that requires (a) a live Shopify token, which wasn't
available, and (b) a gateway-native recommendation loop, which wasn't built (`14-migration-rollback-
strategy.md`). The maintenance-burden argument (810 generated entries vs 0) is real and verifiable
today; the recommendation-quality argument is not yet measurable.
