import assert from "node:assert/strict";
import test from "node:test";
import { loadFreshOfflineToken } from "../app/lib/shopify/offline-token.server.js";

const SHOP = "test-shop.myshopify.com";

test("returns the (refreshed) offline access token from the resolved session", async () => {
  let sawShop = null;
  const token = await loadFreshOfflineToken(SHOP, {
    unauthenticatedAdmin: async (shop) => {
      sawShop = shop;
      return {
        session: {
          accessToken: "fresh-token",
          expires: new Date(Date.now() + 3600_000),
        },
      };
    },
  });
  assert.equal(token, "fresh-token");
  assert.equal(sawShop, SHOP); // refreshed for the right shop
});

test("throws when the resolved session carries no access token", async () => {
  await assert.rejects(
    () =>
      loadFreshOfflineToken(SHOP, {
        unauthenticatedAdmin: async () => ({ session: { accessToken: null } }),
      }),
    /No offline Shopify session token/,
  );
});

test("throws when there is no offline session at all", async () => {
  await assert.rejects(
    () =>
      loadFreshOfflineToken(SHOP, {
        unauthenticatedAdmin: async () => ({ session: null }),
      }),
    /No offline Shopify session token/,
  );
});

test("propagates a refresh failure (invalid refresh token → reconnect)", async () => {
  const boom = new Error("invalid_subject_token");
  await assert.rejects(
    () =>
      loadFreshOfflineToken(SHOP, {
        unauthenticatedAdmin: async () => {
          throw boom;
        },
      }),
    /invalid_subject_token/,
  );
});
