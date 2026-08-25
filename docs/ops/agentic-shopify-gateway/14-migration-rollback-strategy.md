# Part 14 — Migration/rollback strategy

## Current state: superseded by docs/ops/agentic-shopify-gateway-recommendation-ab/

**Update, same day, follow-up task:** step 1 of the migration path below — wiring the gateway into
`recommendation-agent.server.js`'s candidate investigation — is done. See
`docs/ops/agentic-shopify-gateway-recommendation-ab/` for the design, safety tests, and a real A/B
run against `jefe-local-store.myshopify.com`. The rest of this document (steps 2–5, and the
"fully inert by default" framing below) describes the state as of the *first* Gateway session and
is now only accurate for the *other* three consumers (`execution-agent.server.js`,
`verification-agent.server.js`, `action-chat.server.js`), which remain untouched.

`SHOPIFY_AGENT_SURFACE` still defaults to `catalog`. `getShopifyAgentToolSurface()`
(`agentic-runtime/tool-surface.server.js`) — the bundling helper this document originally proposed
consuming — ended up unused: the actual recommendation-agent integration imports
`runShopifyGatewayTool`/`SHOPIFY_GATEWAY_TOOL` directly and reads
`getConfiguredShopifyAgentSurface()` itself, because the real integration needed a few more
surface-specific values (discovery/read tool names, `requireDiscovery`, `apiVersion`) than that
helper returns. `getShopifyAgentToolSurface()` remains available and tested for a future consumer
that only needs the plain `{tool, callSchema, dispatch}` shape. Original text, describing the
initial (fully inert) state, preserved below for history:

`SHOPIFY_AGENT_SURFACE` defaults to `catalog` (`agentic-runtime/tool-surface.server.js`,
`getConfiguredShopifyAgentSurface()`). No production code path currently calls
`getShopifyAgentToolSurface()` at all — the switch exists and is tested but isn't consumed anywhere
yet, so this entire change set is inert in production today: new files, one additive parameter on
`gateway.server.js` (`stubOverride`, `undefined` for every existing caller), one new `package.json`
dependency (`graphql`, already a transitive dependency, now explicit), and new docs/tests. Nothing
about the live catalogue-driven recommendation/clearance-execution path changed behaviourally.

## Rollback

Trivial: nothing to roll back operationally, since nothing is wired in. If any part of this needs to
be reverted, deleting `app/lib/shopify/gateway/`, `agentic-runtime/tool-surface.server.js`, and the
`stubOverride` line in `gateway.server.js` returns the repo to its pre-experiment state with no other
code depending on any of it.

## Migration path, if the gateway is chosen over the catalogue

1. **Wire the tool-surface switch into one call site first** — `recommendation-agent.server.js` is
   the highest-value target (it's what `12-baseline-comparison.md` needs for a real quality
   comparison), but per `13-known-limitations.md` it has ~20 places that assume the 2-tool shape.
   Concretely: the `requiredNextTools` prompt hints, the retrieval/read-success counters that gate
   `MAX_RECOMMENDATION_ITERATIONS`, and the disposition logic that inspects
   `SHOPIFY_AGENT_TOOL.callOperation`/`.retrieveOperations` by name all need gateway-shape
   equivalents (`SHOPIFY_GATEWAY_TOOL.query`/`.prepareMutation`/`.executeMutation`). This is bounded,
   mechanical work, not a redesign — the tool-result shape is already identical.
2. **Get a live introspection fetch working** (needs a token — see `13-known-limitations.md` #1) and
   swap the schema-index source from the checked-in catalogue snapshot to a fresh fetch, closing gap
   #2 (object-type field inspection) at the same time by building a real `GraphQLSchema` for
   `validate()`.
3. **Build a gateway-native accept/execute/verify loop** (`05-execution-mutation-mode-design.md`'s
   "what's still missing") — or, more conservatively, keep `materializeAgenticShopifyAction()` /
   `acceptAgenticShopifyAction()` exactly as-is (they operate on the semantic Action, not on how the
   GraphQL was produced) and only swap the *investigation* and *mutation-composition* steps to use
   gateway tools — action acceptance and revision-stamping don't need to know which surface
   produced the eventual GraphQL.
4. **Run a real side-by-side comparison** with a live token: same merchant, same Merchant Memory,
   `SHOPIFY_AGENT_SURFACE=catalog` vs `=gateway`, comparing recommendation quality, token cost, and
   latency — the missing half of `12-baseline-comparison.md`.
5. **Only then** consider retiring the 810-op catalogue generation pipeline. Until step 4 produces
   real evidence, both surfaces should keep running side by side — the switch was built specifically
   so this doesn't require a big-bang cutover.

## What should never change regardless of which surface wins

Per the task brief and this repo's `CLAUDE.md`: the write primitives (accepted-Action-revision
authorization, blast-radius caps, explicit confirmation, idempotency, durable receipts,
verification) stay permanent properties of `gateway.server.js`, not of whichever surface composed the
GraphQL. This migration path never proposes touching them, and the gateway's execute tool reuses them
unchanged rather than re-deriving them.
