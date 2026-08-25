# The zero-token errors: exact mechanism, proven at the source line

## Where the error is thrown — before any network call

`app/lib/llm/providers/openai-compatible.server.js`, `generateStructuredJson()`:

```js
const promptText = `${systemPrompt}\n\n${input.request.prompt}`;
const estimatedInputTokens = estimateTokens(promptText);   // Math.ceil(text.length / 4)
const maxInputTokens = input.request.maxInputTokens ?? input.config.maxInputTokens;
if (estimatedInputTokens > maxInputTokens) {
  throw new LlmInputLimitError(
    `Estimated ${estimatedInputTokens} input tokens exceeds ${maxInputTokens}.`,
  );
}
// ... the fetch() call happens after this point, never reached here
```

`generateAgenticShopifyRecommendation` calls this with `maxInputTokens: 80000`
(`recommendation-agent.server.js`). The prompt this run built — merchant memory, goal coaching,
insights, active work, opportunity surface, plus the discovery-phase system prompt — estimated at
83,445 tokens (character-count/4, a fast heuristic, not a real tokenizer call — also zero network
I/O). **This check runs synchronously, in-process, before `fetch()` is ever called.** No request
reaches OpenAI. This is the entire explanation for the 8ms/17ms/33ms latencies.

## Where the `LlmUsageEvent` row comes from

`app/lib/llm/provider.server.js`, `withUsageRecording()`'s wrapper:

```js
const askedAt = Date.now();
try {
  const result = await method(request);
  ...
} catch (error) {
  const elapsedMs = Date.now() - askedAt;
  ...
  void finishLlmUsageAttempt(ctx.prisma, attemptId, {
    ...base, usage: null, latencyMs: elapsedMs, status: "error",
  });
  throw error;
}
```

Any thrown error — including one thrown synchronously before the network call, like
`LlmInputLimitError` — is caught here and recorded with `usage: null` (→ `input_tokens: 0,
output_tokens: 0`) and `latencyMs` measured from when the call was asked for, which for a
synchronous pre-flight throw is single-digit-to-low-double-digit milliseconds. **This confirms
directly, at the source: yes, these are real `LlmUsageEvent` rows, deliberately emitted for a
local/preflight failure, before OpenAI is contacted** — not a logging bug, not a malformed
request, not a provider-side response. `LlmInputLimitError`/`LlmOutputValidationError`/config
errors all take this same near-zero-latency path; a real provider HTTP failure (429, 5xx, timeout)
would show a latency in the hundreds-of-ms-to-tens-of-seconds range, matching the `store_understanding`
timeout row (20275ms) and the `insights`/`goals`/`store_understanding` successful calls
(5.4s–8.2s) elsewhere in this same session's own event log — i.e., this session's own data already
contains the contrast case that proves the classification.

## Correlation to run/stage

All three zero-token error events (19:26:47.536, 19:27:51.974, 19:29:56.335) carry
`run_id = 2d8f34ab-3b2d-4041-be7c-443f3553202f`, `run_type = MerchantPlanRun`,
`feature = agentic_recommendation` — the same run, three separate job-level attempts (`02`, `04`).
None belong to a different or later "second run" — there is no second run.

The stage each belongs to is the **first LLM call of the run** — discovery
(`generateAgenticShopifyRecommendation` with `focusCandidate: null`, called once per job attempt
before any candidate is ever selected). This is consistent with `result_json` being sparse
(`{"reason": "failed", "runtime": "agentic_shopify"}`, written by `markAgenticRecommendationJobFailed`
rather than the normal candidate-pipeline completion path) — the failure occurred before candidate
discovery ever produced a queue, on every one of the three attempts, because nothing about the
prompt's size changed between attempts.
