# Ticket 008 — Daily brief delivery and SLA

## Goal

Send the 7am daily brief and monitor brief generation/delivery.

## Context

Pull-only engagement kills this category. The brief is the manager's heartbeat. Silence breaks trust.

Read:
- docs/context/09_product_surfaces_and_brief_sla.md
- docs/context/03_mvp_scope_and_modules.md

## Requirements

- Scheduled daily brief generation.
- Email delivery v0.
- Deep links into embedded app.
- Job status tracking.
- Degraded mode if data delayed.
- Failure logging.
- Basic monitoring/alerting placeholder.

## Acceptance criteria

- Can generate and send a test brief.
- If data incomplete, sends “data delayed, here is what I can verify”.
- Brief links to action cards.
- Brief status visible internally.
