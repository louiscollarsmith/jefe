# Part 6 — API-version / schema strategy

## Pinning

`SHOPIFY_API_VERSION` (currently `2026-07`, `.env`) remains the single source of truth for which
Admin API version Jefe targets, exactly as today. `loadGatewaySchemaIndex()` reads `apiVersion` from
whatever catalogue snapshot it's built from; `buildSyntheticGatewayStub()` stamps every gateway-built
stub with the same version used to construct the ctx, so `gateway.server.js`'s existing
`stub.apiVersion !== apiVersion` guard applies to gateway-executed mutations exactly as it does to
catalogue ones.

## What "schema hash / fetched at" metadata already exists

The generated catalogue header carries `apiVersion`, `generatedAt`, and `generatedFrom` — there is no
separate content hash field beyond that. `loadGatewaySchemaIndex()` surfaces these unchanged
(`index.generatedAt`, `index.generatedFrom`) rather than inventing a parallel metadata scheme.

## Regeneration path — unchanged, and this is the point

`npm run shopify:api:generate -- --shop=<dev>.myshopify.com --token-env=ENV_NAME` (or
`--introspection=path/to/schema.json`) already does everything Part 8 asks for: fetch, rebuild,
report a diff. The gateway's schema index is a thin read layer over that same generated artifact —
regenerating it for a new API version requires no gateway code changes and no manual per-operation
work, because the gateway never encodes per-operation knowledge; classification is structural
(`domain-taxonomy.server.js`, `mutation-safety.server.js`), not looked up from a table that needs
updating when Shopify adds an operation. This is demonstrated directly, not just argued: the
adversarial test "an operation absent from the local catalog snapshot still gets a real,
non-dead-end classification" fabricates an operation name that has never existed in any Shopify
catalogue and gets a correct, real classification from it.

## Release-candidate CI testing

Not implemented this session. The task asks to "investigate" this, not build it — findings: Shopify
publishes release-candidate schemas ahead of each quarterly stable cutover (`01-research.md`), so a
CI job that runs `shopify:api:generate --introspection=<rc-schema>` against a downloaded RC schema
and diffs it against the pinned catalogue is mechanically straightforward using existing tooling.
Not built here because it requires deciding where the RC schema artifact comes from in CI (Shopify
does not appear to publish a stable download URL for RC introspection dumps in the sources checked;
this would need a dev-store RC-pinned app to introspect against, which is infrastructure setup beyond
this experiment's scope).

## Never auto-advancing to unstable

No code path in this design reads an "unstable" version by default; `SHOPIFY_API_VERSION` is an
explicit, human-set env var, same as today.
