# Questions for Matt — app redesign (chat 11), overnight build 2026-07-31

Built autonomously while you slept. Decisions I made with a default are marked **[assumed X]** — override any of them.

## Blocking-ish (a default was taken; confirm)
1. **Book a slot → Calendly link.** Gap #3 says wire it to "the real Calendly link" or remove. I don't have the link. **[assumed: render it only if a real URL is configured; otherwise the block is removed, not greyed]**. Give me the Calendly URL + the voice-note upload target and I'll wire both.
2. **Sections-as-routes** (/brief…/settings). The handoff wants real routes for deep-linking. It overlaps chat 2's `app._index` perf-decomposition, so I did **not** do the route-split unilaterally overnight — I restyled in-place on the existing client-side section switch. Confirm who leads the route-split (chat 2?) and I'll adopt.
3. **App-Store-review visible-flip timing.** Handoff says coordinate visible churn with chat 10 + chat 6; neither was reachable overnight. The 4 product-gap fixes are review-*positive* (removes dead SOON buttons, adds honesty). Confirm you're happy the visual restyle shipped, or tell me to hold/gate it.

## Design-detail questions (from the handoff's own "open questions")
4. **"Learning" autonomy label** in the rail for a brand-new store — keep, or show count of categories set to Auto?
5. **Horizon revisit dates** ("revisit ~21 Aug") imply Jefe tracks + returns to them. Real, or does it need building? (I rendered them as honest static text for now.)
6. **30-day reversal window** stated in Settings vs /privacy §7 (shop data hard-deleted ~48h after uninstall). Confirm the copy is correct.

## Notes
- Everything shipped is reversible. Each push was preflight-green.
- No fabricated merchant data: where plain-English/provenance memory data isn't wired yet (needs chat 9), the rebuild shows honest states, not the prototype's Everdew demo numbers.
