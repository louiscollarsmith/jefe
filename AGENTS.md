# AGENTS.md

## Product

Jefe builds and maintains a living understanding of each merchant's business.

The central product object is **Merchant Memory**: a durable, structured, versioned record of facts, merchant-confirmed facts, model inferences, uncertainties, goals, constraints, operating rules, current priorities, corrections and history.

Jefe is not an analytics dashboard, a chatbot, a generic autonomous agent, or a collection of ecommerce modules.

## North Star

Produce Merchant Memory so accurate that the merchant says:

> Yes. That's exactly how my business works.

Everything else exists to create, improve, inspect, correct or use that memory.

## Authoritative Context

Read in this order before coding:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `context/00_north_star.md`
4. Relevant files in `context/`

Historical context and prompts live under `docs/archive/previous_product_direction/`. They are not authoritative unless a founder explicitly reactivates a specific idea in current instructions.

## Architecture Principles

- Commerce sources feed raw events and source records.
- Deterministic code computes facts and features.
- Evidence items connect facts to source records and ledger events.
- LLMs interpret evidence into claims, beliefs, questions and recommendations.
- The application decides what is persisted.
- Merchant corrections supersede model inference.
- Memory updates create new versions; do not overwrite history.
- Inferred claims need provenance and confidence.
- Never allow inferred information to silently become fact.
- Migrations must be additive, safe and reversible unless explicitly approved.

## Implementation Rules

- Inspect existing code before replacing it.
- Preserve useful Shopify ingestion, canonical commerce records, COGS, ledger, provenance, approval and action-safety infrastructure.
- Do not expose production secrets or production customer data to AI tools.
- Do not let any LLM directly mutate Shopify, Klaviyo or third-party systems.
- External writes require typed adapters, idempotency keys, previews, approval gates and blast-radius caps.
- Use TypeScript types properly and keep changes scoped to the user's current request.
- Shopify embedded merchant UI must use Shopify Polaris React components for visible layout, navigation, forms, tables, feedback and actions.

## Before Coding

Restate the task, list files you expect to change, and state assumptions or blockers.

For UI work, state:

- What is the page's job?
- What is the one thing the user should do?
- What should be visually dominant?
- What can be secondary or hidden?
- What should not be shown?
- Proposed layout

## Before Finishing

- Update `apps/shopify/CHANGELOG.md` using today's UK/London date.
- Use merchant/operator-facing language.
- Run typecheck, lint and tests where available.
- Summarise changes, risks, follow-up work and any checks that could not be run.
