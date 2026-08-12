# Answer-quality harness

Runs real merchant messages through the **real chat path** and grades what comes back, so a
change to prompts or reply-building can be measured instead of eyeballed.

It calls `sendConversationMessage` — the same function the Daily Home composer reaches via
the `chat.message` intent — against a locally seeded store whose beliefs were produced by
the real derivation pipeline. Nothing is stubbed except the fixture data itself.

## Run it

```bash
npm run db:up                       # local Postgres on :55432
DATABASE_URL=postgresql://jefe:jefe@localhost:55432/jefe_dev npx prisma migrate deploy
```

```bash
DATABASE_URL=postgresql://jefe:jefe@localhost:55432/jefe_dev node scripts/answer-quality/run.mjs --label before
```

Then make a change and compare:

```bash
DATABASE_URL=postgresql://jefe:jefe@localhost:55432/jefe_dev node scripts/answer-quality/run.mjs --label after --no-seed --baseline scripts/answer-quality/reports/before.json
```

Add the LLM provider env (`LLM_ENABLED`, `LLM_PROVIDER`, `LLM_MODEL`, `GROQ_API_KEY`, …) to
exercise the model path. Without it the harness still runs and grades the deterministic
fallback — which is what merchants actually get whenever the provider fails, so it is worth
measuring in its own right.

| flag | effect |
| --- | --- |
| `--label <name>` | names the run and its report file |
| `--baseline <path>` | prints a per-check diff against an earlier report |
| `--no-seed` | reuse the already-seeded stores (much faster) |
| `--archetype <key>` | one store only |
| `--scenario <key>` | one scenario only |
| `--asOf <iso>` | pin the fixture clock |

**Local database only.** The harness writes conversation rows; `assertLocalDatabase` refuses
any non-local host so a replay can never land in a real merchant's thread.

## Why it looks like this

**Multi-turn, not single-shot.** The failure the founder hit hardest was Jefe answering turn
3 as though turns 1 and 2 never happened. A one-shot bench cannot see that, so every scenario
is a thread replayed in order into one conversation.

**Two unlike businesses.** `dtc-skincare` (online-only, costs tracked) and
`garden-centre-pos` (POS-heavy, almost no costs). Generic advice is the failure mode, and it
is only visible by comparison — the `comparative` scenarios grade the *pair*, flagging two
very different businesses that got the same answer. The 2026-08-12 baseline scored
`similarity(margin-honesty) = 100%`: both stores received a byte-identical non-answer.

**Deterministic graders.** No model in the loop, so the same reply scores the same forever
and a movement is a real change rather than a judge's mood. `broken` means the merchant is
looking at something Jefe should never say; `poor` is defensible but bad. The headline
`internal_rationale_leak` check works by identity against `operation.reason` rather than by
phrasing, so it keeps catching the defect however the wording drifts.

## Baseline, 2026-08-12 (historical)

Recorded before the reason/merchantReply split and the thread fix landed, and before two
grader refinements (identity-leak no longer fires when `reason` and `merchantReply` are
deliberately the same string; a "which…?" reply now counts as a real clarifying question).
So treat these as the record of what the defects looked like, **not** as a number to diff a
current run against — re-record a fresh baseline before measuring a change.

```
57 broken, 12 poor (penalty 126) across 22 turns
  18  internal_rationale_leak
  12  unanswered_question
  11  unrelated_open_question
   8  third_person
   7  canned_non_answer
```

`reports/` is gitignored — reports carry generated replies and are reproducible, so they
belong on the machine that ran them, not in the repo.

## Adding to it

A scenario is a thread plus what a competent reply must do (`scenarios.mjs`). Mark a turn
`refersToPrior` when it is only meaningful in context — that is the amnesia probe, and a
reply asking the merchant to re-explain fails it automatically. Archetypes live in
`fixtures.mjs`; a new one needs a catalogue, an order volume, a cost-coverage share and a POS
share, and the derivation layer does the rest.

Everything in `fixtures.mjs` is invented. Never seed this from a production database — a
harness fixture carrying real trade puts real business detail in the repo.
