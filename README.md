# AI Ecom Manager v3 Context Pack

This context pack turns the final v3 plan into repo-ready markdown files for Conductor, Claude Code, Codex, Cursor and other coding agents.

## How to use

1. Copy these files into the root of your project repo.
2. Commit them before asking agents to build.
3. Instruct agents to read `AGENTS.md` and `CLAUDE.md` first.
4. Then ask them to read the relevant files in `/docs/context`.
5. Use `/tickets` as the starting build backlog.

## Repository layout

- `apps/shopify` — Shopify embedded App Bridge app scaffold.
- `docs/context` — product, architecture and operating context.
- `tickets` — implementation backlog.
- `prompts` — reusable agent prompts and review checklists.

## First Conductor prompt

```md
You are working on the AI Ecom Manager / Jefe repo.

Before doing any implementation:
1. Read AGENTS.md.
2. Read CLAUDE.md.
3. Read every file in /docs/context.
4. Summarise the product, MVP, architecture, week-one plan, safety rules and what is explicitly out of scope.
5. Then wait for my first implementation ticket.

Do not write code yet.
```

## Recommended first tickets

Start with:

1. `tickets/000_day_0_external_tracks.md`
2. `tickets/001_shopify_app_scaffold.md`
3. `tickets/002_schema_event_ledger_house_rules.md`
4. `tickets/003_shopify_ingestion_backfill_webhooks.md`
5. `tickets/004_onboarding_goals_house_rules_cogs.md`

## Source of truth

The project north star is:

> Holdout-verified incremental margin delivered per merchant per month.

The product is not an analytics dashboard or chatbot. It is an accountable AI ecom manager for founder-run Shopify stores.
