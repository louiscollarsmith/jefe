# Fleet coordination — sequential pushes + mutual awareness

Matt's directive (2026-08-12): *"find a way for all lanes to work together and for
pushes to be sequential, and for them to understand what each other are doing."*

~15 Claude lanes share one working tree and (until now) pushed straight to `main`.
That produced ref-lock races, red main from two lanes landing conflicting changes
at once, and no way for a lane to know another was already editing the same file.
This is the mechanism that fixes all three. It is deliberately **local and
low-infra** because the whole fleet shares this one machine's filesystem today; the
durable cross-machine form is worktree-isolation + a GitHub merge queue (task #24),
and `merge.sh`'s contract is identical either way, so adopting it now costs nothing
when the queue lands.

## 1. Pushes are sequential — `scripts/merge.sh`

**The only way to land a change. Never `git push origin HEAD:main` directly.**

```bash
bash scripts/merge.sh "one line: what I'm landing"
```

It: rebases onto `origin/main` and runs the **full preflight BEFORE** taking the
lock (the slow part runs in parallel across lanes) → acquires a **merge-lock** that
only one lane can hold → re-syncs (in case main moved while queued), re-verifies
(risk-based: full preflight if the incoming commits touch your files, fast check if
not) → pushes → records the landing → releases the lock.

Because only the lock-holder pushes, there are **no ref-lock races** and **no two
lanes landing in the same instant**. The critical section is short (re-sync + fast
verify + push), so the queue drains quickly even with 15 lanes waiting.

The lock is an atomic `mkdir` under the shared common git dir
(`$(git rev-parse --git-common-dir)/lanes/merge-lock.d`), visible to every worktree.
A crashed lane can't deadlock the fleet: a lock held **> 10 minutes** is treated as
stale and stolen automatically, with a warning.

## 2. Understand what each other are doing — `scripts/lanes.sh`

```bash
bash scripts/lanes.sh working "refactor the analyst" app/lib/a.js app/lib/b.js
bash scripts/lanes.sh board            # what every lane is working on right now
bash scripts/lanes.sh touching <path>  # which lanes have declared this file
bash scripts/lanes.sh log [N]          # the last N landings (from the ledger)
bash scripts/lanes.sh idle             # clear my focus when done
```

Each lane writes only its **own** board entry, so there's no contention. The board
answers *"is anyone else already in this file?"* — the semantic-conflict case a
merge queue can't prevent, only awareness can. The **ledger** (`log`) is the
serialized record of what landed and when, written automatically by `merge.sh`.

## The rules (all lanes)

1. **Push only via `scripts/merge.sh "note"`.** Never raw `git push …:main`.
2. **Before editing a shared/hot file** (`app._index.tsx`, `shopify-derivations`,
   the action spine, `preflight.sh`), run `lanes.sh board` / `lanes.sh touching <file>`.
3. **When you start a piece of work**, `lanes.sh working "…" <files>`; `idle` when done.
4. **Set `JEFE_LANE`** to your lane's name (e.g. `export JEFE_LANE=chat-5`) so the
   board and ledger read clearly. Defaults to the worktree's directory name.

## Scope + evolution

- **Today (this doc):** local merge-lock + board. Fits the one-machine fleet, needs
  no new infrastructure, works now.
- **Durable form (task #24, Matt-chosen):** worktree isolation (own `node_modules`
  per worktree, no symlink) + branch-based PRs + the full gate in CI + a GitHub
  merge queue for cross-machine-safe serialization. `merge.sh`'s contract
  (serialized, gated, recorded) is the bridge to it — same discipline, so lanes
  adopting `merge.sh` now won't have to relearn anything when the queue lands.
