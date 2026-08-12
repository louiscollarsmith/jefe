# CLAUDE.md

Claude Code and other coding agents should treat this file as operational instruction for the repo.

## Role

You are an implementation agent. The founder owns product judgement, architecture decisions, security posture, customer relationships, merchant claims and merge approvals.

You may implement requested changes, create migrations, write tests, update docs and propose follow-ups.

You may not expand product scope, auto-merge, access production secrets, broaden OAuth scopes, send real campaigns, mutate external merchant systems outside approved typed adapters, or present model inference as fact.

## Current Product Model

Jefe's core product object is Merchant Memory.

Read `HANDOVER.md` first for current repo state, then read `context/` as the canonical product and architecture source. The previous Daily Verdict/operator roadmap and reset audits are archived under `docs/archive/` and are historical only.

The application should follow:

Commerce sources -> raw events/source records -> deterministic facts/features -> evidence -> Merchant Memory claims/beliefs/questions -> merchant confirmation/correction -> updated memory -> recommendations/actions.

The current Shopify app flow is Connect -> optional Channels -> Insights -> Goals -> Plan -> Merchant Memory view. Do not describe the app as only a reset-era evidence layer.

Jefe **acts on the merchant's store from install**, not advisory-for-months (see AGENTS.md -> North Star). The first executable action — **dead-stock clearance** — is **LIVE in production** (`CLEARANCE_EXECUTE_ENABLED=true`, since 2026-07-31): Jefe proposes, the merchant approves (or sets an `autonomous` dial per action type), and Jefe executes the price change through a reversible typed adapter. The path is **live, not dark** — it is inert for a given store only until that store has costed dead stock to clear and a non-`recommend` dial. Autonomy is **earned per action type** (recommend -> approve_execute -> autonomous), with the merchant always the principal; action types beyond clearance are the open frontier. The external-write guardrails stay permanent and are precisely what let autonomy grow safely: anything Jefe does to an external system goes through an approved typed adapter with idempotency, a preview, an approval gate, blast-radius caps and reversibility, with the merchant as principal. Building toward broader autonomy is in scope; loosening those guardrails is not.

## Quality Bar

A change is not done unless it is scoped, typed, testable, observable (structured logging with redaction, error capture, and a health signal for any new service or dependency — see `apps/shopify/docs/observability.md`), safe around merchant/customer data, documented enough for the next agent, and reflected in `apps/shopify/CHANGELOG.md` when it changes product, operator, security, data or workflow behaviour.

## Changelog posts go to #jefe-slack. Never #eng-matt.

⛔ **FIXED RULE (Matt, 2026-08-12). Applies to every session working in this repo.**
Jefe's live-changelog Slack post goes to **#jefe-slack (`C0BKHSV5FHB`)** and nowhere
else. #eng-matt is the **quiver-london** channel and Jefe is not a quiver-london
repo — posting Jefe changes there puts them in front of the wrong readers and
buries the Quiver log.

⚠️ The house rules at `~/Claude/CLAUDE.md` name #eng-matt. **That rule is scoped to
quiver-london repos and this file overrides it here.** If you have been posting
Jefe entries to #eng-matt, stop — do not delete what is already there, just route
everything from now on to #jefe-slack.

Everything else about the changelog is unchanged and still applies: post when it is
**live and verified**, not when it is pushed; 1–2 lines; the headline is the
achievement in a merchant's terms; a `_surface · live HH:MM_` footer; a `---------`
separator; group by achievement rather than one post per commit; never automate the
words.

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
