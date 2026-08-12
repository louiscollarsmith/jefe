# Fleet handover — 2026-08-12

Written by the coordinating session as ~13 lanes were archived and the fleet
narrowed. Everything below is lane state at archive time. Read
`CLAUDE.md` first — the working agreements and product model that used to live
in session context are now in it.

## Why the fleet was narrowed

Thirteen lanes were spun up for a **reclaim exercise**: a human (Louis) had
committed alone 2026-08-06→08-11 and his home rewrite orphaned a lot of
agent-built surface. That exercise is finished. Its rulings are recorded in
`docs/ops/reclaim-arbitration-2026-08-12.md` and in `CLAUDE.md`.

What replaced it is a much narrower goal: **close the core loop** — a merchant
opens Jefe, is told something true and specific about their store, with
something to do about it, and can talk to it. Most lanes were building
adjacent to that rather than on it.

---

## Lane state at archive

### App home / composer
Shape B shipped (`2879ae9`): the home is one conversation, moves and outcomes
render as messages, two zoom levels, no dashboard sections. Also landed:
composer clears on send, opens at latest message, multi-line composer,
heads-ups feed, brand logo, hydration fix (loader-computed date in the store's
timezone).
**Open:** chat failure state — a timed-out message vanishes silently, no error,
merchant's text lost, no retry. Highest-value open item on the surface.
**Also open:** instruct-path rendering (a recommendation with no execute path
must read as substantial, not degraded), outcomes feed uncapped, possible
gear/header overlap top-right, left-rail index of moments (sketch first —
moments not messages, and never a thread picker).

