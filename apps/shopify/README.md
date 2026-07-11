# Jefe Shopify App

Embedded Shopify App Bridge app for Jefe.

This app is the home base for Daily Verdict, Inventory Guardian, Watchdog, Klaviyo Winback, Feedback, House Rules, evidence, previews, and approvals.

## Setup

Run commands from this directory:

```shell
cd apps/shopify
npm install
npm run setup
npm run config:link
npm run dev
```

The Shopify CLI will ask you to log in, connect an app, create a tunnel, and install the app on a development store. Press `P` in the CLI session to open the embedded app.

## Verification

```shell
npm run typecheck
npm run lint
npm run build
```

## Scope

Implemented:

- Shopify embedded app shell
- Authenticated `/app` route
- Placeholder `Today's Verdict` page
- Placeholder cards for the first manager modules
- Local Prisma session storage

Not implemented yet:

- Shopify commerce data sync
- Production database schema beyond Shopify session storage
- AI recommendations
- Klaviyo integration
- Billing
- Production deployment
