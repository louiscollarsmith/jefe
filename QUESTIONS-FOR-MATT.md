# App redesign (chat 11) — overnight build 2026-07-31

Built + shipped autonomously while you slept. This is the morning read: what landed, what the sessions already settled, and the (short) list that needs you.

## What shipped (green, on `main`)
- The full **13a app-home redesign** as a self-contained module `apps/shopify/app/components/app-home/*` (register · primitives · data · six sections · shell) + a public **`/app-home-13a`** preview route (the `/cinematic`·`/daily` pattern, illustrative "Everdew" data). Commits `1781839` (module+preview) and `2e6b1b5` (adoption doc).
- All six sections verified against the prototype: Brief · Queue · Horizon · Memory · Goals · Settings.
- **Nothing merchant-visible changed** — the live `daily-home.tsx` is untouched. Everything is reversible and honest (no fabricated data; honest fallbacks where real data isn't wired).
- **View it:** `https://app.mynamejefe.com/app-home-13a` (redeploying from the push).

## Settled overnight by the sessions (FYI — no action needed)
- **Live flip timing → HOLD until App Store review clears (~2wk) or your explicit nod** (chat 10, architecture). The preview is safe now; flipping the live home mid-review adds a variable a reviewer could re-open, for no upside.
- **Sections-as-routes → chat 2 leads** (it's their `app._index` perf-decomposition); I restyle within the routes they carve. Post-review.
- **App-Bridge nav trim (app.tsx) → chat 10 owns**, downstream of the routes. Post-review.
- **Memory data → chat 9 shipped 3 of 4 fields** (authorship/provenance/confirm-state, verified against my module); the plain-English `statement` pass is chat 9's next piece. Full adoption wiring is in `docs/ops/design_backend_backlog.md` §"Memory adoption wiring".
- **The 3 SOON badges → removed** (chat 2 confirmed remove-don't-wire); in the new design the rail's feedback is a real mailto.
- **Adoption is one coordinated post-review sequence:** chat 2 routes → I restyle → chat 10 nav → wire Memory intents + statement + gap feed with chat 9.

## Needs you (short)
1. **Click through `/app-home-13a`** and either confirm the hold-till-post-review plan, or tell me to flip sooner. (Recommendation from architecture: hold.)
2. **Calendly link + a voice-note upload target** — to restore "Book a slot" / "Record" when built. Until then they're removed (no greyed-out dead buttons).

## Design-detail questions (from the handoff's own open list — low priority)
3. **"Learning" autonomy label** in the rail for a brand-new store — keep, or show count of categories set to Auto?
4. **Horizon revisit dates** ("revisit ~21 Aug") imply Jefe tracks + returns to them. Real, or needs building? (Rendered as honest static text for now.)
5. **30-day reversal window** stated in Settings vs /privacy §7 (shop data hard-deleted ~48h after uninstall). Confirm the copy.
