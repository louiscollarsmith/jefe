# Part 0/1 — Runtime provenance: was this really the Gateway?

## Why this has to be proven, not assumed

The immediately preceding investigation
(`docs/ops/gateway-second-action-no-action-forensics/`) was invalidated for exactly this reason: a
different Conductor workspace ("riyadh", branch `louiscollarsmith/gpt-5.6-luna-call-failures`) had
silently taken over the shared Shopify App URL tunnel and served the request that investigation was
analyzing, without any visible indication in the UI. This task's Part 0 exists to stop that from
happening twice.

## What was checked

| Item | Value |
| --- | --- |
| Workspace | `/Users/louis/conductor/workspaces/jefe/accra` (this is also what `gateway-experiment` and `apps/shopify` resolve to — `gateway-experiment` is a symlink to `accra`, not a separate checkout) |
| Branch | `louiscollarsmith/gateway-experiment` |
| Commit | `773a713ddf4ce3c94590d29271d3b8a8596582f7` ("Agentic Shopify Gateway: sole production Shopify agent tool surface, catalog dispatcher removed") |
| `git status` | clean, only the untracked `docs/ops/gateway-second-action-no-action-forensics/` from the prior investigation |
| Process, at investigation time (~19:20 BST) | **no** `shopify app dev` / react-router-dev process running from `accra` |
| Other running dev process | `riyadh` (`/Users/louis/conductor/workspaces/jefe/riyadh`), PID 36817 (`shopify app dev`) continuously running since **13:26 BST**, on commit `a413c9218fd09a9258469253307a838de6a0592c` — the commit immediately *before* Gateway became the sole tool surface |
| `.shopify` CLI state dir mtime (accra) | **2026-08-25 19:02:57 BST** — touched ~2 minutes before this run's `queued_at` |
| Shared local Postgres | both workspaces point at `postgresql://jefe:jefe@localhost:55432/jefe_dev` — same database, confirmed via `.env` in both checkouts |
| `client_id` in `shopify.app.toml` | identical (`c7d72018569103d47cc8dffb3980e89a`) in both `accra` and `riyadh` — both workspaces develop against the same Shopify app registration, so whichever workspace's `shopify app dev` most recently started owns the App URL for both |

So process inspection *alone*, right now, actually points at `riyadh`, the same workspace implicated
last time. That is not a coincidence to wave away — it's the reason the rest of this section relies
on stronger evidence than "which PID is currently alive."

## The decisive evidence: code fingerprint, not process list

The Agentic Shopify Gateway's tool surface (`shopify_schema` / `shopify_query` /
`shopify_prepare_mutation` / `shopify_execute_mutation`) lives at
`app/lib/shopify/gateway/tools.server.js`, introduced alongside a `gateway/` directory that does not
exist at all on `riyadh`'s checked-out commit:

```text
$ ls riyadh/apps/shopify/app/lib/shopify/gateway/
No such file or directory

$ ls accra/apps/shopify/app/lib/shopify/gateway/
document.server.js  schema-cache  schema-cache.server.js  schema-index.server.js
synthetic-stub.server.js  tools.server.js
```

And the string `shopify_query` (the Gateway's read tool name) does not appear anywhere in `riyadh`'s
`app/lib/shopify/agentic-runtime/` tree at all — its `recommendation-agent.server.js` still defaults
`discoveryToolName`/`readToolName` to the catalog dispatcher's `"retrieve_shopify_operations"` /
`"call_shopify_operation"` (line 1427–1428 of that file, present in both checkouts as a legacy
fallback), and nothing in `riyadh` overrides that default the way `accra`'s
`recommendation-agent.server.js:325-326` does (`SHOPIFY_GATEWAY_TOOL.schema` /
`SHOPIFY_GATEWAY_TOOL.query`, unconditional — no fallback parameter left in `accra`'s call site at
all).

This run's persisted `result_json.trace.toolResults` (see `raw/target-run-result.pretty.json`)
contains:

- `"tool": "shopify_query"` — **4 times** (real reads) plus 3 more `ALREADY_AVAILABLE` cache hits
  under the same tool name
- `"tool": "recommendation_validation"` — 2 times (belief-id repair turns, unrelated to Shopify I/O)
- `"tool": "retrieve_shopify_operations"` — **0 times**
- `"tool": "call_shopify_operation"` — **0 times**

It is structurally impossible for `riyadh`'s checked-out code, as it exists right now, to produce a
trace containing `"tool": "shopify_query"` for a recommendation run — that tool name and the module
that emits it do not exist in that checkout. The only two other real checkouts on this machine
(`lusaka`, commit `987f0c7b…`, and `vientiane`, commit `c5da776…`) predate the Gateway work entirely
and have no `gateway/` directory either.

## Reconciling this with the tunnel-ownership risk

The most coherent explanation, consistent with every piece of evidence above: the founder started a
fresh `shopify app dev` session in `accra` at ~19:02:57 BST (the `.shopify` CLI state touch),
temporarily re-asserting `accra`'s tunnel as the App URL for the shared `client_id`, ran the "Generate
a proposal" test at 19:04:45–19:07:11 BST against that session, and the session has since ended
(no accra process remains). `riyadh`'s dev server never restarted (PID 36817 has run continuously
since before 13:26) so it never re-asserted its own tunnel in between — it is simply the
last-remaining-alive process now, which is a coincidence of what's still running, not evidence of
what served this one completed request.

**This is still the same infra risk the prior report flagged** (recommendation carried forward
unchanged into 13-ranked-root-causes.md): two workspaces sharing one Shopify app registration and one
local Postgres makes "which branch actually answered" something you have to forensically reconstruct
after the fact rather than read directly off a running process. It happened to be provable here
because the code fingerprint is unambiguous; it will not always be.

## Verdict

**CONFIRMED PURE GATEWAY: YES**, on code-fingerprint evidence (decisive) corroborated by CLI-state
timing (circumstantial but consistent). No `retrieve_shopify_operations`/`call_shopify_operation`
calls, no catalogue fallback, and the run's belief-id-repair loop
(`tool: "recommendation_validation"`) is Gateway-only machinery introduced in this same branch's
lineage.
