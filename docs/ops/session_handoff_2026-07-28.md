# Session handoff — 2026-07-28 (late)

Resume point for the next context window. The conversation summary carries the narrative; this file carries the exact git/agent state + plan.

## Shipped + deployed (prod, DB-tested)
- Front-end: cinematic **dark onboarding reskin** (flag `ENABLE_CINEMATIC_ONBOARDING`, edge-to-edge verified) + real Jefe mark (inverts on dark) + Instrument Serif fonts; **Daily Home multi-section app** (Brief/Queue/Horizon/Memory/Goals/Settings). `/cinematic` extended with Home+Chat scenes.
- Backend hardening (all from `docs/ops/backend_code_review_2026-07-28.md`): line-item revenue bug; numeric grounding; **GDPR compliance webhooks + PII-null migration (LIVE, founder-approved)**; Daily Home loader perf; belief JSON polish.

## In working tree, UNCOMMITTED — done + agent-verified, need integration
1. **Recommendation loop** — `app/services/shopify-backfill-worker.server.js` (`ensurePostOnboardingRecommendationsQueued`, gated on `onboardingCompletedAt`) + `tests/shopify-ingestion.test.mjs` + a CHANGELOG "### Changed" entry. Post-onboarding memory rebuild refreshes Plan+Goals, snapshot-cached. 148/148 in its scope.
2. **GitHub Actions CI** — `.github/workflows/ci.yml` (postgres service + migrate deploy + full gate, Node 20). Activates on first push.

## Email MVP — DONE (landed, 13/13 tests), UNCOMMITTED in tree
- `app/lib/email/*` (adapter `resend.server.js` `ENABLE_EMAIL`-gated = no real send by default; `template.server.js`; `welcome.server.js`; `templates/jefe-welcome.html`), `tests/email.test.mjs`, `app/shopify.server.ts` (afterAuth trigger, idempotent via new col), `prisma/schema.prisma` + migration `20260728210000_welcome_email_sent_guard` (adds nullable `shops.welcome_email_sent_at` — **REVERSIBLE**, safe to ship), `.env.example` (email section), `CHANGELOG.md`, `package.json`/`lock` (resend@^6). Never sends real email until `ENABLE_EMAIL=true` + key + verified domain.

## ALL THREE WAVE AGENTS DONE — tree settled, ready for ONE clean integration
Recommendation loop + CI + Email MVP are all in the working tree, verified in their own scopes. Do the clean DB-gated gate (command below), then commit as 3 logical commits + push. Both new migrations in tree: GDPR one is already committed+deployed; the email `welcome_email_sent_guard` is reversible → ship freely.

## Integration plan (do once email MVP lands + tree settles)
```
cd apps/shopify && export DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=integrate_test" \
 && npx prisma migrate deploy && npm run typecheck && npm run lint && npm test && npm run build
```
Then commit selectively (recommendation loop; CI; email MVP as separate logical commits) → `git push` (activates CI + deploys). **Founding rule: reversible → push freely; irreversible (destructive migration / one-way door) → confirm with Matt first.**

## Roadmap / next
- **Email system (I own all the code):** 9 templates + **sequencing engine** (day-based + conditional "sequence replaces brief" + utilisation ladder) + **`/e/unsubscribe`** page + notification-preference model + `List-Unsubscribe`. **Host the inverted logo**: compose lockup from the mark (`favicon.svg`: rect `#33456b`, J `#f8ece7`, dot `#c98a8a`) → PNG → `apps/shopify/public/email/jefe-lockup-inverted.png` (Vite serves `public/`) → point templates there. All behind `ENABLE_EMAIL`.
- **Facts-non-confirmable / always-live** (Matt's steer): deterministic facts are never surfaced for confirmation + always recompute; only *inferences* get confirm/correct. Adjust the conversational belief registry + memory view; thread detail into `context/03_memory_lifecycle.md`. (Principle already in `context/01_product_principles.md`.)
- **Remaining hardening:** job-race fixes (worker terminal-write guard on `status:running` + union re-enqueue categories + partial unique index migration); visible-memory provenance (surface confidence/source/lastEvaluated in `getMerchantMemoryView`); token encryption at rest (session-storage wrapper — **keep the write scopes**, they're intentional).
- **2 open product Qs** (Matt to decide): Plan cadence refresh (quiet stores show stale move); multiple recommendations / queue (schema change).
- **Go-live gates for Thursday onboarding:** fresh-store end-to-end dry-run; real-store install path (unlisted app — needs a live non-dev store from Matt); App Store submission (privacy-policy URL + listing copy/screenshots — Matt; compliance webhooks done).

## Key ops facts
- **Local DB tests:** `cd apps/shopify && npm run db:up` (colima/docker; container `jefe-shopify-postgres` on 55432), then `export DATABASE_URL=...schema=<name>` before `npm test`. Full suite is green with the DB. Give each parallel agent its own `schema=`.
- **DesignSync MCP** reads the Claude Design project `4652e7f9-7cd8-4cd3-adc4-886752fb8175` — pull any brand/design asset directly (no zips). Can't chat the Design *agent*; new-asset requests go via Matt.
- **Resend:** `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (`matt@mynamejefe.com`) set in Railway `jefe` service. No Resend MCP connected (not needed — app uses the SDK). Blockers before first real send: DKIM for mynamejefe.com (Matt), logo host (me), reply-to. Email designs at `scratchpad/emails/design_handoff_jefe_emails/`.
- **Deploy:** push to `main` → Railway `jefe` service builds + `prisma migrate deploy`. Confirm live via `railway status --json | grep <sha>` (the `jefe` service; ignore `jefe-shepherd`/`jefe-marketing`) + health 200.

## Principles reinforced this session
Reversible → ship; irreversible → discuss. Facts are shown, not checked; inferences are checked. The truth changes, so we change what we show.
