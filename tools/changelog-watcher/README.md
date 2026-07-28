# changelog-watcher

Polls the changelogs of the external APIs, SDKs and MCP servers Jefe depends on, and reports **what's new since the last run** — flagging entries that read like breaking changes or adaptation work (`deprecated`, `removed`, `api version`, `webhook`, `scope`, …). The point: know what upstream drift we need to adapt to *before* it silently breaks a merchant's onboarding.

Operator tool — lives outside `apps/shopify`, no product-runtime coupling. Zero dependencies (Node built-in `fetch`).

## Usage

From the repo root:

```bash
npm --prefix tools/changelog-watcher run watch          # poll + report new entries
npm --prefix tools/changelog-watcher run init           # baseline: record current state, no alerts
npm --prefix tools/changelog-watcher run watch -- --source shopify,mcp-spec
npm --prefix tools/changelog-watcher run watch -- --json
npm --prefix tools/changelog-watcher run watch -- --dry-run   # don't persist state or write a report
```

State is stored in `output/state.json`; each run also writes `output/report-<timestamp>.md`. A run only alerts on entries not seen before, so the first run per source **baselines** (records current entries without alerting).

Set `GITHUB_TOKEN` in the environment to raise the GitHub API rate limit for `github-releases` sources.

## Sources

Configured in [`sources.json`](sources.json). Each source is one of three types:

| type | how it works | best for |
|---|---|---|
| `rss` / `atom` | parse the feed's `<item>`/`<entry>` list | anything with a real feed (e.g. Shopify) |
| `github-releases` | GitHub Releases API for `owner/repo` | SDKs and MCP servers |
| `html` | fetch the page, hash the text, alert when it changes | pages with no feed (coarse: "the page changed, go look") |

Per-source `watch: [...]` keywords, plus the global `relevanceKeywords`, decide which new entries get the ⚠️ "likely adaptation work" flag.

**Confirmed working:** `shopify` (RSS), the `github-releases` sources.
**Best-effort / verify the URL:** the `html` sources (Klaviyo, Meta, Slack, Recharge, ShipStation) — some are JS-heavy SPAs and need a more specific endpoint or a real feed. A few are `enabled: false` pending URL confirmation.

## Adding a source

Append to `sources.json`:

```json
{ "id": "stripe", "name": "Stripe API changelog", "type": "html",
  "url": "https://stripe.com/docs/changelog", "watch": ["deprecat", "removed"], "enabled": true }
```

## Roadmap (v2)

1. **LLM relevance pass** — for each ⚠️ entry, ask the model "does this touch anything Jefe actually calls?" against a manifest of our used endpoints/scopes/webhooks, and draft the adaptation task. (Reuse the app's Gemini config.)
2. **Notify** — post the report to Slack (Jefe already has a Slack channel integration) or open a GitHub issue per relevant change.
3. **Schedule** — run daily via Railway cron; persist `state.json` on a volume (local file state doesn't survive ephemeral deploys).
4. **Endpoint manifest** — enumerate the Shopify GraphQL fields, scopes and webhook topics the app uses, so relevance is precise instead of keyword-based.
