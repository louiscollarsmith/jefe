# Part 5 — Mutation safety model and partial-error handling

## Mutation safety classification — unchanged by this migration

`api/mutation-safety.server.js`'s `classifyShopifyOperationSafety({ operation, operationKind,
domain, scopeConfidence })` is a pure structural function — same code, same behavior, whether it's
fed values resolved from a catalog stub (old path) or inferred from a real agent-composed document
via `analyzeGatewayDocument`/`domain-taxonomy.server.js` (Gateway path). This migration did not
touch the classifier itself; it only changed how a stub reaches it. The classifier's own history
(superseded twice, both founder-authorized — see its file header and `CLAUDE.md`'s "Execution-
safety architecture authorization record") predates and is independent of this pass:

- No permanent per-operation deny-list. Every schema-valid mutation gets *some* execution path.
- Exactly one non-frictionless interaction tier: `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`. No
  named-operation allow/deny list anywhere — formerly-named operations (`appUninstall`,
  `appRevokeAccessScopes`, `customerCancelDataErasure`, etc.) classify through the same
  domain/name-shape structural rules as everything else, landing at that tier via the
  destructive-name pattern and the always-sensitive domain set, not a bespoke list.
- An unreviewed or unknown-scope-confidence mutation can never reach `AUTONOMOUS_ELIGIBLE` or plain
  `APPROVAL_REQUIRED` — risk changes the confirmation requirement, never whether Jefe has an
  execution path at all.

This migration's `tests/shopify-api-gateway.test.mjs` rewrite re-proves this classifier's real
behavior specifically *through the Gateway entry point* (real documents, real
`analyzeGatewayDocument`-inferred domain/scope, not catalog-stored values) — see Part 10.

## Partial GraphQL error handling (admin-graphql.server.js)

Added earlier in this branch's work (not new in this pass, but load-bearing for the Gateway):
`ShopifyAdminGraphqlClient.requestWithClassification(query, variables)` is a fully additive method
alongside the existing `request()` (untouched, still used by every other production caller).
Returns `{ classification, data, errors }` where `classification` is one of `FULL_SUCCESS`,
`PARTIAL_SUCCESS`, `AUTHORIZATION_PARTIAL`, `GRAPHQL_FAILURE` — so a field-level `ACCESS_DENIED` or
similar partial error doesn't discard `data` the response usefully returned alongside it.
`gateway/tools.server.js`'s `runValidatedQuery` uses `requestWithClassification` when the client
supports it, falling back to plain `request()` (treated as `FULL_SUCCESS`/`GRAPHQL_FAILURE` only)
for simpler client shapes — real production client, and most test fixtures. 8 dedicated tests in
`tests/agentic-shopify-gateway-partial-errors.test.mjs`.

## Real Shopify error detail — found and fixed via the live golden-path run

`api/gateway.server.js`'s provider-error catch block previously surfaced only
`ShopifyAdminGraphqlError`'s own `.message` — a generic `"Shopify GraphQL response errors"` — never
the real per-field `.errors` array detail. A real golden-path mutation attempt against
`jefe-local-store.myshopify.com` hit exactly this: the model's first `productUpdate` attempt used
the wrong argument name (`input` instead of the real `product`), and separately a `userErrors {
field message code }` selection failed because `UserError` has no `code` field — but the agent only
ever saw the opaque generic message, with no way to self-correct. Fixed with
`formatShopifyGatewayError(error)`: when `.errors` is a non-empty array, appends up to 5
`"{message} (at {path})"` fragments to the base message. Verified live: after the fix, the model's
first attempt got a clear local rejection ("productUpdate has no known argument 'input'. Known
arguments: product, media, identifier"), called `shopify_schema` to look up the correct shape,
corrected it, and the second attempt succeeded for real. Regression test in
`tests/agentic-shopify-gateway-execution-safety.test.mjs`.

## False WRITES_COMPLETE — found and fixed via the same live run

`execution-agent.server.js` computed `wroteToShopify` correctly but never gated the terminal
`WRITES_COMPLETE`/`OUTCOME_ACHIEVED` transition on it being `true`. Live evidence: a mutation
attempt failed (`PROVIDER_ERROR`), and the model claimed `WRITES_COMPLETE` on the very next turn
with zero successful writes this run. Fixed: before accepting either status, checks
`!wroteToShopify` and if true, pushes a `WRITES_COMPLETE_WITHOUT_SUCCESSFUL_WRITE` validation error
back to the model (with guidance to check the most recent mutation attempt's error and retry) and
loops instead of terminating. Regression test in
`tests/agentic-shopify-gateway-execution-safety.test.mjs`.

## Duplicate-read fingerprint bug — found while repairing the test suite, not the live run

`findExistingGatewayQuery`'s de-dup fingerprint compared the *current* turn's raw document text
against the *stored* row's `facts.document`, which is `graphql-js`'s `print(ast)` output — reformatted
with its own line breaks/indentation, and critically, `print()` renders an anonymous shorthand
`query { ... }` as bare `{ ... }`, dropping the keyword entirely. Two byte-identical repeats of the
same shorthand query therefore never fingerprinted as equal (raw side kept `query`, stored side
didn't). Fixed by canonicalizing *both* sides through the same `parse`+`print` round-trip before
fingerprinting, with a whitespace-collapse fallback if the current text fails to parse (e.g. a
malformed repeat attempt) — best-effort only, explicitly documented as not a safety property (a
byte-different document that queries the same field still runs and is correctly ledgered either
way; this only affects whether an identical repeat is short-circuited as `ALREADY_AVAILABLE` or
genuinely re-executed). Surfaced by `tests/recommendation-convergence.test.mjs`'s "Test D: identical
Shopify read is returned as ALREADY_AVAILABLE and not re-executed" once that test was migrated to
real gateway dispatch with a real (non-mocked) `graphql` print/parse round trip in the loop.
