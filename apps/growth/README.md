# apps/growth

Growth infrastructure + commercial tooling for Jefe (owned by chat 6). **Separate from `apps/shopify`** (the product) so it never collides with product work — same separation as `apps/marketing`.

Strategy + baseline live in [`docs/growth/`](../../docs/growth/) (read `commercial-state.md` first).

## What's here (v0)

- **`src/icp-scoring.server.js`** — pure, dependency-free ICP **triage**: scores `waitlist_signups` rows for *chase priority* and lists what still needs human qualification. Unit-tested (`node --test`).
- **`scripts/pipeline-report.mjs`** — reads `waitlist_signups` from Neon and prints the ranked Design Partner pipeline.

**Triage, not qualification.** A waitlist row only gives us email + store URL. This ranks who to chase first and flags missing info; confirmed ICP fit (GMV ~$1–20M, single-market, hands-on operator) is a call/enrichment step, per `docs/growth/commercial-state.md` §2.

## Run

```bash
cd apps/growth
npm test                        # pure logic, no DB, no install needed to test

npm install                     # only needed for the DB report
npm run pipeline -- --counts    # PII-free tallies (safe to share)
npm run pipeline                # full list (contains emails/PII — internal only)
npm run pipeline -- --json
```

Set `DATABASE_URL` (or `DATABASE_PUBLIC_URL`) to the Neon project holding `waitlist_signups`. **Use a read-only credential**; for prod use the public proxy URL, not the internal host.

## Data / PII

- `--counts` emits only aggregate tallies (no emails or store handles) — the shareable/loggable form.
- The default full report contains prospect emails; keep it internal. Never push prospect PII to third-party tools without review (see `docs/growth/growth-stack.md`).

## Next

Join in product signals (install → onboard → **activate**) from chat 3's `ProductEvent` stream so the pipeline shows who actually activated — the one thing an off-the-shelf CRM can't. Optional Airtable/Notion mirror if a clickable board is wanted.
