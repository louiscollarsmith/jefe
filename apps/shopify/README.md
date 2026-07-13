# Jefe Shopify App

Embedded Shopify App Bridge app for Jefe.

This app is the home base for Daily Verdict, Inventory Guardian, Watchdog, Klaviyo Winback, Feedback, House Rules, evidence, previews, and approvals.

## Setup

Run commands from this directory:

```shell
cd apps/shopify
npm install
npm run db:up
npm run setup
npm run config:link
npm run dev
```

Use `DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"` for local development. The Shopify CLI will ask you to log in, connect an app, create a tunnel, and install the app on a development store. Press `P` in the CLI session to open the embedded app.

## Verification

```shell
npm run typecheck
npm run lint
npm test
npm run build
```

## Scope

Implemented:

- Shopify embedded app shell
- Authenticated `/app` route
- Placeholder `Today's Verdict` page
- Placeholder cards for Daily Verdict, Inventory Guardian, Watchdog, Klaviyo Winback, Feedback Engine, and House Rules + Goals
- Postgres-backed Prisma schema for Shopify sessions, tenant data, House Rules, goals, ledger events, commerce state, actions, executions, feedback, attribution, connectors, and cost metering

Not implemented yet:

- Shopify commerce data sync
- AI recommendations
- Klaviyo integration
- Billing
- Production deployment