### Answer quality / recommendations
Found the root cause of poor replies: the main chat was a **stateless belief
classifier with no analyst and no history**, while the action chat in the same
file did it properly. Fixed the narration leak (`21ef35b`). Built a harness at
`apps/shopify/scripts/answer-quality/` — extend `scenarios.mjs`, don't rebuild.
**Open and important:** whether the home composer posts into the `memory`
topic. Matt's store had exactly one conversation, `topic: "memory"` — if the
home is talking to the memory-capture interpreter rather than an analyst, that
is a plumbing bug and no prompt work fixes it. One test message settles it.
**Open:** measuring against the 222 real merchants in Quiver's Redshift
warehouse (sanctioned: *"you can use quiver data, but quiver's engineering work
is separate"*). Corpus stays in its isolated DB; never commit a real merchant's
numbers.

### Memory / ontology
`renderBeliefStatement` returns null for ~130 of 139 beliefs, so the memory view
degrades to raw metric names and proposals would too. **This gates the action
layer** — unbinding proposals before statements exist means Jefe recommends
things phrased `Order Value Mean To Median Ratio · Trailing 90d`.
Landed: price spread, delivery reach, buying mode (`fa6394b`) — the first
business-shape beliefs. Forget-by-typing with working undo.
**Open:** diagnose whether the statement gap is missing templates or a shape
change; write statements for the merchant-facing set; continue the tranche
(channel mix, retention window, customer-base shape), tagged by provenance —
derivable-from-Shopify / askable / derivable-from-a-connected-integration.

### Architecture / spine
Holds `docs/ops/reclaim-arbitration-2026-08-12.md`, the action contract, the
canonical-number ruling (**the belief is canonical**), the door rule, the gate
rewrite. Landed: serialized pushes + merge lock, DB pool cap, environment
precheck, `.nvmrc` pinned to 20.
**Open:** the **registry audience field** (merchant-facing / internal /
model-only) — two lanes are blocked on it, and 19 `category: "data"` beliefs are
our ingestion diagnostics that must never reach a merchant. Also: plan-level
guardrails for composed writes (blast radius across a sequence, reversibility of
the whole, a preview a merchant understands), and the currency correction.

### Action ontology
Audit at `docs/ops/action-ontology-audit-2026-08-12.md`. Direction changed twice
and the final position is in `CLAUDE.md`: **no registered actions.** Propose is
always yes; execute is capability-gated; where there is no safe path, Jefe
instructs. Guardrails move from named actions to write primitives.
**Open:** "the ten things Jefe could tell a typical merchant today" from the
belief audit — no new data, no new adapters. That list is the content brief the
loop depends on. Then unbind proposals belief-by-belief as statements land.

### Observability
Landed: `/health` reports the serving provider, 401/403 fallback-eligible,
provider registry (Kimi K3 dark until keyed), Gemini fallback moved off the
quota-exhausted model.
**Found and unresolved by that lane:** ~40% of conversation turns were dying on
an 8s timeout against ~6k-token prompts. `LLM_TIMEOUT_MS` was raised to 45000 in
Railway and **verified in effect** (container restarted). `DEFAULT_LLM_TIMEOUT_MS`
in `config.server.js` is **still 8000** — a fresh environment inherits the bug.
**Open:** raise that default; re-measure the failure rate; confirm
`LLM_FALLBACK_MODEL=gemini-3.1-flash-lite` is a real model; check automated alert
routes point at #jefe-slack.

### Channels / inbound email
Slack callbacks fixed and pointing at `/app/settings?panel=channels`. Inbound
email intact and dark.
**Open and merchant-facing:** that panel is still a scaffold, so a successful
Slack connect lands on "this section is being built". Also: bounce/complaint
capture (no outbound Resend event capture exists) — this is a **precondition of
the win-back campaign flip**. Slack parity with the in-app chat: same brain, one
thread, never a second bot — `lib/email/inbound/service.server.js` is the
precedent.
**Note:** 0 `business.tool_stack` beliefs exist across both production stores, so
the integrations panel would ship showing nothing detected.

### Onboarding
Matt's ruling: **animate the waiting, keep the asking real.** Only Connect is
genuine input; the three "Continue" gates are candidates for deletion, not
animation. Blocked on a recent-window backfill phase (fetch ~5k recent orders
first so insights run in seconds). `historyKind` already lets Jefe state its
scope honestly — "across your last 5,000 orders since March".
**Louis now owns onboarding** — he shipped `88f402c` (fast-value onboarding) and
`849cdd3`. Coordinate rather than duplicate.

### Growth / lifecycle
Scopes disclosure shipped across privacy, early-access, front door, DPA
(`0119040`). Matt kept all scopes; the durable fix for review exposure is
shipping actions that use them.
**Open:** onboarding email sequence (insight-led, paced on lifecycle signals),
offboarding campaign — **dormancy is the valuable new trigger**, uninstall's
day-0 email already exists. The reinstall bug: `welcomeEmailSentAt` is set once
forever, so churn-and-return never re-onboards; fix on reactivation but gate on
~30 days or an evaluator installing three times gets three welcomes.
**Blocked:** win-back campaign — the live day-0 email promises "no emails after
this one" and the already-churned cohort has already received it. Matt has three
options and has not ruled.

### Smaller lanes (work landed, nothing outstanding)
- **Horizon** — `getHorizonHeadsUps` landed, wired into the home as a feed.
  `horizonNear` (run-out dates, refund projection) still renders nowhere.
- **Store tidy-up** — scan, route and tests live; no consumer. Proposal was to
  surface findings in the conversation, selectively (a finding in the chat spends
  the merchant's attention and Jefe's credibility).
- **Autonomy roster** — panel landed and reachable. Two modes locked by test.
- **Memory correction** — composer-first correction landed; back link and
  diagnostics filter landed `bd47706`.
- **Model testing / Quiver** — harness + Redshift connection; handover at
  `docs/ops/model-testing-quiver-handover-2026-08-12.md`. **Its finding reversed
  two lanes' work**: stored money is shop-base currency and always summable;
  `order.currency` is the *presentment* code.

---

## Traps worth inheriting

- **Stale local checkout.** The shared `/Users/mb/Claude/jefe` checkout runs ~90
  commits behind. A docs edit made there and copied into a worktree silently
  reverted a founder instruction. Edit in a worktree cut from current `origin/main`.
- **Empty `node_modules`** makes `npx` fetch Prisma 7 and reject the fine 6.x
  schema with `P1012`. Looks exactly like a broken schema. `npx prisma --version`
  to tell them apart; `npm ci` in your own worktree.
- **A rejected push usually isn't contention** — read the hook output before
  retrying. Twice today a real error was mistaken for a lost race.
- **Reachability tests can pass on a blank page.** A `lazy` boundary with a null
  fallback satisfies "reached". Assert the view *produces content*.
- **CI alerts arrive out of order** relative to commits. Check the verdict on the
  tip, not the newest alert.
