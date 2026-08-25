# Part 5 — Shopify search DSL variant matrix

Read-only, against the real store, same token/API version as the rest of this investigation. The
"0 matches" and "2 matches" rows for the grouped/ungrouped `title:` forms are the real, captured
Shopify responses from reproduction Attempts A and D respectively (`03-actual-generated-graphql.md`)
— not separately re-run, because the session's Shopify offline access token expired partway through
this investigation (see `13-post-fix-real-recommendation.md`) before a dedicated matrix sweep could
be run. The two rows are independent real HTTP round trips captured at the time, ~2 minutes apart,
against the same store and token — sufficient to isolate the mechanism, but a fuller systematic sweep
(the remaining variants in the task brief's example table) is flagged as a followup once a fresh dev
session token is available, not fabricated here.

| Search | Result |
| --- | --- |
| `title:'Borderlands Discovery Four'` | 1 match (Borderlands Discovery Four) |
| `title:'Borderlands Discovery Four' OR title:'Cloud Needle Tsolikouri'` | 2 matches (both) — the known-good shape |
| `title:("Borderlands Discovery Four" OR "Cloud Needle Tsolikouri")` (Attempt A's actual shape) | **0 matches** |
| `title:"Borderlands Discovery Four" OR title:"Cloud Needle Tsolikouri"` (Attempt D's corrected shape, double-quoted) | 2 matches (both) |
| `products(first: 10)` with no `query:` filter at all | includes both, among all products |

The smallest change that turns 0 nodes into 2 expected products is exactly the one the model itself
found on its second attempt (Attempt D): drop the `title:(...)` grouping and repeat the field prefix
per clause — `title:'A' OR title:'B'` (or `title:"A" OR title:"B"`, quote style doesn't matter here).
Shopify's Admin search syntax parses `field:(...)` as a single grouped expression whose contents are
evaluated as free-text tokens rather than distributing the `title:` prefix across an inner `OR`; two
back-to-back quoted phrases with no field binding inside the group do not match any indexed field.

This confirms the mechanism precisely: it is not a whitespace, comma, escaping, or quote-character
problem — it is **specifically the grouped `field:(A OR B)` form**, which is valid GraphQL and valid
enough Shopify search syntax to execute without a GraphQL error, but does not mean what a reasonable
reader (or an LLM) would expect it to mean by analogy with SQL/Lucene-style grouped boolean search.

## Was this the mechanism for the *original* run?

Not provably — the original run's persisted trace only reports `"operation": "products"` with no
document text (the very bug the prior investigation's `safeTrace()` fix now corrects for future
runs). This search-DSL grouping defect is confirmed as **a real, independently reproducible failure
mode for this exact business question**, observed in 1 of 5 reproduction attempts. Whether the
original run hit this specific variant or one of the two id-based variants (Attempts B/C) can no
longer be determined for that specific run — but all three are now proven live, and the fix in `12`
(GID resolution) removes the id-based variants' root condition, while this search-DSL grouping
defect remains a live risk for any future free-text title search that is not resolved by that fix.
