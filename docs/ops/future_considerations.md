# Future considerations (external tools / infra to revisit)

> Not-now items worth logging: external tools, vendors, or infrastructure that
> don't fit the current build but could matter later. Each entry records what it
> is, when it'd be useful for Jefe, why not now, and the trigger to revisit.

## Sapiom — financial/gateway layer for AI agents to buy & access third-party services

**What it is.** A gateway that sits between AI agents and paid third-party
services (APIs, data, compute) and handles authentication, payment (including
micro-payments), and spend governance — "agents buying their own tech tools"
behind one key. Seed-stage (Feb 2026, $15M, Accel); founded by a former Shopify
engineering director (Ilan Zerbib). Docs: https://docs.sapiom.ai/how-it-works/

**When it'd be useful for Jefe.** If Jefe's agent grows to *dynamically*
discover and pay for third-party data/enrichment/tools per-merchant on the fly —
market data, competitor signals, enrichment APIs — rather than today's fixed,
hardcoded integration list. Then one gateway handling auth + micro-payments +
spend governance replaces bespoke per-vendor billing/auth plumbing.

**Why not now.** Jefe's integrations are a fixed, managed set (Shopify, the LLM
provider, Slack/WhatsApp/email, Railway/Postgres), each with its own credential
in Railway — there's no dynamic agent-purchasing problem for Sapiom to solve.
It's also early-stage (seed), so it's a dependency risk for a launching product.
And it's distinct from Jefe's model of acting with the *merchant's* money on the
*merchant's* systems under ask-first guardrails — Sapiom is about an agent
holding its own wallet to buy tooling.

**Trigger to revisit.** When Jefe autonomously provisions/pays for its own
external data or tools (per-merchant enrichment, market/competitor data feeds),
or needs governed agent-initiated spend on third-party services.

_Logged 2026-07-28 at Matt's request (from a chat about whether Sapiom fits)._

## Sciforium — serverless LLM inference provider (cost/margin lever)

**What it is.** A serverless AI inference platform: instant access to a broad
library of open-source + frontier models, OpenAI-API-compatible, running on
their own AMD GPUs for lower cost / stronger privacy / no infra to manage. Same
category as Groq / Together / Fireworks. Founded 2024, SF. https://sciforium.com/

**When it'd be useful for Jefe.** As an **LLM-cost/margin lever.** Jefe already
runs on an LLM behind a provider abstraction (`LLM_PROVIDER` / `LLM_MODEL`,
currently Gemini/Groq), and Sciforium is OpenAI-compatible — so adding it or
A/B-testing it is low-effort. Value grows with scale: merchant count × (memory
rebuilds + insights/goals/plan generation + the Slack/email conversations we're
adding) makes inference a real cost line, directly relevant to
`docs/ops/product_analytics_and_margin_spec.md`. Secondary: model flexibility +
an own-hardware privacy angle (though we already redact PII before any LLM call).

**Why not now.** The current provider works; there's no cost/margin pain to solve
yet, and Sciforium is young (2024). Adopting now optimises a cost we don't feel
yet.

**Trigger to revisit / bring to the team.** When LLM cost/margin becomes a focus
(the margin-spec work lands, or inference spend shows up in analytics), or when
we want model flexibility. Because inference is commoditised + swappable behind
our abstraction, it's a cheap experiment: benchmark quality + latency + cost vs
the current provider and keep whatever wins — but only adopt with the abstraction
keeping a fallback, never as the sole hard dependency.

_Logged 2026-07-28 at Matt's request; he asked to have it brought back when the
time is right._
