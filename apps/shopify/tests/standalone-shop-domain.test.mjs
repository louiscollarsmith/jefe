import assert from "node:assert/strict";
import test from "node:test";

import {
  parseShopDomain,
  isValidShopDomain,
  normalizeShopInput,
} from "../app/lib/auth/shop-domain.server.js";

test("parseShopDomain accepts + normalizes canonical myshopify.com hosts", () => {
  // Plain valid host.
  assert.equal(parseShopDomain("northwind-supply.myshopify.com"), "northwind-supply.myshopify.com");
  // Lower-cases.
  assert.equal(parseShopDomain("Northwind-Supply.MyShopify.com"), "northwind-supply.myshopify.com");
  // Strips protocol + trailing slash.
  assert.equal(parseShopDomain("https://store.myshopify.com/"), "store.myshopify.com");
  assert.equal(parseShopDomain("http://store.myshopify.com"), "store.myshopify.com");
  // Surrounding whitespace.
  assert.equal(parseShopDomain("  store.myshopify.com  "), "store.myshopify.com");
  // Digits + hyphens in the label.
  assert.equal(parseShopDomain("my-store-123.myshopify.com"), "my-store-123.myshopify.com");
});

test("parseShopDomain rejects anything that is not a canonical shop domain", () => {
  const rejected = [
    // Wrong TLD / apex.
    "myshopify.com",
    "store.myshopify.io",
    "store.myshopify.net",
    // Custom / attacker domains.
    "evil.com",
    "store.example.com",
    // Look-alikes / suffix + subdomain smuggling.
    "store.myshopify.com.evil.com",
    "sub.store.myshopify.com",
    "store.myshopify.com.",
    // Malformed labels.
    "-store.myshopify.com",
    ".myshopify.com",
    "store..myshopify.com",
    // Path / port / query smuggling (not a bare host).
    "store.myshopify.com/admin",
    "store.myshopify.com:443",
    "store.myshopify.com?foo=bar",
    // Empty / whitespace.
    "",
    "   ",
  ];
  for (const value of rejected) {
    assert.equal(parseShopDomain(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("parseShopDomain is non-throwing for non-string / hostile input", () => {
  for (const value of [null, undefined, 42, {}, [], true, Symbol("x")]) {
    assert.equal(parseShopDomain(value), null);
  }
  // Absurdly long input is rejected, not processed.
  assert.equal(parseShopDomain("a".repeat(300) + ".myshopify.com"), null);
});

test("isValidShopDomain mirrors parseShopDomain as a boolean", () => {
  assert.equal(isValidShopDomain("store.myshopify.com"), true);
  assert.equal(isValidShopDomain("HTTPS://Store.myshopify.com/"), true);
  assert.equal(isValidShopDomain("evil.com"), false);
  assert.equal(isValidShopDomain(""), false);
  assert.equal(isValidShopDomain(null), false);
});

test("normalizeShopInput appends the constant suffix to a bare handle", () => {
  // Bare handle (what the form's prefix input posts) → full domain.
  assert.equal(normalizeShopInput("northwind-supply"), "northwind-supply.myshopify.com");
  assert.equal(normalizeShopInput("My-Store"), "my-store.myshopify.com");
  assert.equal(normalizeShopInput("  store123  "), "store123.myshopify.com");
});

test("normalizeShopInput passes a full domain through unchanged", () => {
  // Someone types/pastes the whole thing → not double-suffixed.
  assert.equal(normalizeShopInput("store.myshopify.com"), "store.myshopify.com");
  assert.equal(normalizeShopInput("https://Store.myshopify.com/"), "store.myshopify.com");
});

test("normalizeShopInput rejects invalid handles + non-myshopify domains", () => {
  const rejected = [
    "", "   ",
    "-store", // bad leading char after suffixing
    "my store", // space
    "store.com", // custom domain (dot, not myshopify)
    "store.myshopify.io", // wrong TLD
    "sub.store.myshopify.com", // extra label
    null, undefined, 42, {},
  ];
  for (const value of rejected) {
    assert.equal(normalizeShopInput(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});
