# Ticket 007 — Feedback Engine v0

## Goal

Add basic in-app feedback capture and route structured feedback to Linear or a local placeholder.

## Context

Feedback is how the product and company learn from merchants.

Read:
- AGENTS.md
- docs/context/07_feedback_engine.md
- docs/context/06_security_and_data.md

## Requirements

- Add thumbs up/down on action cards.
- Add reject/dismiss reason.
- Store feedback in database.
- Add optional free-text note.
- Add a service interface for routing feedback to Linear.
- For local dev, allow Linear routing to be disabled and logged instead.

## Acceptance criteria

- Feedback persists.
- Feedback includes merchant ID, action ID, feedback type, reason and timestamp.
- No customer PII is sent to external services without explicit handling.
- Tests cover feedback creation.
