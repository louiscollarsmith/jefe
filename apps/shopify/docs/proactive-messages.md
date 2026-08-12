# Proactive messages in the home conversation

Shape B's home is one conversation. Besides the merchant's own messages and Jefe's
replies, Jefe may post **proactive messages** — things it wants to say without being
asked: a move to consider, a run-out approaching, a store-hygiene fix, an outcome report.
This is the contract every lane that wants to speak in the thread builds against.

It is a **two-way door**: it shapes code, not stored data (mostly — see _Persist vs
render_), so it will change as real use teaches us. Propose changes; don't treat it as
frozen. The one part that touches stored data is the exception, called out below.

Owner: the app-home / Shape B lane (`daily-home.tsx`, `app._index.tsx`).

## The floor: silence is allowed

The failure mode is a merchant opening the app to a wall of Jefe talking to itself. The
quiet day is the test. If Jefe has nothing real to say, it says one grounded line and
stops. **Never manufacture content to fill the thread** — that is `AGENTS.md:58` (never
fabricate merchant data) applied to pacing. A quiet home with one true line beats a busy
home of filler. Silence-with-one-real-line is a valid output, not a bug.

## Budget

At most **2 proactive messages** rendered on a home load today (Horizon heads-ups, below
the primary move). The primary move is **not** counted against this — it is the home's
reason to exist. Everything else competes for the remaining slots. Raise the number only
with evidence that merchants want more, never to give every lane a seat.

## Priority (highest wins the scarce slots)

1. The primary move (always shown; not budgeted)
2. Outcome reports on a move already made (an event the merchant may reply to)
3. Run-out / refund heads-ups (a standing condition with a deadline)
4. Store-hygiene fixes (proposable, lower urgency)
5. Everything else

When the budget is tight, lower-priority messages wait for a future load. Rank _within_
your lane before you hand messages up — surface your top one or two, not everything.

## Dedup & decay

Don't re-post the same thing every morning. A thing said once is said; say it again only
if it **materially changed** (a run-out date moved, a number crossed a threshold). For
rendered messages (below) dedup is inherent: they carry a stable `id` and are re-derived
from current state, so a resolved condition simply stops appearing.

## Persist vs render — the one part that isn't fully two-way

- **Render** (from current state, each load): standing conditions — a run-out still
  approaching, refunds still trending. No rows written; change your mind next week and
  nothing is stranded. **Default to this.** (Horizon heads-ups are rendered.)
- **Persist** (a real row in the conversation): events the merchant may reply to — a move
  proposed, an outcome measured. These become history ("you told me about this Tuesday").
  Persisting shapes **stored data**, so it is the one-way-ish half: changing the shape
  later strands rows a merchant may have replied to. Persist only events, and get their
  shape right the first time — or decide, explicitly, that early rows are disposable.

## Honesty constraints (non-negotiable)

- Every claim comes from real data (the execution ledger, the horizon service), never a
  template. The `✓ markdown applied` checklist was deleted for asserting work regardless
  of what happened.
- **No bare unlabelled money figure.** Relate it to the shop's base currency, or label it
  by currency/market. ~half of merchants are multi-currency, and a cross-currency total is
  refused at source (`commerce-calculations`), so a message may have _no_ single money
  figure — it must read well without one.
- **No dead controls.** A proactive message offers an action only if that action is live.
  A run-out heads-up says "tell me your lead time" today because reorder isn't executable
  yet — it does not show a reorder button.
- Outcome messages will carry a **verdict** (`good | underperformed | neutral`) from the
  measurement lane, not just numbers. Shape the message to hold a judgement from the
  start; retrofitting it into a number-shaped string is annoying.

## How to add a lane (v1)

Expose a **read-only** function returning `{ id, kind, text }[]` — the shape
`getHorizonHeadsUps` uses. It must return `[]` on any error (never throw into the loader,
so it can't 5xx the home). The home loader calls it; `StoreConversation` renders the
results as assistant messages, capped by the budget, at your priority. Keep the ranking
and the never-fabricate guards inside your lane; the home owns placement, budget and the
quiet floor.

Current customers: Horizon run-out / refund heads-ups (`getHorizonHeadsUps`, live).
Queued: store-hygiene fixes (proposable, needs a "want me to draft it?" affordance —
that's a move-shaped message, so it may become a persisted event rather than a rendered
condition), outcome verdicts (persisted events, carry the verdict).
