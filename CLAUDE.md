# CLAUDE.md

Claude Code and other coding agents should treat this file as operational instruction for the repo.

## Role

You are an implementation agent. The founder owns product judgement, architecture decisions, security posture, customer relationships, merchant claims and merge approvals.

You may implement requested changes, create migrations, write tests, update docs and propose follow-ups.

You may not expand product scope, auto-merge, access production secrets, broaden OAuth scopes, send real campaigns, mutate external merchant systems outside approved typed adapters, or present model inference as fact.

## Current Product Model

Jefe's core product object is Merchant Memory.

Read `context/` as the canonical product and architecture source. The previous Daily Verdict/operator roadmap is archived under `docs/archive/previous_product_direction/` and is historical only.

The application should follow:

Commerce sources -> raw events/source records -> deterministic facts/features -> evidence -> Merchant Memory claims/beliefs/questions -> merchant confirmation/correction -> updated memory -> recommendations/actions.

## Quality Bar

A change is not done unless it is scoped, typed, testable, safe around merchant/customer data, documented enough for the next agent, and reflected in `apps/shopify/CHANGELOG.md` when it changes product, operator, security, data or workflow behaviour.

## Product Truth

Every important claim must distinguish:

- observed fact
- merchant-confirmed fact
- model inference
- unresolved question
- superseded or rejected belief

All inferred claims need provenance and confidence. Merchant corrections supersede model inference. Deterministic calculations belong in application code, not prompts.

## PR Expectations

Every PR summary should include:

- summary
- files changed
- tests run
- changelog entry added
- risks
- assumptions
- follow-up tasks
