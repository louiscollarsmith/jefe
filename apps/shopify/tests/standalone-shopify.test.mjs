import assert from "node:assert/strict";
import test from "node:test";
import { ApiVersion } from "@shopify/shopify-api";

import {
  buildStandaloneShopify,
  resolveStandaloneApiVersion,
} from "../app/lib/auth/standalone-shopify.server.js";

test("resolveStandaloneApiVersion maps env, defaults to July26", () => {
  assert.equal(resolveStandaloneApiVersion({ SHOPIFY_API_VERSION: "2026-01" }), ApiVersion.January26);
  assert.equal(resolveStandaloneApiVersion({ SHOPIFY_API_VERSION: "2026-07" }), ApiVersion.July26);
  assert.equal(resolveStandaloneApiVersion({}), ApiVersion.July26);
  assert.equal(resolveStandaloneApiVersion({ SHOPIFY_API_VERSION: "bogus" }), ApiVersion.July26);
});

test("buildStandaloneShopify is scoped to the standalone host and non-embedded", () => {
  const api = buildStandaloneShopify({
    SHOPIFY_API_KEY: "test-key",
    SHOPIFY_API_SECRET: "test-secret",
    SCOPES: "read_products,write_orders",
    SHOPIFY_API_VERSION: "2026-07",
  });
  assert.equal(api.config.hostName, "app.mynamejefe.com");
  assert.equal(api.config.hostScheme, "https");
  assert.equal(api.config.isEmbeddedApp, false);
  assert.equal(typeof api.auth.begin, "function");
  assert.equal(typeof api.auth.callback, "function");
});

test("buildStandaloneShopify honors STANDALONE_APP_HOST override", () => {
  const api = buildStandaloneShopify({
    SHOPIFY_API_KEY: "k",
    SHOPIFY_API_SECRET: "s",
    SCOPES: "read_products",
    STANDALONE_APP_HOST: "staging-app.mynamejefe.com",
  });
  assert.equal(api.config.hostName, "staging-app.mynamejefe.com");
});
