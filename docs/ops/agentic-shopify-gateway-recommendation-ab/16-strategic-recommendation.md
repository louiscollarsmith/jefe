# Part 16 — Strategic recommendation

## `CONTINUE_DUAL_TRACK`

## Why not `PREFER_GATEWAY`, given Gateway won this round

The win is real and the cause is understood (`13-candidate-quality-comparison.md`): Gateway
recommended a grounded, well-constrained collection action from real inventory/collection data,
using fewer Shopify calls and less wall-clock time, while Catalogue's rejection of the same
underlying opportunity traced to a specific, reproducible weakness in its server-side stub-binding
relevance search — not to a general Shopify-investigation weakness. That's evidence Gateway
*avoids* one real failure mode Catalogue has today, not evidence Gateway is generally more capable.
n=1 per surface cannot distinguish "Gateway is systematically better" from "this specific candidate
happened to hit Catalogue's specific weak spot." Two more things argue against declaring a winner
yet: (1) two real bugs were found in the Gateway wiring itself during this very session
(`15-remaining-limitations.md` #1 and #6) — a code path that needed a same-day fix to produce a
trustworthy result is not yet a code path to bet the recommendation pipeline on; (2) Gateway has
never been exercised through `execution-agent`/`verification-agent`/`action-chat` at all — this
report is about investigation quality only.

## Why not `KEEP_CATALOGUE`

Catalogue's loss wasn't close or ambiguous: it had the right evidence (real Shopify reads
confirming the shallow-basket problem) and the right operations existed in its own catalogue
(`collectionCreate`/`collectionAddProducts`, both `EXECUTABLE_WITH_CONFIRMATION`) — its
architecture simply failed to connect the two, for a document reproducible reason unrelated to this
specific merchant or LLM run. That is a real, structural weak point in the current production path,
not a Gateway talking point. Recommending "keep catalogue, unchanged" would mean shipping that
false-negative pattern indefinitely without even investigating whether it recurs.

## What actually changes this decision

1. **More real runs**, same methodology, ideally across multiple merchants — enough to know whether
   today's result generalizes or was a lucky/unlucky draw for each side.
2. **Fix the catalogue's stub-binding relevance search** (`15-remaining-limitations.md` #3) and
   re-run the same candidate — if Catalogue reaches the same collection recommendation once given
   the right stubs, that specific case stops being a Gateway differentiator and the comparison
   narrows to cost/complexity/maintainability instead of recommendation quality.
3. **A cooling-off period on the Gateway integration code** — enough real runs without a same-day
   bug fix to trust the wiring itself, independent of which architecture wins.
4. **A decision on the redundant-read inefficiency** (`15-remaining-limitations.md` #2) — cheap to
   fix, worth doing before broader rollout regardless of which way this goes.

## Scoring against the brief's explicit criteria, honestly

| Criterion | This session's evidence |
| --- | --- |
| Recommendation quality | Gateway won this run; root cause specific to Catalogue's binding search, not proven general |
| Evidence quality | Equal — both grounded every conclusion in real Shopify reads or specific Merchant Memory figures |
| GraphQL reliability | Promising on 2 real documents (`14-graphql-reliability-assessment.md`) — too small a sample for a production reliability claim |
| Safety | Equal — 9 new integration-level tests + 20 standalone tests, all passing; structural, not prompt-based, in both cases |
| LLM/tool call count | Gateway used fewer Shopify calls this run (4 vs 16) — same n=1 caveat |
| Token cost | Not separately isolated per-candidate this session; total run tokens weren't the controlled variable — needs a dedicated measurement pass |
| Latency | Gateway ~1.7 min vs Catalogue ~4.5 min this run — promising, same caveat |
| Implementation complexity | Gateway's integration required 3 subtle hardcoded-tool-name bugs to be found and fixed in one session — real complexity cost, not zero |
| API-version maintainability | Gateway's structural classification advantage (proven in the prior session: an operation absent from any catalogue snapshot still classifies safely) is real and unaffected by this session's results either way |
| Debugging/auditability | Equal — both produce a full toolResults ledger; Gateway's raw GraphQL documents are arguably easier to audit directly than a catalogue operation name + variables |

## Bottom line

Gateway is not being kept alive here because it's architecturally elegant, and Catalogue is not
being kept because it already exists — Gateway earned continued investment by finding and closing a
real gap in Catalogue's own architecture, in a fair, same-conditions test, while simultaneously
proving it isn't yet mature enough (found bugs, single validated run, zero execution-path testing)
to replace what's live in production today.
