# Ticket 001 — Shopify embedded app scaffold

## Goal

Create the initial Shopify embedded app shell for Jefe.

## Context

The embedded App Bridge app is the home base for the manager. Evidence, diffs, previews and approvals need a real surface.

Read:
- AGENTS.md
- CLAUDE.md
- docs/context/00_north_star.md
- docs/context/01_product_scope.md
- docs/context/09_product_surfaces_and_brief_sla.md

## Requirements

- Use Shopify CLI recommended scaffold.
- Use React / TypeScript.
- Use Shopify Polaris.
- Use App Bridge.
- Add placeholder home page: “Today’s Verdict”.
- Add placeholder cards:
  - Daily Verdict
  - Inventory Guardian
  - Watchdog
  - Klaviyo Winback
  - Feedback
  - House Rules
- Add README with local dev instructions.
- Add env sample.
- Add lint/typecheck/test scripts.
- Do not build real data sync yet.

## Acceptance criteria

- App runs locally.
- Embedded app page loads in Shopify dev store.
- TypeScript passes.
- Lint passes.
- README explains setup.
- No production secrets.
