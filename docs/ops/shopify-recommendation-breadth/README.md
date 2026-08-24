# Raw artifacts — Shopify recommendation breadth validation (Task 3, 2026-08-24)

See `docs/shopify-recommendation-breadth-validation.md` for the full report.

- `eval-rerun-attempt-1-rate-limited.log`, `eval-rerun-attempt-3-rate-limited.log` — two of the
  three genuine live-eval rerun attempts against the real dev merchant this session, both
  exhausting the full retry budget on a sustained OpenAI 429. Referenced in the report's §12.
- The AFTER-baseline analysis in the report's §4 reclassifies the pre-existing capture at
  `docs/ops/eval-full-capability-recommendation/eval-2026-08-24T19-40-03-190Z.json` (also
  `latest.json` in that directory) using this session's new disposition taxonomy — that capture
  is the authoritative real-merchant AFTER run and is not duplicated here.
- Controlled fixture results are reproducible directly: `node --test
  apps/shopify/tests/recommendation-domain-fixtures.test.mjs
  apps/shopify/tests/recommendation-domain-competition.test.mjs
  apps/shopify/tests/recommendation-sequential-exhaustion.test.mjs` (no DB, no live LLM, no
  network — deterministic, from `apps/shopify`).
