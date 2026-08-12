# Coordinating session — handover, 2026-08-12

You are taking over the **coordinating lane**. It does not own a slice of the
codebase. It holds the whole picture, drives the other lanes, reports to Matt,
and — this matters — **builds directly when lanes stall**.

Read `CLAUDE.md` first. Most of what used to live in this session's head is now
in it: the action model, two-mode autonomy, do-or-instruct, the queue rule,
self-continuation, branches, changelog routing.

## What this lane actually does

1. **Verify before reporting.** Matt is making fast product calls off what you
   tell him. Check `origin/main`, check live `/health`, check the database.
   Never report from a local checkout — it runs ~90 commits behind.
2. **Drive the lanes.** They stop after each turn unless self-looping. A
   recurring check every 10 minutes (`CronCreate`, session-only — **recreate it**,
   the old one dies with the previous session) that nudges idle lanes holding
   open items.
3. **Route with a recommendation attached**, never an open question. Matt would
   rather be argued with than silently implemented around.
4. **Build directly when lanes don't.** Several of today's shipped fixes came
   from this lane because the owning lane produced nothing for an hour. Don't
   spend the day reporting the same open items.

## Fleet as of handover

**Four lanes live:** architecture (holds the arbitration doc and contracts),
answer-quality (routing diagnostic + Redshift harness), memory/ontology (belief
statements), app home (the conversation surface).

**Twelve archived** — state in `docs/ops/fleet-handover-2026-08-12.md`.

## The goal, narrowed

**Close the core loop:** a merchant opens Jefe, is told something true and
specific about their store, with something to do about it, and can talk to it.

Open items, in dependency order:
1. **Chat failure state** — a timed-out message vanishes silently. No error, the
   merchant's text lost, nothing to retry. Highest-value visible fix.
2. **Registry audience field** (merchant-facing / internal / model-only) — blocks
   the statement work.
3. **Belief statements** — `renderBeliefStatement` is null for ~130 of 139
   beliefs. **Gates the action layer**: unbind proposals before this and Jefe
   recommends things phrased `Order Value Mean To Median Ratio · Trailing 90d`.
4. **The routing diagnostic** — does the home composer post into the `memory`
   topic? Matt's store had one conversation, `topic: "memory"`. If the home talks
   to the memory-capture interpreter rather than an analyst, that is a plumbing
   bug and no prompt work fixes it.
5. **The ten things Jefe could tell a typical merchant today** — from the belief
   audit, no new data, no new adapters. The content brief the loop depends on.
6. **Unbind proposals**, belief-by-belief as statements land.
7. `DEFAULT_LLM_TIMEOUT_MS` is still 8000 in code (prod env is 45000 and verified).

## Louis

A human co-founder committing to the same repo. **Watch and work around him.**
Six commits on 2026-08-12: fast-value onboarding, duplicate app bar, memory
transaction timeout, Groq fallback timeout, embedded home speed, worker cascade.
**He owns onboarding now.** Most of his ~70 branches are stale merged PR
branches — only flag ones with commits in the last 24h. Lanes work on branches
and merge when green, specifically so his tree stays clean.

Two people independently found our prompts are too large — his 413 payload
handling, and the 8s timeout against ~6k-token prompts. That convergence has not
been chased down and probably should be.

## Mistakes this lane made today — do not repeat them

- **Attribution.** Credited Louis with agent-built work, then credited a lane
  with Louis's fix. Read `%an`; don't infer from who you routed a task to.
- **Stale checkout.** Edited `CLAUDE.md` in the shared checkout and copied the
  whole file into a worktree — silently reverting a founder instruction added an
  hour earlier. Edit in a worktree cut from current `origin/main`.
- **Wrong test advice.** Asked for a "reachability" test; it passed while the
  page rendered nothing, because a `lazy` boundary with a null fallback satisfies
  "reached". Assert the view *produces content*.
- **Solved the wrong problem.** Spent effort making markdown work without cost
  data when the answer was that markdown shouldn't be the centre of gravity.
- **Over-asked.** Held two-way doors for permission and stalled lanes. If it is
  reversible and contained, ship it.

## How Matt works

- Wants **honest** over reassuring. "Nothing moved" beats padding.
- Corrects framing sharply and is usually right — take the correction, don't
  defend.
- Rules fast and expects propagation everywhere, including into the docs.
- Judges the product by **opening the app**. Anything that makes it look broken
  outranks anything architectural.
- Changelog to **#jefe-slack** (`C0BKHSV5FHB`), never #eng-matt, with the commit
  SHA in the footer, posted only once verified live.

## Immediately outstanding

- **Changelog owed** for `bd47706` (memory view: back link + diagnostics filter).
  Merchant-visible, needs posting once serving.
- **Recreate the 10-minute fleet check** — it died with the previous session.
- The four live lanes have queues and self-continuation loops. If they produce
  nothing in the next cycle, the problem is structural — build the items yourself
  rather than sending another round of nudges.
