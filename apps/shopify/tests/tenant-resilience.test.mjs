import assert from "node:assert/strict";
import test from "node:test";
import { ensureShopifyTenant } from "../app/lib/ingestion/shopify/tenant.server.js";

// Regression guard for the 2026-07-31 review-time incident: a Shop with a
// dangling merchantId (Merchant deleted/never-linked, DB FK not yet enforced)
// made `ensureShopifyTenant` 5xx EVERY request/webhook for that shop, incl.
// app/uninstalled. It must now self-heal (relink a fresh Merchant), never throw.

function mockPrisma({ merchant, status = "active" }) {
  const shopRow = {
    id: "shop1",
    merchantId: "gone-merchant",
    platform: "shopify",
    shopDomain: "app-review.myshopify.com",
    status,
    setupStatus: status === "uninstalled" ? "uninstalled" : "installed",
  };
  const calls = { merchantCreate: 0, shopUpdate: [], connectorUpsert: 0 };
  return {
    calls,
    prisma: {
      shop: {
        findUnique: async () => shopRow,
        update: async ({ data }) => {
          calls.shopUpdate.push(data);
          return { ...shopRow, ...data };
        },
      },
      merchant: {
        findUnique: async () => merchant, // null = dangling
        create: async ({ data }) => {
          calls.merchantCreate += 1;
          return { id: "merchant-new", ...data };
        },
      },
      connectorAccount: {
        upsert: async () => {
          calls.connectorUpsert += 1;
          return {};
        },
      },
    },
  };
}

test("self-heals a dangling merchant instead of 5xx-ing (the review incident)", async () => {
  const { prisma, calls } = mockPrisma({ merchant: null });
  const result = await ensureShopifyTenant(prisma, {
    shopDomain: "app-review.myshopify.com",
  });
  // Did NOT throw + healed with a fresh Merchant, relinked the Shop.
  assert.equal(result.merchant.id, "merchant-new");
  assert.equal(calls.merchantCreate, 1);
  assert.ok(
    calls.shopUpdate.some((d) => d.merchantId === "merchant-new"),
    "relinked shop.merchantId to the fresh merchant",
  );
  assert.equal(calls.connectorUpsert, 1); // downstream still ran
});

test("does NOT heal when the merchant is present (happy path)", async () => {
  const { prisma, calls } = mockPrisma({ merchant: { id: "m1", name: "ok" } });
  const result = await ensureShopifyTenant(prisma, {
    shopDomain: "app-review.myshopify.com",
  });
  assert.equal(result.merchant.id, "m1");
  assert.equal(calls.merchantCreate, 0); // no heal needed
});

test("heals + reactivates an uninstalled shop with a dangling merchant", async () => {
  const { prisma, calls } = mockPrisma({ merchant: null, status: "uninstalled" });
  const result = await ensureShopifyTenant(prisma, {
    shopDomain: "app-review.myshopify.com",
  });
  assert.equal(result.merchant.id, "merchant-new");
  assert.equal(calls.merchantCreate, 1);
  // Both the relink update and the reactivation update fired.
  assert.ok(calls.shopUpdate.some((d) => d.merchantId === "merchant-new"));
  assert.ok(calls.shopUpdate.some((d) => d.status === "active"));
});

test("reactivating an uninstalled shop clears the stale uninstalledAt stamp", async () => {
  const { prisma, calls } = mockPrisma({
    merchant: { id: "m1", name: "ok" },
    status: "uninstalled",
  });
  await ensureShopifyTenant(prisma, {
    shopDomain: "app-review.myshopify.com",
  });
  const reactivation = calls.shopUpdate.find((d) => d.status === "active");
  assert.ok(reactivation, "a reactivation update fired for the uninstalled shop");
  assert.equal(
    reactivation.uninstalledAt,
    null,
    "reactivation clears Shop.uninstalledAt so a reinstalled shop isn't mislabelled as churned",
  );
});
