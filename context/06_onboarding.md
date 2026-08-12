# AI-native Onboarding

The first-run sequence is `CONNECT -> CONTEXT -> INSIGHT -> ACTION -> APP`.

Its job is to prove quickly that Jefe understands something useful about the store. Connection starts two independent durable jobs: a high-priority Merchant Memory bootstrap for first value and the unchanged full-history backfill for deeper learning. Neither waits for the other.

The merchant answers one question about what matters now. That exact answer becomes a merchant-supplied `preferences.optimisation_priority` belief. It may reorder similarly supported opportunities, but evidence wins.

Bootstrap derives only an exact allowlist of recent-window-safe beliefs from canonical commerce records. Deterministic evidence contracts decide which opportunity types are eligible before the LLM sees them. Bootstrap evidence retains its source, observed window, completeness, confidence cap, caveat and supporting records. It must not infer dead stock, refunds, repeat behaviour, LTV, seasonality, momentum, YoY or all-time conclusions.

The first generated output is one insight and one recommendation, with at most three validated evidence rows. A recommendation backed by a live typed adapter follows the existing approval, policy, preview, cap, execution, outcome and reversal path. Otherwise it is honestly track-only and receives a scheduled deterministic review; it must never create a fake execution.

APP is a single-use completion handoff containing only real accepted, deferred or tracked work. Consuming its token completes onboarding and removes the token from the address. Later visits open Daily Home normally while the full-history job continues. Skip uses the same handoff and never cancels background learning.

Merchant-facing onboarding never exposes import counts, percentages, ETAs, queue terminology, metric grids, charts or dominant spinners. Historical learning is a quiet status, not a gate.
