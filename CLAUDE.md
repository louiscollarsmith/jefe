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

Jefe **acts on the merchant's store from install**, not advisory-for-months (see AGENTS.md -> North Star). Dead-stock clearance is **LIVE in production** (`CLEARANCE_EXECUTE_ENABLED=true`, since 2026-07-31): Jefe proposes, the merchant approves (or has set that store to `autonomous`), and Jefe executes the price change through a reversible typed adapter.

### Two questions, never one (Matt, 2026-08-12 — supersedes "registered actions")

⛔ **There is no registry of things Jefe is allowed to suggest.** *"No more 'registered actions' — instead any action or recommendation should be possible."* Split what `ACTION_REGISTRY` used to fuse:

- **"Can Jefe propose this?" — ALWAYS YES.** Unbounded, no registry lookup, no permission check. Jefe reasons over everything it knows (139 deterministic beliefs and rising) and says whatever is true and useful, including things we have no adapter for. Clearance is *one* action, not the shape of the product — do not let its requirements (cost data, dead stock) define what Jefe can talk about.
- **"Can Jefe do it for the merchant?" — where a safe path exists.** Otherwise Jefe **tells them exactly how to do it themselves**, with steps. `ACTION_REGISTRY` describes *execution capability*; it is not a gate on proposals.

**Invariant: no dead ends.** Every recommendation either executes, asks for approval, or instructs. "I can't help with that" is never an acceptable output — neither is silence.

⚠️ **What this does NOT relax.** The external-write guardrails are properties of the **write primitives**, not of named actions, and they stay permanent: anything Jefe does to an external system goes through a typed adapter with idempotency, a preview, blast-radius caps and reversibility, with the merchant as principal. These are precisely what make `autonomous` offerable at all — remove them and no merchant can safely leave the dial on. Building toward broader autonomy is in scope; loosening those guardrails is not.

**Autonomy has TWO modes, not three** (Matt, 2026-08-12): **approve** (human in the loop) and **autonomous**. `recommend` is retired as a merchant-selectable mode — it survives only as a *system state* meaning "Jefe can't execute this one", which routes to the instruct path above. Eligibility is decided at **runtime** by the execution gate (no adapter / flag off / scope ungranted / not reversible / over blast-radius cap / low confidence), never as a per-type setting the merchant manages.

**Missing data is an invitation, not a blocker.** Where an input would unlock better advice — cost-per-item for margin work, a connected ad account for acquisition — Jefe asks for it and says what it would unlock. It does not silently degrade, and it does not refuse to speak.

## Work your queue to completion. Do not stop after one item.

⛔ **STANDING RULE (Matt, 2026-08-12).** A session that finishes one task and goes
idle is the single biggest drag on throughput here — fifteen idle lanes produce
nothing while six working ones produce steadily. **You are not waiting for
permission between items.**

- You will normally be given a **queue**, not a task. Work it top to bottom.
- **Report when the queue is empty, or when you are genuinely blocked** — not
  after each item, and not to confirm the obvious next step.
- **Blocked means blocked**: a one-way door needing a founder call, a dependency
  another lane owns, or a question whose answer changes what you build. It does
  not mean "the next item is a bit ambiguous" — make the judgement call, state
  the assumption, keep going.
- If the queue empties and nothing is blocking you, **pick the next most valuable
  thing in your lane and do it**, then say what you chose and why.
- Landing a commit is not a reason to stop. Rebase, take the next item, continue.

### Keep yourself going — don't wait to be nudged

⛔ **A turn ending is not the work ending.** When you finish a turn with items
still in your queue, **schedule your own continuation** rather than going idle
and waiting for someone to prompt you:

```
/loop 5m Continue my queue. Re-read my lane brief, pick up the next
unfinished item, work it, push my branch. Stop the loop when the queue
is empty or I am genuinely blocked.
```

**Stop the loop** (`ScheduleWakeup` with `stop: true`, or `CronDelete`) the
moment your queue is empty or you are blocked — a loop that fires with nothing
to do is pure waste, and a loop nobody stops outlives its usefulness.

**Push your branch on every commit, even a partial one.** In-flight work is
otherwise invisible: from outside, a lane deep in a hard problem and a lane that
died look identical. Merge to main only when a piece is complete and green — the
push is for visibility, the merge is for readiness.

⚠️ The door rule still applies inside the queue: two-way doors ship without
asking; one-way doors (stored data, merchant-visible one-shots, live flag flips,
scopes, auth) stop and ask **with a recommendation attached**. Asking is cheap;
asking about a two-way door is the thing that stalls the fleet.

## Changelog posts go to #jefe-slack. Never #eng-matt.

⛔ **FIXED RULE (Matt, 2026-08-12).** Jefe's live-changelog Slack post goes to
**#jefe-slack (`C0BKHSV5FHB`)** and nowhere else. #eng-matt is the
**quiver-london** channel and Jefe is not a quiver-london repo — posting Jefe
changes there reaches the wrong readers and buries the Quiver log.

⚠️ The house rules at `~/Claude/CLAUDE.md` name #eng-matt. **That rule is scoped
to quiver-london repos and this file overrides it here.** Don't delete anything
already posted there; just route everything from now on to #jefe-slack.

⛔ **Always reference the commit** (Matt, 2026-08-12). Put the short SHA in the
footer so an entry can be traced back to the change that caused it — a changelog
you cannot tie to a diff is a story, not a record. Group-by-achievement still
applies: if it took four commits, reference the one that made it live.

```
_app home · live 15:20 · 96b382f_
---------
```

Everything else is unchanged: post when it is **live and verified**, not when it
is pushed; 1–2 lines; the headline is the achievement in a merchant's terms;
footer then a `---------` separator; group by achievement rather than one post
per commit; never automate the words.

## Quality Bar

A change is not done unless it is scoped, typed, testable, observable (structured logging with redaction, error capture, and a health signal for any new service or dependency — see `apps/shopify/docs/observability.md`), safe around merchant/customer data, documented enough for the next agent, and reflected in `apps/shopify/CHANGELOG.md` when it changes product, operator, security, data or workflow behaviour.

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
