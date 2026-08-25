# Part 13 — Rescue discovery

## Did rescue run?

Yes. `trace.progressLog` shows a `RESCUE_DISCOVERY` phase at 18:06:51 UTC, immediately after the 6th
candidate (`capture-product-margin-data`) reached its terminal disposition, ending at 18:07:11 UTC
with `NO_ACTIONABLE_OPPORTUNITY`. `diagnostics.discoveryLog`'s second entry confirms this:

```json
{ "usage": { "inputTokens": 58249, "outputTokens": 420, "totalTokens": 58669 }, "rescue": true, "candidateCount": 0 }
```

## What was supplied to it

Rescue's input size (58,249 tokens) is nearly identical to the primary discovery call's (57,372
tokens) — it is not a stripped-down or differently-scoped prompt, it's the same discovery mechanism
re-invoked with the 6 rejected candidates' outcomes presumably in context (the rejection history is
not separately broken out in the persisted trace, so this can't be shown verbatim — the same
`safeTrace()` gap from 05 applies to the discovery/rescue LLM calls' own prompts, which were never
persisted in full, only their token counts via `llm_usage_event`).

## Result: zero candidates

Rescue produced **no candidates at all** — not "candidates that got rejected again," a genuine empty
output (`candidateCount: 0`, `output_tokens: 420` — a short response, consistent with a brief
"nothing new to propose" rather than a long reasoning trace that considered and discarded options).

## Was this genuine exhaustion or accumulated pessimism?

Given that 4 of the 6 primary rejections were downstream of one bad `products` read (04/05/06), and
rescue runs *after* that same context, it is a reasonable hypothesis that rescue was told (implicitly,
via the accumulated rejection history) that "the anchor products can't be found," which would suppress
any rescue candidate that also depends on them — potentially including genuinely new angles that
happen to reference the same two products, since they're the store's clearest recent momentum signal
(this is the same reasoning basis 3 of the 6 primary candidates used).

This cannot be fully confirmed without the rescue prompt's actual content — another instance of the
05 observability gap — but it is a plausible secondary effect of the same primary defect, not a
separate rescue-specific bug. It is not counted as an independent root cause in 13, because there
isn't independent evidence for it beyond token-count circumstantial inference.

## Comparison with the earlier successful Gateway run

The earlier run that produced "Create a Proven Products collection led by Borderlands Discovery Four"
is not directly comparable here: its own record no longer exists in the local database (02), so this
report cannot reproduce a side-by-side discovery-log/token comparison for it. That comparison,
requested by the task's Part 3, is not answerable from currently-available data — flagged as a gap in
13 rather than fabricated.
