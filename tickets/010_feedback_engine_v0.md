# Ticket 010 — Feedback Engine v0

## Goal

Build the first version of the Feedback Engine.

## Context

Merchant feedback, rejected actions, sales objections and churn reasons become structured product and recommendation signals.

Read:
- docs/context/08_feedback_engine.md
- docs/context/10_security_privacy_operational_reality.md
- docs/context/11_ai_native_company_workflow.md

## Requirements

- Feedback button on action cards and daily brief.
- Capture text feedback.
- Voice/screen recording placeholder or simple upload path.
- LLM distillation service interface.
- Confirmation step: “did I get that right?”
- Store feedback.
- Route to Linear or local stub if Linear disabled.
- Attach merchant, plan, action, MRR placeholder, severity.
- Basic clustering placeholder.

## Acceptance criteria

- Feedback persists.
- Distilled feedback can be confirmed/corrected.
- Linear routing can be toggled off for local dev.
- No PII sent externally without handling.
- Tests cover feedback flow.
