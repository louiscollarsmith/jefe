# Ticket 004 — Onboarding: goals, House Rules and COGS

## Goal

Build the founder-assisted onboarding flow for first design partners.

## Context

Onboarding captures the merchant's 3/6/12-month goals, House Rules and COGS inputs. These shape every recommendation.

Read:
- docs/context/02_house_rules_and_goals.md
- docs/context/04_teardown_cogs_and_onboarding.md
- docs/context/03_mvp_scope_and_modules.md

## Requirements

Build onboarding screens for:
- 3/6/12-month goals
- max discount rules
- email frequency limits
- protected hero products
- brand voice / free-text rules
- margin vs volume priority
- COGS entry/import placeholder

COGS v0:
- manual entry per product/variant
- CSV upload placeholder acceptable if scoped
- confidence status
- missing COGS warnings

## Acceptance criteria

- Onboarding state persists.
- House Rules are visible/editable.
- Goals are visible/editable.
- COGS missing state is handled gracefully.
- No recommendation can ignore House Rules data model.
