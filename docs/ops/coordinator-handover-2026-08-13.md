# Coordinating session — handover, 2026-08-13 (00:15)

Written at the end of the 2026-08-12 session, the night before Jefe onboards its **first
paying client**. Supersedes `coordinator-handover-2026-08-12.md`, which is still worth
reading for how Matt works — that part has not changed.

Read `CLAUDE.md` first. This file is state, risk and judgement; the working agreements are
in there.

## The things that need Matt

Nothing else on this list matters as much.

1. **The ops panel has NO LOGIN — deliberately, and it is NOT a task.**
   `admin.mynamejefe.com` serves **cross-merchant** data to anyone with the URL. Matt asked
   for the gate off (2026-08-12 ~22:30); I argued against it twice and was overruled, and on
   2026-08-13 he reaffirmed it: **leave it for at least 2-3 weeks.** This is an accepted
   exposure with a revisit date (~early September), not an oversight. **Do not keep raising
   it, and do not restore it as a tidy-up.**
   If the decision is ever re-made: delete `OPS_AUTH_DISABLED` and its branch in
   `apps/ops/server.mjs` — `OPS_PASSWORD` is still set in Railway, so it is a code change
   only. It will need a manual deploy (see the traps).

2. **`LISTING_COPY_EXECUTE_ENABLED` — nobody has checked it.** `listing_copy` became
   proposable in production tonight (`60aeb91`). If that flag is set, a merchant gets a live
   Approve button on a write path **never exercised in production**. If unset, the proposal
   renders as an instruction and nothing can be written. The code defaults off and it is not
   in `.env.example`, but I do not read production env — so it is unverified, and the
   consequence is asymmetric. Ten-second check in Railway.
3. **Does the client's store have cost-per-item?** This decides the shape of day one and
   nobody knows the answer. `dead-stock-clearance.server.js:159` skips any variant with
   `unitCost == null`, and `clearance-adapter.server.js:68` fails closed without a verified
   cost floor. **No costs ⇒ clearance cannot fire ⇒ Jefe proposes nothing executable** and is
   advisory-only. That is not a bug — never selling below cost is the point — but it means
   the first session is a different conversation depending on the answer.

## What is live that was not this morning

All verified serving, not merely merged. Twelve commits from this lane:

| What | Commit |
|---|---|
| A failed message says so and retries without duplicating | `931a54c`, re-fitted `b52978c` |
| The home chat remembers the conversation | `4731e82` |
| Merchant Memory can be opened again | `a10a07f` |
| Beliefs declare who they are for (`merchant`/`internal`/`model`) | `3dbbc66` |
| Belief statements 5 → 18 of 114 | `ba22a01`, `134988f` |
| The health check stops reporting the worker dead while importing a store | `853a690` |
| A non-executable move reads as advice, not a broken control | `4dd5c55` |
| The cost invitation reaches merchants who never open Memory | `9b1efb0` |
| The ten things Jefe can tell a merchant today (doc) | `c527954` |

The memory/ontology lane built a **complete second action type** in one evening —
`listing_copy`: registry, adapter, resolver, execute wire, binding (`d4923b4`, `0e0fdf6`,
`232a3a8`, `60aeb91`). Best work in the fleet. Execution still behind its flag.

Louis shipped fourteen commits, every one with tests, including the holistic memory
architecture (`e74ea64`, PR #81) that closed the analyst-routing gap this lane had flagged as
the biggest hole in the loop.

## Traps this session hit, so you don't

- **`/health` `version` does NOT prove the running code.** `buildHealthPayload(env =
  process.env)` reads `RAILWAY_GIT_COMMIT_SHA` per request; `uptimeSeconds` is real
  `process.uptime()`. A fresh SHA beside a LARGE uptime means you are probably hitting two
  instances mid-rollout. **Treat a deploy as verified only when the new SHA appears with a
  SMALL uptime, confirmed by a second poll a minute later.** I described my verification as
  stronger than it was for several hours before catching this.
- **`jefe-ops` does not auto-deploy.** Its last deploy before tonight was **31 July** — it had
  been running two-week-old code. Pushing to main does nothing for it. Deploy with
  `railway up --service jefe-ops` **from a standalone copy of `apps/ops`**: run from the repo,
  Railpack analyses the repo root, finds no `package.json`, and the build fails.
- **`git` pathspecs are relative to cwd.** Running `git rev-list --count ... -- apps/shopify/…`
  from inside `apps/shopify` silently returns 0. It cost me a false "no overlap" once.
- **A blank grep is not a finding.** Twice a command errored (bad glob, sandbox) and returned
  nothing, which reads exactly like "clean". **Use a positive control** — when I checked the
  new listing-copy wire had no callers, I confirmed the same grep DID find the clearance
  wire's caller.
- **Source-level assertions trip on your own comments.** Three tests failed because the
  comment explaining a removed string contained the string. Filter comment lines, or match the
  rendered form.
- **Verify red before green.** Every fix here was checked to FAIL against the unpatched tree.
  `tests/daily-chat-retry.test.mjs` stayed green through a regression that deleted the entire
  UI half of the feature, because it only exercised server functions.

## Fleet

**All four lanes were stopped at the time of writing**, trees clean, nothing unpushed.
Architecture and answer-quality died ~16:05 and never came back — several of my "lane is idle"
reports were actually "session is dead", because I was checking worktrees rather than
`isRunning`. Check both.

Two lanes had hours of work invisible from outside today. The answer-quality harness sat
untracked in a temp directory for four hours; the memory lane's cadence-band commit sat
unpushed with a dead session until I pushed it to
`origin/claude/optimistic-edison-0092e5` for safety. **Check worktrees on disk, not just
branches.**

## Honest state of the open items

- **Statements: 18 of 114.** The next tranche is the `orders` group (AOV, order counts, basket
  size). Diminishing returns — this will not decide whether tomorrow works.
- **#7 "unbind proposals" is mostly already true**, and my earlier framing of it was wrong.
  `merchant-plan/candidates.server.js` never consults `ACTION_REGISTRY`, and the plan prompt
  explicitly says *"never let the availability of an action change which recommendation you
  choose"*. What remains is the instruct path's **steps** — Jefe gives the reasoning but not
  "here's how to do it yourself", and there is no source for those. That is part 9 of the
  action contract and wants a declared instruction path per action type.
- **Answer quality is unmeasured on the current build.** The only baseline —
  57 broken / 12 poor across 22 turns — predates the entire memory rewrite. The harness is at
  `apps/shopify/scripts/answer-quality/` and `1f0726a` pointed it at the live chat. Running it
  needs LLM keys; without them it grades the deterministic fallback only.
- **A registered-but-unbound action type returns `unsupported`
  (`action-resolution.server.js:439`) and I could not find where that routes to the instruct
  path** rather than vanishing. Per the no-dead-ends invariant it should say something.
- **CI has never been visible to this session** — the GitHub connector is unauthorised. Every
  commit today was backed by the pre-push preflight (typecheck, lint, tests, build), which is
  real but is not CI. Do not report CI green; say you cannot see it.

## The thing nobody did

**No one has walked the merchant journey end to end.** Install, onboard, ask three questions,
open Memory, approve something. Everything verified today was static — types, tests, health
endpoints — and today changed the memory layer, the chat path, the belief gate, the worker and
the action spine.

It needs Matt's Partner access, which is why it did not happen. **It is still the single
highest-value hour available**, and it is worth doing before a paying client does it for us.
