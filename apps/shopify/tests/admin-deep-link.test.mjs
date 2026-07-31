import assert from "node:assert/strict";
import test from "node:test";
import {
  storeHandle,
  numericId,
  adminDeepLink,
  buildAdminDeepLinker,
} from "../app/lib/shopify/admin-deep-link.server.js";

const gid = (n) => `gid://shopify/Product/${n}`;

test("storeHandle derives the myshopify subdomain", () => {
  assert.equal(storeHandle("everdew.myshopify.com"), "everdew");
  assert.equal(storeHandle("  everdew.myshopify.com  "), "everdew");
  assert.equal(storeHandle(""), null);
  assert.equal(storeHandle(null), null);
});

test("numericId pulls the trailing id from a GID or passes a bare id through", () => {
  assert.equal(numericId("gid://shopify/Product/123"), "123");
  assert.equal(numericId("123"), "123");
  assert.equal(numericId(""), null);
  assert.equal(numericId(null), null);
});

test("adminDeepLink builds unified-admin URLs and degrades to null on unknown handle", () => {
  assert.equal(
    adminDeepLink("everdew.myshopify.com", "products/42"),
    "https://admin.shopify.com/store/everdew/products/42",
  );
  // Leading slash on the path is tolerated.
  assert.equal(
    adminDeepLink("everdew.myshopify.com", "/products"),
    "https://admin.shopify.com/store/everdew/products",
  );
  // No path → the store root.
  assert.equal(adminDeepLink("everdew.myshopify.com"), "https://admin.shopify.com/store/everdew");
  // Unknown handle → null (caller renders label-only rather than a wrong link).
  assert.equal(adminDeepLink("", "products/1"), null);
});

test("buildAdminDeepLinker: product + products convenience", () => {
  const links = buildAdminDeepLinker("everdew.myshopify.com");
  assert.equal(links.product(gid(42)), "https://admin.shopify.com/store/everdew/products/42");
  assert.equal(links.products(), "https://admin.shopify.com/store/everdew/products");
  // No id → falls back to the products index, not a broken URL.
  assert.equal(links.product(null), "https://admin.shopify.com/store/everdew/products");
  const blind = buildAdminDeepLinker("");
  assert.equal(blind.product(gid(1)), null);
  assert.equal(blind.products(), null);
});
