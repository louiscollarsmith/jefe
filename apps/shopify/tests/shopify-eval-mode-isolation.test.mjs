import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";
import { buildOpportunitySurface } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { executeShopifyOperation } from "../app/lib/shopify/api/gateway.server.js";

// `assumeAllScopesGranted` exists for controlled capability evaluation only (task: "what could
// Jefe discover and propose if permissions were not the constraint"). These tests prove the
// two halves of that contract: it visibly changes discovery-time opportunity availability, and
// it has no path at all into the gateway that actually executes writes — not "defaults to
// false," but structurally absent as a concept the gateway understands.

test("assumeAllScopesGranted changes which families buildOpportunitySurface reports as available", () => {
  const catalog = loadShopifyApiCatalog();
  const noScopes = buildOpportunitySurface(catalog, []);
  const withoutFlag = noScopes.families.filter((family) => family.capabilityState === "available");
  assert.equal(withoutFlag.length, 0, "holding no scopes should leave no family available");

  const assumed = buildOpportunitySurface(catalog, [], { assumeAllScopesGranted: true });
  const withFlag = assumed.families.filter((family) => family.capabilityState === "available");
  assert.ok(withFlag.length > 0, "the eval-mode flag should surface families a real merchant without scopes could not reach");
});

test("assumeAllScopesGranted never makes a PROHIBITED or UNSUPPORTED_SEMANTICS operation look available", () => {
  const catalog = loadShopifyApiCatalog();
  const assumed = buildOpportunitySurface(catalog, [], { assumeAllScopesGranted: true });
  for (const family of assumed.families) {
    for (const op of family.writeOperations) {
      if (op.executionStatus === "PROHIBITED" || op.executionStatus === "UNSUPPORTED_SEMANTICS") {
        assert.notEqual(
          family.capabilityState === "available" && op.scopeSatisfied && op.executionStatus === "PROHIBITED",
          true,
          `${op.operation} is PROHIBITED and must never read as scope-satisfied-and-available`,
        );
      }
    }
  }
});

test("the gateway has no parameter or branch that honors an eval-mode assumption — real scopes are always live-checked", async () => {
  const prisma = { merchantAction: { findFirst: async () => null }, shopifyOperationCall: { create: async () => ({}) } };
  const client = {
    requests: [],
    async request(document) {
      this.requests.push(document);
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [] } }; // no scopes granted, live
      }
      return {};
    },
  };
  // Pass the flag anyway, as if a caller mistakenly forwarded it — the gateway must ignore it,
  // because it never destructures or reads any such field from its input.
  const result = await executeShopifyOperation({
    prisma,
    client,
    merchantId: "00000000-0000-0000-0000-000000000001",
    shopId: "00000000-0000-0000-0000-000000000002",
    shopDomain: "jefe-local-store.myshopify.com",
    operation: "products",
    variables: { first: 1 },
    grantedScopes: ["read_products"],
    // @ts-expect-error — deliberately not part of executeShopifyOperation's contract.
    assumeAllScopesGranted: true,
  });
  assert.equal(result.ok, false, "the live scope check must still deny — the flag must not leak into execution");
  assert.equal(result.status, "NEEDS_SHOPIFY_AUTHORIZATION");
});

test("the production recommendation-service module never references assumeAllScopesGranted", () => {
  const path = fileURLToPath(
    new URL("../app/lib/shopify/agentic-runtime/recommendation-service.server.js", import.meta.url),
  );
  const source = readFileSync(path, "utf8");
  assert.equal(
    source.includes("assumeAllScopesGranted"),
    false,
    "the eval-mode flag must not exist in the production DB-writing service layer at all — only in the lower-level pure functions an eval script calls directly",
  );
});

test("gateway.server.js never references assumeAllScopesGranted", () => {
  const path = fileURLToPath(new URL("../app/lib/shopify/api/gateway.server.js", import.meta.url));
  const source = readFileSync(path, "utf8");
  assert.equal(source.includes("assumeAllScopesGranted"), false, "the gateway must have no concept of this flag");
});

test("a prohibited operation stays denied even with every real scope granted and an accepted Action", async () => {
  // Simulates the maximal real-world case the eval flag is not needed for: a merchant who
  // genuinely granted every scope, with a fully accepted Action. Prohibition is permanent and
  // independent of scope or approval — this is not what assumeAllScopesGranted is for, and
  // this test intentionally never touches that flag.
  const prisma = {
    merchantAction: {
      findFirst: async () => ({
        id: "action-1",
        merchantId: "00000000-0000-0000-0000-000000000001",
        shopId: "00000000-0000-0000-0000-000000000002",
        status: "accepted",
        plan: {},
        progress: {
          agentic: {
            currentActionRevision: "rev-1",
            acceptedActionRevision: "rev-1",
            outcome: "Uninstall the app as part of an accepted cleanup Action.",
          },
        },
      }),
    },
    shopifyOperationCall: { create: async () => ({}) },
  };
  const client = {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      return {};
    },
  };
  const result = await executeShopifyOperation({
    prisma,
    client,
    merchantId: "00000000-0000-0000-0000-000000000001",
    shopId: "00000000-0000-0000-0000-000000000002",
    shopDomain: "jefe-local-store.myshopify.com",
    actionId: "action-1",
    acceptedActionRevision: "rev-1",
    operation: "appUninstall",
    variables: {},
    grantedScopes: ["read_products", "write_products"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "DENIED_PROHIBITED_OPERATION");
});
