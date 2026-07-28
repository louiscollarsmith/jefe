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
