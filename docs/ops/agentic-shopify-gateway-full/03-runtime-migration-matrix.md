# Part 3 — Runtime migration matrix

| Layer | File | Before | After |
| --- | --- | --- | --- |
| Recommendation (candidate-scoped) | `recommendation-agent.server.js` | Gateway-gated behind `SHOPIFY_AGENT_SURFACE`, defaulted off (docs/ops/agentic-shopify-gateway-recommendation-ab/) | Unconditional. `discoveryToolName`/`readToolName`/`dispatchShopifyTool` hardcoded to the gateway tools; no branching on a surface flag. |
| Recommendation (open-ended, no `focusCandidate`) | `recommendation-agent.server.js` | Catalog-only; zero production callers | Migrated to Gateway too — kept working rather than left wired to a now-deleted dispatcher. Still zero production callers (`candidate-pipeline.server.js` always passes `focusCandidate`), but now directly unit-tested against real dispatch instead of being dead code with no test coverage of its actual behavior. |
| Execution | `execution-agent.server.js` | Catalog-only, unconditional; its own server-side capability-binding call (`retrieveShopifyApiOperations(..., { limit: 10 })`) fed every execution prompt | Gateway-only, unconditional. Binding call removed entirely — `initialTools` is always `[]`; the model calls `shopify_schema` itself only if it decides it needs to. |
| Verification | `verification-agent.server.js` | Catalog-only, unconditional; its own binding call (`retrieveShopifyApiOperations(..., { limit: 8, operationKind: "QUERY" })`) | Gateway-only, unconditional. Same binding-call removal. Structurally read-only regardless of prompt wording: only `shopify_schema`/`shopify_query` are ever offered, and `runShopifyGatewayTool` additionally hard-denies the mutation tools under `verificationMode` even if requested. |
| Chat | `action-chat.server.js` | Catalog-only (`retrieve_shopify_operations`/`call_shopify_operation`, both dispatched with `preAcceptanceMode`) | Gateway-only: `shopify_schema`/`shopify_query`, dispatched with `recommendationMode: true` — the *stronger* of the two available read-only guards (chat never has a path to the mutation tools at all; they aren't even recognized tool names, so an attempt fails as `UNKNOWN_TOOL` before reaching the gateway/ledger, not merely `DENIED_ACTION_NOT_ACCEPTED`). |

## What each agent's server-side capability-binding removal actually changed

Three call sites (recommendation `focusCandidate` mode, execution, verification) used to call
`retrieveShopifyApiOperations(query, { limit: N })` server-side, before the model's first turn, and
hand it the top-N ranked result as `initiallyRetrievedShopifyTools`/pre-seeded `toolResults`. This
was flagged in the earlier recommendation A/B as the root cause of a real false `NON_EXECUTABLE`
conclusion: `collectionCreate`/`collectionAddProducts` didn't rank into the top 8 for one real
candidate's wording, so the model never even saw them as options. All three binding calls are
removed, not migrated to a Gateway-equivalent ranked pre-fetch — Gateway mode has no pre-binding
step by design (the model calls `shopify_schema` itself, only when it decides it needs to). This
eliminates the failure class rather than reproducing it with different ranking weights.

## Normalization / turn-parsing changes

Every agent's turn normalizer (`normalizeRecommendationTurn`, `normalizeExecutionTurn`,
`normalizeVerificationTurn`) took a hardcoded default `allowedToolNames` (the two catalog tool
names) and picked between two lists at each call site depending on a surface flag. All three now
require `allowedToolNames` to be passed explicitly — no default — since there is only one tool list
per agent now and a silent catalog-shaped default would be actively wrong. Any tool call using a
name outside the passed list is dropped before dispatch, exactly as an unrecognized tool name
always was — this is what makes the recommendation-ab-safety test's "gateway surface is NOT applied
to open-ended discovery" assumption obsolete (Gateway now *is* applied there too — see Part 11).

## Read-vs-write ledger visibility (a real, intentional behavior change)

The catalog surface's `call_shopify_operation` covered both reads and writes, so every read also
produced a `ShopifyOperationCall` ledger row via `executeShopifyOperation`. Gateway's `shopify_query`
does not go through `executeShopifyOperation` at all — `runValidatedQuery` calls the Shopify client
directly (`requestWithClassification`/`request`), since the ledger's accepted-Action-
revision/idempotency/blast-radius machinery exists specifically for writes. This means
`prisma.operationCalls`/the mutation ledger only ever contains writes now; a gateway read is visible
in `trace.toolResults`, not the ledger. Two tests in `tests/agentic-shopify-runtime.test.mjs`
("accepted semantic Action authorizes Luna to execute multiple generated Shopify operations and
verify read-back", "a second unrelated semantic Action can execute product metafield writes and
verify final state") asserted a verification *read* appeared in the ledger under the old shape;
both were updated to check `trace.toolResults` instead, with an inline comment explaining why.
