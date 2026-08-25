# Part 2 — Exact code path switched by `SHOPIFY_AGENT_SURFACE`

File: `apps/shopify/app/lib/shopify/agentic-runtime/recommendation-agent.server.js`.

| Change | Location (function) | What it does |
| --- | --- | --- |
| Compute `isGatewayFocusedInvestigation`, `discoveryToolName`, `readToolName`, `dispatchShopifyTool`, `apiVersion` | Top of `generateAgenticShopifyRecommendation` | Single source of truth for every downstream branch in this call |
| Skip server-bound stub retrieval | `generateAgenticShopifyRecommendation` | `if (focusCandidate && !isGatewayFocusedInvestigation)` |
| Override `searchableShopifyApiKnowledge` prompt text | `generateAgenticShopifyRecommendation` | Local `context` object override only — `buildRecommendationContext` itself untouched |
| Build a derived schema with the gateway's `toolCalls` shape | `generateAgenticShopifyRecommendation` | `recommendationSchema` computed once before the iteration loop |
| Pick system prompt | `generateAgenticShopifyRecommendation` loop | `buildGatewayCandidateInvestigationSystemPrompt()` (new function) vs `buildCandidateInvestigationSystemPrompt()` |
| Pass allowed tool names into turn normalization | `generateAgenticShopifyRecommendation` loop -> `normalizeRecommendationTurn(json, allowedToolNames)` | **Bug fix**: this filter previously hardcoded the catalog's two tool names unconditionally, silently dropping every gateway tool call before dispatch — see `15-remaining-limitations.md` |
| Loop-prevention guard, dedup check, dispatch | `generateAgenticShopifyRecommendation` loop | Uses `discoveryToolName`/`readToolName`/`dispatchShopifyTool` instead of hardcoded catalog names/function |
| Investigation-sufficiency gate (×3 call sites: `RECOMMEND_ACTION`, `NO_ACTIONABLE_OPPORTUNITY`, `BLOCKED`) | `generateAgenticShopifyRecommendation` | `validateInvestigation(..., { discoveryToolName, readToolName, requireDiscovery: !isGatewayFocusedInvestigation })` — **all three**, not just the first; the second bug found this session |
| Diagnostics reporting (×7 call sites) | `generateAgenticShopifyRecommendation` | `buildRecommendationDiagnostics(..., { discoveryToolName, readToolName })` so `diagnostics.shopifyReads`/`retrievedOperations` reflect gateway tool usage too |
| New gateway-aware dedup helper | `findExistingGatewayQuery` (new, sibling to `findExistingRead`) | Fingerprints by (trimmed document text, variables) instead of (operation name, variables) — see known limitation on fingerprint precision in `15-remaining-limitations.md` |
| New gateway system prompt | `buildGatewayCandidateInvestigationSystemPrompt` (new) | Describes the 2-tool surface, makes schema lookup explicitly optional |

File: `apps/shopify/app/lib/shopify/gateway/tools.server.js` — one addition: `shopify_query`'s
result `facts` now include `document`/`variables` (previously only `operation`/`domain`/`data`),
needed both for the dedup fingerprint above and for the instrumentation this report required
(Part 7 of the brief — "preserve raw GraphQL documents in the report").

## What was deliberately left untouched

- `candidate-pipeline.server.js` — 0 lines changed.
- `execution-agent.server.js`, `verification-agent.server.js`, `action-chat.server.js` — 0 lines
  changed. Each still imports `SHOPIFY_AGENT_TOOL`/`runShopifyAgentTool` directly, unaware the
  gateway module exists.
- The non-`focusCandidate` branch of `generateAgenticShopifyRecommendation` (open-ended discovery)
  — `isGatewayFocusedInvestigation` is `false` whenever `focusCandidate` is falsy, so every branch
  in this file behaves exactly as before for that call shape.
- Candidate ranking, disposition taxonomy, eligibility validation, semantic-recommendation
  validation, novelty checking — none of these functions were touched.
