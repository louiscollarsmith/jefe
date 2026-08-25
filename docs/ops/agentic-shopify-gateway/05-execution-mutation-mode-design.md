# Part 5 — Execution/mutation-mode design

## Tools available

`shopify_schema`, `shopify_query`, `shopify_prepare_mutation`, `shopify_execute_mutation` — all
four. Mutation execution still requires everything Part 5 of the task brief named as non-negotiable:
an accepted Action revision, live scope authorization, blast-radius, explicit high-risk confirmation
where required, idempotency, and a durable receipt. None of that is new code — see
`02-architecture-decision.md` for why it's the same `executeShopifyOperation()` the catalogue surface
already uses.

## `shopify_prepare_mutation` — validate and classify without touching Shopify

`{ document, variables?, purpose?, expectedEffect? }`. Runs `analyzeGatewayDocument()` in
`GATEWAY_MODE.mutationOnly`, builds a synthetic stub, and computes `computeShopifyBlastRadius()` /
`buildGenericShopifyOperationPreview()` / `evaluateBlastRadiusCap()` — the exact same functions the
catalogue path's `executeShopifyOperation()` calls internally — but makes **no network call and
writes no ledger row**. Returns `safety`, `execution`, `blastRadius`, `blastRadiusWithinCap`,
`preview`, and `requiresExplicitConfirmation`. This is the tool an agent (or a merchant-facing
confirmation UI, in a later integration) uses to know *before* committing to execution whether a
write will need explicit confirmation and what it will visibly do.

Verified directly: preparing `productDelete` against a real product GID classifies it
`DESTRUCTIVE`/`IRREVERSIBLE`/`EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`, computes
`blastRadius.resourcesAffected: 1`, and produces the preview text `"gid://shopify/Product/1 will be
removed from Shopify."` / `"Irreversible: Shopify provides no direct undo for this operation."` —
identical in kind to what the catalogue path would produce for the same operation, because it's the
same preview function.

## `shopify_execute_mutation` — the real write

`{ document, variables?, purpose?, expectedEffect?, idempotencyKey }`. `idempotencyKey` is required
(the tool refuses the call otherwise, mirroring the catalogue surface's existing
`MISSING_IDEMPOTENCY_KEY` behaviour). Builds the same synthetic stub `shopify_prepare_mutation` would
have, then calls `executeShopifyOperation({ ...ctx, operation: stub.operation, stubOverride: stub,
... })`. From that point on, execution is byte-identical to the catalogue path: authorization,
blast-radius, confirmation, provider call, `userErrors` inspection, ledger write, all in
`gateway.server.js`, none of it duplicated in the gateway module.

## What's still missing for a full accept → execute → verify loop

The gateway's execution *primitive* is complete and tested. What isn't built this session is a
gateway-native replacement for `materializeAgenticShopifyAction()` /
`acceptAgenticShopifyAction()` / `runAgenticShopifyExecution()` (the semantic-Action lifecycle that
turns a recommendation into an accepted, revision-stamped Action before any mutation can run) — the
gateway's execute tool assumes an `actionId`/`acceptedActionRevision` are already present on `ctx`,
supplied by whatever orchestration wraps it, exactly like the catalogue tool does today. Wiring a
gateway-native recommend → accept → execute → verify loop is the largest remaining piece of work; see
`14-migration-rollback-strategy.md`.
