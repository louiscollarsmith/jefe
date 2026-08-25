# Part 1 — Official Shopify capability/MCP research

Researched 2026-08-25 via web search and direct fetches against shopify.dev and github.com/Shopify.
Confidence is marked per claim — this area moves fast and search results include low-quality
secondary sources; anything not corroborated against a primary Shopify source is flagged as such
rather than stated as fact, per this repo's Product Truth discipline.

## Admin GraphQL schema / introspection

**Observed fact (verified directly against this repo, not just search):** live introspection
against the real Admin GraphQL API works today for an authenticated app — Jefe's own catalogue
generator (`apps/shopify/scripts/shopify-api-generate.mjs`) does exactly this: sends a full
`__schema` introspection query through `ShopifyAdminGraphqlClient` against a real shop with a real
admin token, and gets back all 810 current operations. This directly answers the open research
question about whether introspection is available on the live endpoint: yes, for an authenticated
app against its own installed shop.

There is no evidence of a separately published, always-current raw schema artifact outside of
introspection itself — GraphiQL for the Admin API (`shopify.dev/docs/api/usage/api-exploration/admin-graphiql-explorer`)
is the documented interactive path; programmatic schema retrieval is introspection.

## API version lifecycle

**Observed fact (shopify.dev, corroborated by two independent search results):**
- New stable version released quarterly (dates: `2026-01`, `2026-04`, `2026-07`, `2026-10`).
- Each stable version supported a minimum of 12 months, with ≥9 months overlap between consecutive
  versions.
- Three version classes: stable, release candidate, unstable.

This directly informs `06-api-version-schema-strategy.md`: one pinned stable version in production,
release-candidate testing in CI is feasible (Shopify publishes release-candidate schemas ahead of
the stable cutover), never auto-advancing to `unstable`.

## Shopify Dev MCP

**Observed fact (github.com/Shopify/dev-mcp is the canonical repo; direct fetch of it 404'd through
the read-only web fetch tool used, so this section leans on search-result synthesis and is marked
accordingly):**
- Runs locally via `npx @shopify/dev-mcp@latest`, no shop authentication required to start it.
- Exposes documentation search, Admin GraphQL schema exploration, Polaris/Functions/Hydrogen docs,
  and CLI command help — a **developer-time reference and docs tool**, not a request-time
  production dependency.
- Positioned throughout for IDE/agent coding-assistant use (Cursor, Claude Code, Windsurf), not for
  an installed merchant app to call at runtime on behalf of a live store.

**Conclusion for this design:** Shopify Dev MCP is appropriate for *developer* schema/docs discovery
(a human or coding agent building Jefe), not as Jefe's production runtime dependency for querying a
merchant's actual store. Jefe's gateway uses Shopify's pinned Admin GraphQL schema directly (via
introspection, same mechanism the existing catalogue generator already uses) rather than depending
on an external MCP process being reachable from Jefe's production servers.

## Storefront MCP / Customer Account MCP / Checkout MCP

**Unconfirmed — flagged, not used in this design.** Search results describe four MCP servers
(Storefront, Customer Account, Checkout, Dev) shipped by Shopify, gated behind Plus-merchant
settings for the non-Dev three. None of the sources examined describe these as usable by a
third-party installed app to execute arbitrary **Admin API** mutations on behalf of a merchant —
they are storefront/customer/checkout-scoped, a different surface from what Jefe needs (Admin API
writes like inventory/pricing/collections). Not relevant to this design; noted for completeness
since the task brief asked about them explicitly.

## "Official merchant Admin MCP that executes arbitrary authenticated Admin mutations on behalf of an installed app" — the key open question

**This is the most important finding in this section, and it does not support what one secondary
source claimed.** An initial web search summary asserted specific tool names
(`shopify_admin_graphql_preview_mutation`, `shopify_admin_graphql_execute_mutation`) as part of an
open-sourced "Shopify AI Toolkit." A direct fetch of the primary source
(`github.com/Shopify/Shopify-AI-Toolkit` and `shopify.dev/docs/apps/build/ai-toolkit`) **could not
corroborate those tool names or that runtime-mutation capability**. The primary source instead
describes: documentation search, code validation for GraphQL, and "store execute capabilities
through the CLI" with **the developer choosing when to execute** — i.e., a human-in-the-loop,
build/dev-time tool, not a production request-time MCP an installed app calls autonomously.

**Conclusion: no official Shopify-run Admin MCP that executes arbitrary authenticated mutations on
behalf of an installed app at runtime was found in official documentation.** This is exactly the
gap the Agentic Shopify Gateway fills for Jefe — Jefe owns this execution surface itself, on top of
Shopify's schema as source of truth, per the task's own fallback instruction ("If it is not suitable
as a production runtime dependency, use Shopify's pinned Admin GraphQL schema directly").

## What Shopify officially provides today (summary)

| Capability | Provided by Shopify | Suitable for Jefe's production runtime |
| --- | --- | --- |
| Admin GraphQL API + live introspection | Yes | Yes — this is what the gateway uses |
| Quarterly-versioned, 12mo-supported stable API versions | Yes | Yes — pin one version |
| Shopify Dev MCP (docs/schema/CLI search) | Yes | Dev-time only, not fetched at request time by Jefe's servers |
| Storefront/Customer Account/Checkout MCP | Yes (Plus-gated) | Not applicable — wrong API surface |
| An Admin MCP that runs arbitrary mutations for an installed app | **Not found in official docs** | N/A |
| OAuth scope metadata on schema fields | No (verified: 0 scope hints across 810 introspected operations, `domain-taxonomy.server.js` header) | Jefe infers scope from domain + name pattern, as it already does |

## What Jefe still needs to own

Everything past "get the schema": the request-time discovery tool surface, GraphQL AST validation,
structural risk classification, blast-radius/preview/confirmation/idempotency, the execution ledger,
and API-version pinning discipline. This matches the existing `agentic-runtime` architecture's
division of responsibility — the gateway changes *how the model composes GraphQL*, not who owns
safety and execution.
