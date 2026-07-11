# Ticket 001 — Scaffold Shopify embedded app

## Goal

Create the initial Shopify embedded app for AI Ecom Manager.

## Context

This is the home base for the product. Merchants will use it to see Daily Verdict, Inventory Guardian, Watchdog alerts, evidence, approvals and feedback.

Read:
- AGENTS.md
- docs/context/00_north_star.md
- docs/context/01_product_scope.md
- docs/context/02_mvp_plan.md
- docs/context/03_architecture.md

## Requirements

- Use Shopify CLI recommended app scaffold.
- Use React / TypeScript.
- Use Shopify Polaris.
- Use App Bridge.
- Add a placeholder home page titled “Today’s Verdict”.
- Add placeholder cards:
  - Daily Verdict
  - Inventory Guardian
  - Watchdog
  - Feedback
- Add basic project README with local dev instructions.
- Do not build real Shopify data sync yet.
- Do not add unnecessary dependencies.

## Acceptance criteria

- App runs locally.
- Embedded app page loads.
- TypeScript passes.
- Lint passes.
- README explains setup.
- PR summary explains architecture choices.

## Out of scope

- Database schema
- Shopify webhooks
- AI recommendations
- Klaviyo integration
- billing
- production deployment
