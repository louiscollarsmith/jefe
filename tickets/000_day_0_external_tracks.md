# Ticket 000 — Day-0 external tracks and project setup

## Goal

Start all external review queues and create the initial project operating system.

## Context

AI can compress implementation but not third-party review queues. File external tracks on day 0 while building through pilot fast paths.

Read:
- AGENTS.md
- CLAUDE.md
- docs/context/06_pilot_fast_path_and_integrations.md
- docs/context/13_roadmap_bfcm_calendar.md
- docs/context/17_week_1_build_plan.md

## Requirements

Create a checklist/document for:

### Shopify

- public app review with minimal scopes
- protected customer data Level 2 review
- custom/unlisted install pilot path

### Klaviyo

- public app review
- merchant private key pilot path

### Meta

- Marketing API app review
- merchant system-user token/report export pilot path

### Google

- Ads developer token
- GA4 OAuth test-mode consent screen

### Project setup

- repo structure
- CI
- protected branch rules
- decision log
- AI-assisted PR labelling
- issue labels

## Acceptance criteria

- `docs/ops/day_0_external_tracks.md` exists.
- All tasks have owner, status and link placeholder.
- No external credentials committed.
- Follow-up tickets created for blockers.
