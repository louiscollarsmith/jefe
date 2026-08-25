# Part 1 — Recommendation-runtime integration design

## The real merchant path traced

```
Generate Proposal (merchant-facing)
  -> recommendation-service.server.js: runAgenticRecommendationInvestigation()
  -> candidate-pipeline.server.js: runCandidateDrivenRecommendation()
     -> discoverCandidates()                      [LLM + Merchant Memory only, NO Shopify tools]
     -> investigateCandidates() per candidate:
        -> recommendation-agent.server.js: generateAgenticShopifyRecommendation({ focusCandidate })
           -> THIS is the only place Shopify tools are ever called during recommendation.
  -> rescue discovery pass if first pass exhausts
  -> RECOMMEND_ACTION / NO_ACTIONABLE_OPPORTUNITY / BLOCKED
```

`discoverCandidates()` never touches Shopify — confirmed by reading `candidate-pipeline.server.js`
directly (no import of any Shopify tool module in that function). This is why the task's scope
restriction ("wire only the candidate investigation portion") maps to exactly one place: the
`generateAgenticShopifyRecommendation({ focusCandidate: {...} })` call inside
`investigateCandidates`.

## Where the switch lives

Entirely inside `generateAgenticShopifyRecommendation` (`recommendation-agent.server.js`), gated
on a single derived flag computed once per call:

```js
const isGatewayFocusedInvestigation =
  Boolean(focusCandidate) && getConfiguredShopifyAgentSurface() === SHOPIFY_AGENT_SURFACE.gateway;
```

`focusCandidate` is truthy only when called from the candidate pipeline. A run without it (the
open-ended discovery-shaped call the same function also supports, used elsewhere) always uses the
catalogue tools regardless of the env var — this is what makes the scope restriction structural,
not a documentation promise. Proven directly: `agentic-shopify-gateway-recommendation-ab-safety.
test.mjs`, "gateway surface is NOT applied to open-ended discovery."

`candidate-pipeline.server.js` itself is **unmodified** — zero lines changed. It calls
`generateAgenticShopifyRecommendation` exactly as before; the surface switch is invisible one layer
up. This is deliberate: candidate discovery, ranking, pivot-on-failure, and rescue discovery are
untouched, per the task's explicit restriction.

## What changes inside `generateAgenticShopifyRecommendation` when gateway mode is active

| Aspect | Catalog mode (unchanged) | Gateway mode |
| --- | --- | --- |
| Tools offered | `retrieve_shopify_operations`, `call_shopify_operation` | `shopify_schema`, `shopify_query` (mutation tools never offered — see `04-safety-tests.md`) |
| Server-side stub binding | Yes — relevant operation stubs pre-retrieved before the model's first turn | No — Part 4 of the brief: schema lookup is the model's own choice |
| System prompt | `buildCandidateInvestigationSystemPrompt()` | `buildGatewayCandidateInvestigationSystemPrompt()` (new) |
| Investigation-sufficiency gate | Requires ≥1 discovery call AND ≥1 successful read | Requires ≥1 successful read only (discovery optional) |
| Tool-call schema sent to the model | Static `AGENTIC_RECOMMENDATION_SCHEMA` | Same schema with `toolCalls` swapped for `SHOPIFY_GATEWAY_TOOL_CALL_SCHEMA` |
| Dispatcher | `runShopifyAgentTool` | `runShopifyGatewayTool` |
| Output/disposition contract | `RECOMMEND_ACTION` / `NO_ACTIONABLE_OPPORTUNITY` / `BLOCKED`, same schema | Identical — unchanged |

Everything not in this table (candidate ranking, coverage-family logic for open-ended discovery,
semantic-recommendation validation, eligibility encoding, disposition taxonomy) is byte-identical
code, reused unmodified.
