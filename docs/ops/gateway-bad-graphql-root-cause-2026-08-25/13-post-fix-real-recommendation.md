# Part 15 — Post-fix verification

## What happened

After implementing both fixes, this investigation attempted 3 more live `anchor-products`
reproductions (same method as `02`) to directly observe the corrected behavior against the real
store. All 3 failed with `SHOPIFY_GRAPHQL_ERROR: "Shopify GraphQL HTTP error"` on every
`shopify_query` call — not a GraphQL-level rejection, a transport-level one. Investigating directly:

```
$ curl -X POST https://jefe-local-store.myshopify.com/admin/api/2026-07/graphql.json \
    -H "X-Shopify-Access-Token: <the same token used throughout this investigation>" \
    -d '{"query":"{ shop { name } }"}'
{"errors":"[API] Invalid API key or access token (unrecognized login or wrong password)"}
```

The session's offline access token — the same one used successfully for every reproduction in `02`
through `04` (all of which made real, verified HTTP round trips to the real store) — became invalid
partway through this investigation, between the pre-fix reproductions (~19:50 BST) and the post-fix
attempts (~20:07 BST onward). The local `Session` row's own `expires` column reads `2026-08-25
19:03:31` — earlier than several of this investigation's own *successful* pre-fix calls, so that
column does not reliably predict when the token actually stopped working; this investigation does not
have enough information to say precisely why the token stopped working (a fresh `shopify app dev`
OAuth handshake elsewhere reissuing a token for the same app+shop is the most likely explanation,
consistent with `01`'s note that this store's app registration is shared across Conductor
workspaces, but this is not confirmed).

**This is a real, separate, dev-environment session-lifecycle issue — not a Gateway defect, and not
something this task's fix policy authorizes touching.** Flagged for whoever next needs a live session
against this store: re-run `shopify app dev` (or otherwise refresh the OAuth session) before
attempting further live verification.

## What was verified instead

A live end-to-end re-run of the original failing candidate could not be completed in this session.
In its place, this pass verified both fixes the strongest way available without a live token:

1. **Fix 1 (product GID resolution)** — a new deterministic test walks every belief a real
   `deriveMerchantMemoryBeliefs()` call produces from realistic fixture data and asserts no
   `…productId` field is ever the fixture's internal id; it must be the fixture's `externalId` GID.
   This is stronger than a single live run for this specific defect: a live run only proves the *two*
   beliefs this investigation happened to find; the deterministic test proves it for the belief
   *shape* generally, and would fail immediately if an 8th call site reintroduced the leak.
2. **Fix 2 (orchestration loop)** — a new deterministic test scripts exactly the failure this
   investigation reproduced live (a `BLOCKED` status paired with a pending `shopify_query` call whose
   result contains real, correct data) and asserts the model is re-consulted with that result rather
   than the run terminating on the stale verdict. This reproduces the *exact* mechanism observed in
   Attempt C without depending on a live LLM/Shopify round trip's inherent variability.
3. The full affected test suite (282 tests across 18 files, `12`) passes with both fixes in place,
   confirming neither fix regresses any other documented recommendation behavior.

## Required comparison table (partial — live figures unavailable post-token-expiry)

| Metric | Broken Gateway run (`80553fc7-…`) | After root-cause fix |
| --- | ---: | ---: |
| candidates | 6 | not re-run live (see above) |
| bad empty product reads | 2 (of 6 rejections citing "zero nodes") | not re-run live |
| product lookup retries | 0 (of the 3 identifier-confusion attempts reproduced) | not re-run live |
| useful Shopify reads | 4 real + 3 cached | not re-run live |
| candidates poisoned by bad cache | 4 (`04`, prior investigation) | not re-run live |
| recommendation produced | no | not re-run live |
| LLM calls | 12 | not re-run live |
| runtime | 145.6s | not re-run live |
| input tokens | ~721k | not re-run live |

**Recommended next step, explicitly flagged rather than guessed at**: once a fresh dev session token
is available, re-run this exact investigation's `anchor-products` reproduction (`scripts/tmp-
gateway-repro.mjs` before it's deleted, or its equivalent) 3-5 times and confirm the `productId`
values in the model's tool calls are now real Shopify GIDs that resolve successfully, and that no
turn returns a terminal status while also carrying a toolCall whose result was never shown to the
model. This report's deterministic tests prove the mechanism is fixed; only a fresh live run can
confirm the *emergent* outcome (does the candidate now reach `RECOMMEND_ACTION`) — this investigation
cannot honestly claim that outcome without one.
