# AI Ecom Manager Context Pack

This repo context pack gives Conductor and coding agents the product, architecture, MVP and workflow memory for the AI Ecom Manager project.

## How to use

1. Copy these files into the root of your project repo.
2. Commit them before asking agents to build.
3. Instruct Conductor/coding agents to read `AGENTS.md` first.
4. Then ask them to read the relevant `/docs/context` files for each ticket.
5. Use the `/tickets` folder as the starting backlog.

## First Conductor prompt

```md
You are working on the AI Ecom Manager repo.

Before doing any implementation:
1. Read AGENTS.md.
2. Read all files in /docs/context.
3. Summarise the product, MVP, architecture, and what is explicitly out of scope.
4. Then wait for my first implementation ticket.

Do not write code yet.
```

## Suggested first ticket

Start with:

`tickets/001_shopify_app_scaffold.md`

Then move to database, Shopify read connector, Daily Verdict, Inventory Guardian, Watchdog and Feedback Engine.
