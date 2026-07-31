# Observability & BFS-monitoring handover — 2026-07-31 (overnight)

Written overnight by the observability session (chat 8) while Matt slept, per his
"build + do the next 5 things, save all questions for the morning." Everything
reversible was shipped to `main` (prod) through the worktree → preflight → push
discipline; nothing red landed. **The decisions that need Matt are collected at the
top — start here.**

---

## ☕ Morning questions / decisions for Matt

### 1. LCP optimisation (3140ms → the ≤2.5s BFS bar) — now data-driven, one aesthetic call pending
I shipped the *measurement* (Web Vitals tracking, incl. **TTFB**), so this is no
longer a guess: once real-user data accrues, **LCP vs TTFB** tells us whether the
3140ms is —
- **server-bound** (high TTFB → the heavy `app._index` loader — the perf session's
  active decomposition lane, so I'd coordinate there, not collide), or
- **render-bound** (fonts/CSS in `root.tsx`).

The render lever needs *your* call: `root.tsx` loads two render-blocking external
stylesheets (Shopify Inter + a Google Fonts request pulling **4 families**).
Making them async is a real LCP win **but** reintroduces a flash-of-fallback
(FOUT) on your deliberate cinematic type — and reverses the in-code note where you
concluded to "load them normally" after the stuck-loading investigation. **I did
not touch it.** My recommendation: let the data land a day or two, then pull the
lever it points to. If you'd rather I just do the async-font change, say so and
I'll ship it with the FOUT tradeoff understood.

### 2. ✅ BFS Web Vitals targets — CONFIRMED overnight (was a question, now resolved)
Chat 6 confirmed the BFS bar: **LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75 over a
trailing 28-day window with ≥100 measurements** ("Pass with 100+ calls"; p75 ≤
threshold ≡ "≥75% of loads good"). My placeholder targets already matched — I've
encoded the 100-sample minimum (`BFS_MIN_SAMPLES`, `apps/ops/format.mjs`).
**Reality check: LCP 3.14s > 2.5s → we are NOT CWV-qualifying on LCP yet** (INP
40ms and CLS almost certainly pass). Same signal as #1; the ops "Web Vitals · BFS"
panel will show 🔴 on LCP once ≥100 loads accrue. Webhook delivery has **no** BFS
target (kept as our own app-health bar, not labelled BFS).

### 3. Settings / guardrails surface — needs a product scope from you
The welcome email's "change my limits" link is still a **stopgap deep-link**
because that page doesn't exist yet. Building it needs your call: *which* limits to
expose (spend caps? the per-action-type autonomy dial? notification prefs?) and
**enforce server-side vs. display-only**. Held — it's a product decision, not an
autonomous ship.

### 4. Deferred monitoring (traffic-gated) — a judgment call I made, flag if you disagree
With ~no merchant traffic yet, I consciously did **not** build these — they'd be
inert now, and standing up alerting subsystems for absent traffic is over-machinery
("best part is no part"). They're ready to build the moment merchants are active:
- worker page on a **BFS Web-Vitals p75 breach** (the panel already *grades*; this
  is the proactive alert),
- **webhook success-rate historical trend** (the live degradation alert already
  exists; this is historical visibility),
- an **error-rate trend sparkline** (the panel already shows Errors 24h / Fails 7d).

---

## ✅ What shipped this session (all on `origin/main`, CI-green, verified live)

| Change | Commit |
|---|---|
| PII/secret redaction hardening (nested Errors + token scrubbing) | `589cb90` |
| `handleError`→Sentry policy extracted + tested | `a2f7040` |
| Observability runbook brought current | `f89070c` |
| **Ops-panel re-gate (OPS_PUBLIC removed) + PII access logging** — App-Store pre-submit gate | `0bf4f04` |
| **Web Vitals tracking** (App Bridge → ops panel + Slack) | `4812a4b` |
| **Webhook-delivery health monitoring** (our-side + pager) | `f0350c3` |
| **Ops-panel "Web Vitals · BFS"** (p75/28d vs targets) | `5391647` |
| **TTFB tracking** (LCP breakdown enabler) | `7cda0cd` |

Also: verified the alerting chain end-to-end, confirmed the webhook 65.5% was
**historical** (0 webhook errors in Sentry 7d/30d), coordinated throughout with
chats 6 & 10, and updated memory (secret-scanning push protection, ops
deploy-from-worktree, the PAT decision).

## 📊 Current monitoring state (what's live)

- **Web Vitals:** LCP/INP/CLS/TTFB from real users → `activity_events` (topic
  `performance`) via `/api/web-vitals` (401-gated, embedded-only reporter). Ops
  panel **"Web Vitals · BFS"** grades p75/28d (currently "accumulating").
- **Webhook health:** `/health.webhooks` (received/ok/failed/slow/success-rate);
  worker pages #jefe-slack on **sustained** degradation; a one-off slow webhook
  (delivery-timeout risk) WARNs.
- **Ops panel** (`admin.mynamejefe.com`): password-required (OPS_PUBLIC removed) +
  a PII-safe access log (`ops_access`: who/what/outcome/when).
- **Errors:** `handleError` → Sentry (benign-filtered via `isBenignForSentry`) +
  #jefe-slack + `activity_events`; ops panel shows Errors 24h / Fails 7d.
- **Sentry:** server + client DSNs live; issues → #jefe-slack via Better Stack.
- **Uptime:** Better Stack pings `/health` → #jefe-slack.
- **CI:** failures → #jefe-slack; schema-drift hard-gate; pre-push preflight.

## 🛡️ BFS / App-Store readiness audit (fresh pass, 2026-07-31)

Ran Shopify's own pre-submission review (`shopify-app-store-review`) over the
codebase. **Result: 0 failures · 28 likely-passing · 3 ⚠️ needs-review · 10 groups
N/A.** Strong structural posture — App Bridge v4, session-token embedded auth,
GraphQL-only Admin API, managed App-Store install, and the 3 mandatory GDPR webhooks
all wired with HMAC verification. **No code fixes needed.** The 3 ⚠️ are
listing/pricing/install *decisions* (yours / chat 6's) — adding them to the questions
above:

- **2.3.1 Install from a Shopify-owned surface (highest priority).** Two shop-domain
  entry forms exist (`app/routes/_index/route.tsx`, `app/routes/auth.login/route.tsx`)
  — but they serve the *standalone* surface + existing-merchant sign-in; the canonical
  App-Store install is Shopify-managed (`AppDistribution.AppStore`). **Confirm the
  listing's install path is the managed one** so a reviewer never lands on a
  myshopify-entry form. If unsure, gate those routes off the install path.
- **3.2.1 `read_all_orders` justification.** The scope is genuinely needed (>60-day
  history for memory/analytics — the code shows the fallback + a belief noting it).
  **Ensure the listing states this rationale** (approval is off-code, in the Partner
  Dashboard).
- **1.2.1 Bill through Shopify.** No Billing API anywhere — fine **if Jefe is free**.
  **Confirm the pricing/free claim**; if any paid tier is planned it must use Shopify
  Billing.

(Can't be checked from code: the live TLS cert on `jefe-production.up.railway.app` —
config is HTTPS-only, so ✅ on that basis. Chat 7 ran this same review at submission;
this re-run reflects the changes made since — still clean.)

## 🔧 Notes for the next agent

- **Discipline:** work in a worktree off `origin/main`; `bash scripts/preflight.sh`
  green before every push; explicit-path staging; the tree is shared by ~8 sessions
  and moves ~1 push/min, so use the rebase→preflight→push retry loop.
- **Secret-scanning push protection is ON** — assemble any secret-shaped test
  fixtures at runtime, never as literals (see memory `jefe-secret-scanning-...`).
- **Ops-panel deploys** (`jefe-ops`, not GitHub-auto): `railway up -p
  1bc2fec5-9380-4c7f-a3a2-2f1e28061d69 -s jefe-ops -e production` from the
  worktree's `apps/ops`; the swap lags ~2–3 min; content-verify.
