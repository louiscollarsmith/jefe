import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureShopContactEmail,
  getShopContactEmail,
} from "../app/lib/notifications/contact-email.server.js";

// Mock the two shop reads/writes ensureShopContactEmail makes. No DB — the Admin
// GraphQL client is injected as a stub so the network path is exercised without
// contacting Shopify.
function mockShopPrisma(shop) {
  let current = { ...shop };
  const calls = { update: 0 };
  return {
    _shop: () => current,
    _calls: calls,
    shop: {
      findUnique: async () => ({ ...current }),
      update: async ({ data }) => {
        current = { ...current, ...data };
        calls.update += 1;
        return { ...current };
      },
    },
  };
}

function mockClient(shopData) {
  const calls = { request: 0 };
  return {
    _calls: calls,
    request: async () => {
      calls.request += 1;
      return { shop: shopData };
    },
  };
}

test("getShopContactEmail returns the stored address or null", async () => {
  assert.equal(await getShopContactEmail(mockShopPrisma({ contactEmail: "a@b.com" }), { shopId: "s1" }), "a@b.com");
  assert.equal(await getShopContactEmail(mockShopPrisma({ contactEmail: null }), { shopId: "s1" }), null);
});

test("already-set contact email is a no-op (no client call, no write)", async () => {
  const prisma = mockShopPrisma({ contactEmail: "a@b.com", rawPayload: {} });
  const client = mockClient({ contactEmail: "other@x.com" });
  const res = await ensureShopContactEmail(prisma, { shopId: "s1", client });
  assert.equal(res.status, "already_set");
  assert.equal(client._calls.request, 0);
  assert.equal(prisma._calls.update, 0);
});

test("populates from an address already in rawPayload without querying", async () => {
  const prisma = mockShopPrisma({ contactEmail: null, rawPayload: { shopify: { contactEmail: "Maya@Everdew.co.uk" } } });
  const client = mockClient({ contactEmail: "should-not-be-used@x.com" });
  const res = await ensureShopContactEmail(prisma, { shopId: "s1", client });
  assert.equal(res.status, "persisted_from_payload");
  assert.equal(client._calls.request, 0); // cheap path — no query
  assert.equal(prisma._shop().contactEmail, "maya@everdew.co.uk"); // normalized
});

test("queries Shopify when no cached address, and persists contactEmail", async () => {
  const prisma = mockShopPrisma({ contactEmail: null, rawPayload: {} });
  const client = mockClient({ contactEmail: "owner@store.com", email: "fallback@store.com" });
  const res = await ensureShopContactEmail(prisma, { shopId: "s1", client });
  assert.equal(res.status, "persisted");
  assert.equal(client._calls.request, 1);
  assert.equal(prisma._shop().contactEmail, "owner@store.com"); // contactEmail preferred over email
});

test("falls back to shop.email when contactEmail is absent", async () => {
  const prisma = mockShopPrisma({ contactEmail: null, rawPayload: {} });
  const client = mockClient({ contactEmail: null, email: "fallback@store.com" });
  const res = await ensureShopContactEmail(prisma, { shopId: "s1", client });
  assert.equal(res.status, "persisted");
  assert.equal(prisma._shop().contactEmail, "fallback@store.com");
});

test("no address anywhere → no write, honest status", async () => {
  const prisma = mockShopPrisma({ contactEmail: null, rawPayload: {} });
  const client = mockClient({ contactEmail: null, email: null });
  const res = await ensureShopContactEmail(prisma, { shopId: "s1", client });
  assert.equal(res.status, "no_address");
  assert.equal(prisma._calls.update, 0);
});

test("no client and nothing cached → no_client (best-effort, never throws)", async () => {
  const prisma = mockShopPrisma({ contactEmail: null, rawPayload: {} });
  const res = await ensureShopContactEmail(prisma, { shopId: "s1" });
  assert.equal(res.status, "no_client");
  assert.equal(prisma._calls.update, 0);
});
