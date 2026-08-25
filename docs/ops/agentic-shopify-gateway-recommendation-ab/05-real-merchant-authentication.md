# Part 5 — Real merchant authentication confirmation

## Timeline (all times UTC, 2026-08-25)

- **~12:55:43** — Confirmed a real, valid offline Shopify session for `jefe-local-store.myshopify.com`
  in the local dev Postgres: `Session.accessToken` present, 72 granted scopes, `expires:
  2026-08-25T13:08:39.254Z`.
- **~13:02:03** — Mid-task, re-checked before starting the real run: `prisma.session.count()` and
  `prisma.shop.count()` for this shop both returned **0**. The entire local dev database had been
  wiped — almost certainly by another parallel agent sharing this Postgres container (this repo's
  branch list includes many `wipe-local-db*`/`wipe-db*`/`drop-existing-data` branches, i.e. this is
  a known, recurring shared-environment hazard, not a one-off).
- Per the task's explicit instruction ("If authentication is genuinely unavailable, document the
  exact blocker and stop before claiming the A/B has been completed... do not fabricate a
  'real-store' result with a fake transport"), this was reported as a blocker and the session
  continued with non-Shopify-dependent work (safety tests, instrumentation code, schema-tool
  sizing) rather than substituting mocks.
- **User message, ~13:15** — "local db should be back now."
- **13:24:55** — First A/B run completed successfully against a real, restored session (before the
  `validateInvestigation` bug fix — see `15-remaining-limitations.md`).
- **13:27:02** — Re-verified session still valid (`expires: 2026-08-25T14:02:47.138Z`) before
  re-running.
- **13:33:24** — Second (post-fix) A/B run completed successfully. This is the run reported in
  `09-catalogue-baseline-trace.md` / `10-full-gateway-trace.md` / `11-ab-metrics.md`.

## What was actually used

Both runs called `runAgenticRecommendationInvestigation` (`recommendation-service.server.js`) —
the identical function the real merchant-facing Generate Proposal flow calls — with the real
`session.accessToken` and real `session.scope` read live from the `Session` table, constructing a
real `ShopifyAdminGraphqlClient` against `jefe-local-store.myshopify.com`. No mocked transport, no
synthetic Shopify responses, anywhere in either run. `scripts/eval-real-dev-shopify-recommendation-ab.mjs`
fails fast with a clear error (and writes nothing) if no usable session exists — verified directly
during the ~13:02 blocker window, where it never ran.
