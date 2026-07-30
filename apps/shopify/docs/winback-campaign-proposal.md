# Proposal: Win-back campaign (multi-email sequence)

Status: **proposal, awaiting founder sign-off.** Founder direction: the win-back
shouldn't be one email — it's a **campaign that keeps reaching out after uninstall
until we get a "why" (feedback) or they reinstall**, then stops.

Today: a single win-back email fires once on uninstall (live). This extends it to
a short, self-terminating sequence. Because these are **repeated emails to people
who left**, the design is safety-first: a hard cap and multiple stop conditions
so it can never tip into harassment.

## The sequence (proposed)

| # | When | Angle | Notes |
|---|------|-------|-------|
| 1 | Day 0 (on uninstall) | The farewell + one feedback ask | **Live today** — the built win-back |
| 2 | Day ~4 | Lighter nudge, *different* angle — "still curious what made you leave" | Short; does NOT repeat email 1's pitch |
| 3 | Day ~10 | Final "last note" — soft door, then silence | Explicitly the last email |

**Hard cap: 3 emails, ever.** Never a 4th, regardless of state.

## Stop conditions — ANY of these ends the sequence immediately
1. **Feedback received** — merchant clicks a reason link *or* replies (we got the "why" — the whole point).
2. **Reinstall** — the shop is active again (the win-back guard already clears on reinstall).
3. **Unsubscribe** — one-click, honoured immediately (RFC-8058, already wired).
4. **Cap reached** — after email 3, silence.

The sequence is a *reason to keep going*, not a schedule that runs regardless —
each send re-checks all four before firing.

## Tone
Un-needy, warm, British, short — the "— Jefe" voice. Email 2 and 3 are **lighter**
than 1 (no full re-pitch); email 3 is explicitly the last word, door left open.

## Technical shape
- **Scheduler:** the existing worker tick (same infra as the changelog watcher —
  Railway, no local dependency). A daily-guarded pass finds churned shops **due**
  for email 2 or 3 (uninstalled N days ago, prior email sent, no stop condition
  met) and sends.
- **State:** a small step marker per shop — either `winback_step` (0/1/2/3) or
  three nullable `winback_email_{1,2,3}_sent_at` timestamps (additive columns).
  Idempotent claim per step (the same atomic `updateMany WHERE ... IS NULL`
  pattern the single win-back already uses).
- **Stop checks before each send:** feedback event exists for the shop? reinstalled
  (`status = active` / guard cleared)? unsubscribed? → skip + close the sequence.
- **Gating:** the whole campaign (emails 2–3) behind `ENABLE_WINBACK_CAMPAIGN`
  (default off) on top of `ENABLE_WINBACK_EMAIL`. Ships dark; a human flips it on
  after reviewing the email-2/3 renders (same discipline as email 1).
- **Templates:** email 2 + 3 mirror the win-back design system (cream card,
  Georgia display, terracotta accent), each with the feedback ask + unsubscribe.

## Safety recap (the non-negotiables)
Hard cap of 3 · every email one-click unsubscribable · stops the instant we get
feedback, a reinstall, or an unsubscribe · dark-flagged until the renders are
reviewed · PII-free reason capture (already live via `/e/feedback`).

## Open questions for Matt
1. **Cadence + count** — 3 emails at day 0 / 4 / 10? Or a different rhythm / count?
2. **Email 2 + 3 angle** — what's the hook for each (curiosity? a specific "what
   we've since improved"? a small reconnect incentive)?
3. **Step storage** — a single `winback_step` int, or three timestamp columns
   (more auditable)? (Recommend the int for simplicity.)
