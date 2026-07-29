import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveStandaloneStart,
  managedInstallPath,
  STANDALONE_CALLBACK_PATH,
} from "../app/lib/auth/standalone-auth-flow.server.js";

test("resolveStandaloneStart gates on validity + install record", () => {
  assert.deepEqual(resolveStandaloneStart({ shop: null, isInstalled: false }), {
    action: "invalid",
  });
  // Existing-merchant only: an unknown (uninstalled) shop is sent to install.
  assert.deepEqual(
    resolveStandaloneStart({ shop: "store.myshopify.com", isInstalled: false }),
    { action: "install", shop: "store.myshopify.com" },
  );
  // Known shop proceeds to standalone OAuth.
  assert.deepEqual(
    resolveStandaloneStart({ shop: "store.myshopify.com", isInstalled: true }),
    { action: "begin", shop: "store.myshopify.com" },
  );
});

test("managedInstallPath points at the managed login with the shop", () => {
  assert.equal(
    managedInstallPath("store.myshopify.com"),
    "/auth/login?shop=store.myshopify.com",
  );
  // Encodes anything unusual.
  assert.equal(
    managedInstallPath("a b.myshopify.com"),
    "/auth/login?shop=a%20b.myshopify.com",
  );
});

test("STANDALONE_CALLBACK_PATH is the standalone callback route", () => {
  assert.equal(STANDALONE_CALLBACK_PATH, "/standalone/callback");
});
